---
name: aioairctrl-and-device-protocol
description: Domain reference for how this plugin talks to Philips purifiers - the aioairctrl CLI invocation contract (-H/-P/-D, set, -I, status-observe -J), the device status keys (pwr, om, mode, iaql, rhset, fltsts*, D03-xx registers), the three model dialects, and the full HomeKit surface (which services/characteristics exist, their config conditions, and which key feeds each). Load when reading or changing accessories.handler.js, accessories.models.js, or accessories.service.js, interpreting a device status dump, mapping a value to a characteristic, or decoding what a set command actually sends. Not for adding a new model end-to-end (use new-model-support-campaign) or triaging failures (use debugging-and-operations).
---

# aioairctrl and the device protocol

Audience: engineers and AI agents who understand JavaScript but have never seen a
Philips purifier's wire protocol. Everything here is anchored to this repo's code paths;
`aioairctrl` internals are upstream's business.

When NOT to use this skill: adding support for a new model end-to-end is
`new-model-support-campaign`; diagnosing a broken installation is
`debugging-and-operations`.

## The transport in one paragraph

Philips connected purifiers expose an **encrypted CoAP** service on UDP port 5683 (CoAP
= Constrained Application Protocol, an HTTP-like protocol for small devices). The
[`aioairctrl`](https://pypi.org/project/aioairctrl/) Python CLI implements the
encryption and session handshake. This plugin never opens a socket to the device: it
runs `aioairctrl` as a child process and speaks its CLI contract. The plugin therefore
inherits aioairctrl's behaviour, bugs, and Python >= 3.12 requirement (README).

## The CLI contract (as used by this repo)

Built in the `Handler` constructor and methods of
`src/accessories/accessories.handler.js`:

```text
<binary> -H <host> -P <port> [-D] status-observe -J        # long-running: one JSON status object per line on stdout
<binary> -H <host> -P <port> [-D] set [-I] key=value ...   # one-shot state change
```

- `<binary>` is `accessory.context.config.aioairctrlPath` or the literal `aioairctrl`
  resolved from PATH (`this.binary`).
- `-H` host, `-P` port (always passed, stringified), `-D` only when the platform
  `cliDebug` option is on. It is deliberately **not** the plugin's own `debug`: the CLI's
  records were 73 % of a 430 KB/hour log on an AC0850, which is what pushed an overnight
  debug run past `hb-service`'s truncation (issue #63). Confirm base args:
  `node --test --test-name-pattern 'builds the base arguments' test/accessories.handler.test.js`.
- `set` accepts multiple `key=value` pairs in one invocation (used by
  `setPurifierRotationSpeed` for composite speed entries).
- `-I` after `set` is requested per model via `extraSetFlags` (AC0850: every set) and by
  specific numeric commands: `aqil` (light brightness) and `rhset` (humidity target). Per
  `aioairctrl set --help` (`-I, --int`), it encodes the value as an integer instead of a
  string (maintainer-confirmed against the CLI, 2026-07-13). Every `set` is built by
  `Handler.setArgs`, which **drops `-I` when any value in the command is not
  int-encodable**, because the flag applies to the whole invocation: `set -I mode=P` is
  refused outright (issue #42), and a model that needs `-I` for its registers still has keys
  whose values are words. `'true'`/`'false'` survive `-I`, since the CLI converts them to
  booleans before `int()`.
- **A `set` the CLI refuses is not a non-zero exit.** `aioairctrl` prints its complaint on
  **stdout** (`Cannot encode value 'P' as int`), skips the write and exits **0**
  (`cli.py`, confirmed against 0.2.5). A successful `set` prints nothing, so `sendCMD`
  treats any stdout from a `set` as a rejection and rejects the promise with the CLI's own
  text. This is coupled to upstream's output contract: a future version that chattered on a
  successful `set` would make writes look rejected.
- The plugin logs the CLI's **stderr** at debug level and assumes **stdout carries
  only status JSON lines** for `status-observe` — anything else on that stream triggers
  `Failed to parse device response` (see `debugging-and-operations`). stderr is also
  buffered (4 KB cap) so that a process which dies without producing status can be
  reported with the CLI's own error text rather than a bare exit code.

The `status-observe` stream is line-buffered by `handleStdoutChunk` (chunks may split or
merge JSON lines), capped at 1 MB, and each complete line goes to `processUpdate`.

## Measured device behaviour (AC0850/31, 2026-08-17/18)

Everything the polling and command design rests on. All of it was measured on real hardware
over one session; where an earlier version of this file stated a figure unconditionally, the
correction is called out, because generalising from a single condition is what produced the
current `STALL_TIMEOUT` value.

> ⚠️ **Scope: one AC0850/31, one deployment.** Nothing here was measured on an AC1715,
> AC3036 or AC3829, and those run different firmware behind different dialects. Treat the
> **timings** as properties of this device, not of Philips purifiers generally. Each item is
> tagged **[AC0850]** measured only here, **[protocol]** true of the CLI/CoAP layer for every
> model, or **[unverified]** believed protocol-level but observed only on the AC0850.
>
> Design consequence: **do not tune a constant to these numbers.** A value that suits this
> purifier is a magic number on hardware nobody has measured. Prefer an interval the plugin
> chooses, and a user can configure, over one inferred from a single device.

**[AC0850] The device answers on a ~50-60 s cycle.** A one-shot `status` took **58 s**; an observe
subscription was answered after **53 s** (and after 9 s on another attempt). This is not
network latency: ICMP replies in milliseconds throughout, the signature of a combo WiFi
module (`AWS_Philips_AIR_Combo@86`) answering ping in firmware while the application sleeps.
**Never conclude the device is dead from a short timeout.** Allow at least 90 s.

**[AC0850] It pushes spontaneously only while values are changing.** Running, it notified every ~51 s
(from its own `Runtime` counter: 1707733076 → 1707784220 ms), and on a later run every 10-30 s.
Switched **off**, it sent nothing for over 120 s at a stretch, and see the next item for how
much further that goes.

> ⚠️ **Correction.** This file previously stated the ~50 s interval unconditionally, and
> `STALL_TIMEOUT = 120 s` in `accessories.handler.js` was sized from it. That measurement was
> taken while the purifier was **running**. Any timeout must be sized for the **idle** case.
> Fixed for #38: the plugin no longer depends on the device's push cadence at all. It asks for a
> reading `refreshInterval` seconds after the last one (default 60 s, per-device config, `0`
> disables), and `STALL_TIMEOUT` is now 300 s. **That 300 s is itself now known to be too
> short** on a switched-off AC0850 (issue #48), for reasons no larger constant fixes, so the
> stall timer has two regimes: see the off-state item below. Both halves are verified on
> hardware, the refresh on 1.2.0-beta.4 and the two regimes on 1.2.0-beta.5.

**[AC0850] On a stream left alone it pushes every ~9 s; re-subscribing is what costs.** Measured
over a full debug night on **v1.2.1**, 2026-08-19 20:04 to 2026-08-20 13:00, purifier on
throughout (device-reported `pwr=1` from 21:59:39 to 10:55:57), 1165 readings:

| gap from one reading to the next | n   | median    | p90    | max    |
| -------------------------------- | --- | --------- | ------ | ------ |
| subscription left alone          | 991 | **9 s**   | 42 s   | 60 s   |
| after a refresh kill             | 145 | **140 s** | 294 s  | 834 s  |
| after a stall kill               | 28  | **529 s** | 1602 s | 2220 s |

The 60 s ceiling on the first row is `armRefreshTimeout` firing, not the device falling silent, so
**how long a live subscription stays quiet on this model is still unmeasured**: the plugin never
lets one live long enough to find out. What is measured is the cost of teardown. A replacement
subscription waits 140 s at the median to be answered, and the median burst is **3 readings before
the refresh kills the stream**. Every long silence in the night follows a kill, and none occurs on
a stream left untouched, which is the strongest support so far for the orphaned-observer theory
below.

> ⚠️ **Correction.** The ~51 s and 10-30 s cadences above were both sampled while streams were
> being torn down on a timer, so they mix the device's own cadence with re-subscription cost. On an
> untouched stream it is ~9 s. The design consequence runs opposite to what #38 and #44 assumed:
> **the expensive operation on this model is re-subscribing, not waiting**, so a refresh sized
> below the device's quiet period makes HomeKit staler rather than fresher. Tracked as issue #71.

**[AC0850] Switched off, it answers only intermittently, and 25 minute silences are normal.**
Measured 2026-08-18 against 1.2.0-beta.4. Homebridge was stopped so nothing could kill a
subscription and no client competed, the purifier was switched off, then left 10 minutes to
settle (it answers normally for the first ~11 minutes after switch-off, so testing immediately
tests the easy case). A **single uninterrupted** `status-observe` was then held open for 25
minutes and received **nothing at all**. A one-shot `status` immediately afterwards also
returned nothing, hitting its own 300 s timeout. Yet two minutes later, still off, the plugin
got readings, went silent through two more 300 s windows, and answered again:

```text
16:05:43  status-observe starts (single subscription, nothing kills it)
16:30:43  ends after 1500 s        <-- zero notifications
16:30:43  one-shot status -J
16:35:43  hits its own 300 s timeout <-- no output
16:38:03  "pwr":0   <-- plugin gets a reading, 43 min after switch-off
16:41:08  "pwr":0
16:47:13  stall
16:52:18  stall
16:55:05  answers again
```

So off-state responsiveness is **intermittent on a scale of tens of minutes**, not a latency
distribution with a long tail. The consequence for design is the important part: **no polling
timeout value fixes this**, and `STALL_TIMEOUT = 300 s` is not a fault detector on an off
device, it is a restart generator. Silence from a switched-off unit is normal and must not be
treated as a fault.

**[AC0850] Off-state notifications are value-driven, which is what makes the intermittency look
self-contradictory.** Measured 2026-08-27 against 1.3.0-beta.6, purifier off since 23:21:57, the
stream being the plugin's own rather than a hand-held one. Between 01:03:26 and 01:17:29, with no
restart anywhere in the window, readings arrived in **bursts of 1 to 3 spaced 2 to 7 s apart, with
~3 min 25 s between bursts**. Then nothing at all for 56 minutes.

Read alone that looks like a ~3.5 minute cadence, and it appears to contradict the 25 minute
silence above. It is not a cadence. Every reading in the window differs from the one before it, in
the same small set of fields:

```text
01:03:28  pm25 14->13   free_memory
01:03:35  pm25 13->14   free_memory  rssi
01:07:02  pm25 14->16   free_memory  rssi
01:07:05  pm25 16->17   free_memory  rssi
01:10:25  pm25 17->16   free_memory  rssi
01:14:03  pm25 15->14   free_memory
01:14:04  pm25 14->13
01:17:29  pm25 13->12   free_memory  rssi  iaql 2->1
```

`pm25` moves in **all 11 readings**; `rssi` and `free_memory` drift continuously. These are
notifications that a watched value changed, not protocol keepalives, so the gap between bursts is
how long the monitored values happened to sit still. It is not an interval the device is keeping,
and it would not reproduce on a night with different air.

That reconciles the two observations instead of leaving them in conflict. The same device reports
whenever a watched value moves, so a window where `pm25` is drifting produces bursts and a window
where it is settled produces 25 minutes of nothing. Both are the same rule. The 2026-08-18 run has
no field-level data to confirm its silence was value-stable, which is the obvious thing to capture
if it is ever repeated, alongside stderr.

**Two traps this section exists to stop, both of which have already caught someone.**

**Do not size an off-state experiment off the first ten minutes.** The device answers normally for
~11 minutes after switch-off. A 2026-08-27 attempt to reproduce a lost wake-up write used a **6
minute** off period, sat entirely inside that window, and proved nothing about the failing state.
Clear the window before the experiment starts, and confirm it from the log rather than the clock.

**Do not corroborate an off-state number with an on-state one.** The 9 s left-alone median in the
table above was measured with the purifier **on**. Reading agreement between it and the 2 to 7 s
within-burst gaps here would cross the single variable the whole off-state regime exists because
of. This skill's own history is a run of design errors from exactly that move: #38's
`STALL_TIMEOUT = 120 s` came from a measurement taken while the purifier was running, and #48 had
to replace one constant with two regimes to undo it.

Fixed for #48 by making the stall timer state-dependent rather than by choosing a different
constant, which the 2026-08-18 experiment rules out. `armStallTimeout` picks its timeout from
`deviceKnownOff()` at arm time: 300 s when the device is on or has never answered, 30 minutes
(`OFF_STALL_TIMEOUT`) when the last status said `pwr` is 0. The long one is a backstop against
a subscription that died unseen, not a poll, so a stall in that regime restarts the stream
without counting as a poll failure or reporting one, the same treatment a refresh teardown
already gets. `deviceKnownOff()` reads `this.obj.pwr`, **not** `receivedData`: the latter is
cleared by every `longPoll`, and an off-state stall is by definition judged on a stream that
has itself answered nothing. An empty `this.obj` is what makes a device that has never answered
report normally.

**Verified on hardware 2026-08-18/19 (1.2.0-beta.5), both regimes and the boundary between
them.** The purifier was switched off for ~50 minutes: **zero stall warnings and zero failure
reports**, where 1.2.0-beta.4 had produced one every 5 minutes in the same state. The regime
switch is visible directly rather than inferred, and the cold-start case is the one worth
keeping, because it is the one where "off" and "unreachable" are indistinguishable:

```text
21:12:28  set -I D03102=0, device reports "pwr":0 the same second
21:45:18  refresh; device then silent
21:54:50  answers, 9 min 32 s later   <-- 300 s regime would have stalled at 21:50:18
21:28:29  Homebridge restarted while the device was off, so this.obj is empty
21:33:29  warns at exactly 300 s      <-- correct: a device that has never answered
21:37:02  "Device is responding again"
```

The debug line for an off-state stall carries a `while the device is off` suffix and the
cold-start one does not, which is the quickest way to tell from a log which regime was in force.
Two paths were **not** reachable on hardware: the escalation brake (a second consecutive stall
logging at debug rather than warning again) never got its chance, because the device answered
inside the next 300 s window; and #33's parse brake and failed-stop path cannot be triggered by
a real AC0850, which emits no malformed lines and no unkillable process. Both are unit-tested.

**That is the third time a timer has destroyed a subscription that was going to be answered**
(the pre-#30 fixed process lifetime, #38's write-triggered refresh, #48's stall). Standing rule:
**never tear down a subscription on a timer unless something independent of that timer says the
device is at fault.** The refresh is legitimate because it is armed from a _reading_; the
off-state regime is legitimate because power state is independent evidence.

Two caveats on that experiment, both honest limitations of how it was run. Stderr was
suppressed, so it is **unknown whether the `sync` POST succeeded during the silent 25
minutes**; it demonstrably did during an equivalent silence earlier the same day (`4F43D908`,
`0FA49D7A`), so the device was reachable then, but this was not re-verified. And every failure
window in both runs began **after a CoAP client was killed**, which keeps an orphaned-observer
explanation alive (see the single-connection item below) without coming close to proving it.
**If repeating this, keep stderr.**

**The off-state regime held for warnings but not for teardowns, and only a multi-night soak
showed it.** Found 2026-08-25 in 4.5 days of 1.3.0-beta.3 on the same AC0850: **zero** user-visible
warnings across the whole run, exactly as #48 intended, but **472 off-state teardowns over three
nights**, arriving every **305 s** rather than every 30 minutes. `stallDelay` measured `elapsed`
from `lastReadingAt` alone, so once the first off-state stall had fired the deadline was
permanently past, `timeout - elapsed` went negative, and every later arm fell through to the
`grace` floor, which is `refreshDelay()` pinned at its 300 s ceiling. The silence figures in the
debug line make it unmistakable, climbing in exact 305 s steps from the correct first fire:

```text
21/08 10:18:22  No status received for 1800s while the device is off, restarting the polling process
21/08 10:23:27  No status received for 2105s while the device is off, ...
21/08 10:28:32  No status received for 2410s while the device is off, ...
```

Two things hid it. `stalledWhileOff` correctly suppresses the failure report, so the churn was
silent apart from a `aioairctrl` spawn every 5 minutes all night. And the ~50 minute hardware
window above is too short: it contains the first fire and at most one repeat, so it verified the
regime and not its cadence. **An off-state observation has to span hours to say anything about
teardown rate.** Fixed by running the clock from the later of the last reading and the last
teardown (`lastStallAt`), so the floor still covers the case it was written for, a deadline
overrun by a slow refresh replacement, without becoming the cadence itself. The same bug made the
on-state regime tear down at `refreshDelay()` rather than 300 s once a device had gone quiet.

**[AC0850] A fresh subscription elicits a reading.** This is why the pre-#30 fixed 60 s process
lifetime accidentally worked as a ~65 s poll loop, and why raising `STALL_TIMEOUT` alone
makes idle staleness worse rather than better. The deliberate periodic refresh in
`armRefreshTimeout` is the fix, and the 60 s default is that accidental v1.1.0 behaviour made
explicit rather than a number derived from these measurements. Since #71 it is only the **floor**:
the elicited reading is not free, so `adaptRefresh` keeps a smoothed average of what refreshes
have actually cost on this device and waits that long, held between the configured interval and
`STALL_TIMEOUT`. The trade is made per device rather than per constant.

**A controller comparing each cost against its own current wait cannot settle on this hardware.**
`adaptRefresh` first doubled and halved a multiplier: back off above the current wait, come down
at or below half of it. A fixed point needs the cost distribution to fall inside that deadband,
one octave wide, and the AC0850's is bimodal rather than a tight distribution (88 change-triggering
samples spanned 6 s to 1725 s, median 97 s). Measured over 4.5 days of 1.3.0-beta.3: **88 changes,
a median 19 minutes apart, never at rest while the device was active.**

```text
  23  60 -> 120     43 of the 88 are this one pair
  20  120 -> 60
  12  300 -> 150    a second ladder, because maxFactor is 5 and not a power of two
  10  150 -> 300
```

Half the oscillation sat at the 60 s floor, which is the eagerness #71 exists to rule out. Fixed
by averaging the cost and setting the wait to it, which removes the deadband: a bimodal signal then
produces one wait between its modes instead of a flip across them. Replaying the same 10 s/200 s
alternation through both rules, the multiplier locks into 60/120 forever while the average settles
into 158-179 s, a band of ±6 % instead of a full octave. **It settles into a band, not onto a
point** — the input keeps moving — and the rise weight is deliberately four times the fall weight,
so it errs high, toward leaving a working stream alone.

**The refresh timer is armed only from `processUpdate`, never from `longPoll`,** and any change
to it must keep that property: the interval then measures the time since a _reading_, so a
subscription that has not been answered yet is never killed. On a device slower than the
interval this degrades into waiting, not into starvation.

**[protocol] Writes are fire and forget: `exit 0` means transmitted, not applied.** `set` returned in
**0 s** with exit 0 over unacknowledged (`NON`) CoAP. A packet lost, or arriving while the
device dozes, disappears with no error anywhere, and the `set*` handlers have already pushed
the optimistic value to HomeKit. A confirmed real-world case: an automation logged
`Purifier Active: 1` with no error and the device stayed off. Tracked in issue #37.
**Confirm a write by reading the key back, never by trusting the log.** At a terminal that means
reading `D03102`; in the plugin, `recordWrite` registers each write and `reconcilePendingWrites`
checks it against the next status the observe stream delivers, resending once before warning.
A separate `status` process is not an option for the read-back, because of the single-connection
behaviour below. Verification therefore **rides the refresh the stream is doing anyway**: an
earlier design killed the subscription on the write's own schedule and measurably threw away the
notification it was waiting for (the device answered a `set` 83 s later; the refresh fired at
30 s), then paid a fresh subscription's latency to ask again.

**[AC0850] A write that lands is echoed immediately by a `"StatusType":"control"` push, but the
83 s figure above is also real.** Measured 2026-08-18: `set -I D03102=0` at 21:12:28 produced a
status **within the same second**, carrying the new value and `"StatusType":"control"` where
every periodic push says `"status"`. That is the device acknowledging a control action, and it
is three orders of magnitude faster than the 83 s a beta.3 write waited for. Seven further writes
on v1.2.1 over the night of 2026-08-19 were all echoed **within 1 s**, so the immediate echo is
the common case rather than the exception. **Do not replace
one number with the other**: write-to-notification latency on this model spans at least
0-83 s, which is exactly why verification must ride the stream rather than run on a schedule
sized from any single measurement. The `control` marker is a usable signal if a future change
wants one, since it distinguishes an answer to a write from a periodic push.

Three rules keep that verification portable to models nobody has measured, and any change to it
must preserve them: **only a status that arrived after the write is evidence about it**, **only a
status that mentions the key is evidence about that key** (issue #41: treating an unreported key
as a disagreement reported writes that were never lost, and on the AC0850 `mode` and `cl` are
exactly that), and **only a disagreement is evidence that it was lost.** A verification window
passing in silence means this device answers more slowly than the refresh cycle assumes, which is
a freshness problem, so it stays at debug rather than warning.

**[unverified] The device serves one connection at a time.** A second `aioairctrl` against the same
purifier does not error: it completes the sync handshake and then simply receives nothing.
So "hangs and exits 0 with no output" is the signature of a _competing client_, not a broken
install. Stop Homebridge before running a manual `status`/`status-observe`, and allow at
least 90 s before concluding the device is silent.

**Verifying a polling change on hardware.** The discriminator is PID stability, and it is
only meaningful **with the purifier switched on**, since an idle device legitimately triggers
the stall timer:

```bash
for i in $(seq 1 8); do sleep 60; ps -eo pid,etimes,args | grep '[a]ioairctrl'; done
```

One PID for the whole window means the idle timer is working (verified for #30 on 2026-08-18:
one PID across 8 minutes, zero warnings). A PID changing every ~125 s means the stream is
being torn down. Checking that the process _runs_ proves nothing; only a status line arriving
proves data moves.

**[deployment] Not the network.** Ruled out on this deployment: the host reaches the purifier over
**ethernet**, and the traffic is **unicast** UDP, so neither the host's WiFi power save nor
the router's IGMP snooping is on the path. IGMP snooping only affects multicast, which is why
it can break mDNS/`.local` while leaving this untouched.

## The generic status vocabulary

The handler works internally with **generic keys**; model dialects are translated to
these on the way in (`handleResponse`) and from these on the way out (`handleCommand`).
Meanings below are as this repo uses them, verified against
`processUpdate`/`set*` methods in `accessories.handler.js`:

| Generic key     | Meaning in this repo                        | Values seen in code/tests                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pwr`           | Power                                       | `'1'`/`'0'` (AC1715 device-side: `'ON'`/`'OFF'`, value-mapped)                                                                                                                                                                                                                                                                                            |
| `mode`          | Operating mode                              | Through `modeMaps` only. Default map and AC3829: `'P'` Auto, `'A'` allergen (sent for Auto with `allergicFunc`), `'M'` Manual. AC3036: `'AG'` Auto. AC1715 (`D03-12`): `'Auto General'` Auto. Read path: the `modeMaps.auto` or `modeMaps.allergen` value → HomeKit AUTO, with or without `allergicFunc`; no mode reported → AUTO; any other value MANUAL |
| `om`            | Fan speed register (default dialect)        | `'s'` (sleep), `'1'`, `'2'`, `'t'` (turbo)                                                                                                                                                                                                                                                                                                                |
| `cl`            | Child lock                                  | boolean; on the dash-less models `D03103` as `1`/`0`, via `valueMaps.cl`                                                                                                                                                                                                                                                                                  |
| `aqil`          | Display/light brightness                    | 0–100 (set with `-I`)                                                                                                                                                                                                                                                                                                                                     |
| `uil`           | Buttons/UI light                            | `'1'`/`'0'`; on the AC1715, `D03-05` as `100`/`0` (set with `-I`, via `valueMaps.uil`); dash-less: see Imported models below                                                                                                                                                                                                                              |
| `func`          | Function (humidifier-capable models)        | `'P'` purification, `'PH'` purification + humidification                                                                                                                                                                                                                                                                                                  |
| `rhset`         | Target humidity                             | 40/50/60/70, mapped to HomeKit threshold 25/50/75/100                                                                                                                                                                                                                                                                                                     |
| `wl`            | Water level                                 | 0 (empty) or 100 in the code's branches                                                                                                                                                                                                                                                                                                                   |
| `iaql`          | Indoor allergen index                       | HomeKit AirQuality = `ceil(iaql / 3)` clamped 0–5                                                                                                                                                                                                                                                                                                         |
| `pm25`          | PM2.5 density                               | clamped 0–1000                                                                                                                                                                                                                                                                                                                                            |
| `rh` / `temp`   | Humidity % / temperature °C                 | clamped 0–100 / −270–100                                                                                                                                                                                                                                                                                                                                  |
| `fltsts0/1/2`   | Filter hours remaining: pre / HEPA / carbon | 0 = "change now"; life% = `fltsts / flttotal`                                                                                                                                                                                                                                                                                                             |
| `flttotal0/1/2` | Filter total hours                          | fallbacks when absent: 360 / 4800 / 4800                                                                                                                                                                                                                                                                                                                  |
| `wicksts`       | Wick filter hours remaining                 | life% = `wicksts / 4800`                                                                                                                                                                                                                                                                                                                                  |

A key missing from a status line is normal — devices only report what they have; the
filter blocks in `processUpdate` skip on `undefined` (regression fixed in commit
6f81c9a).

## The three model dialects

Defined in `src/accessories/accessories.models.js` (pure data; see
`architecture-and-invariants` for why):

1. **Default / legacy** (anything unlisted): generic keys are the wire keys.
   Speeds are `om`-based: `['1','2','t']`, with `'s'` prepended when the device config
   sets `sleepSpeed`. Auto is `mode=P` (`A` with `allergicFunc`) and Manual `mode=M`, both
   from the default `modeMaps`. AC3036 is a variant: no key maps, four `mode`/`om` composite
   speed steps (`S`, `M`+`om` 1, `M`+`om` 2, `T`), and Auto `mode=AG` on the selector (`P`
   is not an AC303x mode; ruaan-deysel/ha-philips-airpurifier). AC3829 is another: five
   composite steps (`S`+`om` s, then `M`+`om` 1, 2, 3, t; the ladder is from ruaan-deysel's
   ha-philips-airpurifier, with its sleep step built in, so `sleepSpeed` does nothing), and
   Auto `mode=P` (`A` with `allergicFunc`) on the selector, so Sleep reads as manual.
2. **AC1715-style**: wire keys are dashed registers (`pwr` → `D03-02`), values are
   words (`'ON'`, `'Auto General'`); `valueMaps.pwr` translates both directions. Speeds
   are `mode`-word steps (`Sleep`, `Gentle/Speed 1`, `Speed 2`, `Turbo`), and Auto is
   `modeMaps.auto` `{ mode: 'Auto General' }`, written as `D03-12=Auto General` because
   `handleCommand` maps the generic `mode` key like any other. It used to write `D03-12=P`/`M`,
   which that register does not take. The AC0850 also has a dashed variant (below).
3. **AC0850-style**: wire keys are dash-less registers (`pwr` → `D03102`), values are
   numeric, every `set` asks for `-I` (`extraSetFlags`). Speeds are composite register
   pairs (`{ D0310A: 2, D0310C: 17|18 }`, Sleep and Turbo). `D0310C` is mode and speed in
   one register (0 Auto, 17 Sleep, 18 Turbo), so Auto is not a speed: `modeMaps` puts
   it on `TargetAirPurifierState` instead (below). The exact model ID in config is
   **required** for this dialect (docs/controls.md note 1). It no longer has to be typed
   perfectly: `resolveModel` normalises case, spacing and the `/NN` regional
   suffix printed on the device, and falls back to a model ID left in the device
   name. Failing all that, `identifyModel` reads the model out of the status
   itself on the first reading and adopts it from the next restart
   (`Handler.checkModelMapping`). The AC1715 also has a dash-less variant (below).

   > ⚠️ **Correction, 2026-08-19.** This file previously said the AC0850 reports
   > no name, type or model field of any kind. That came from the dump on issue
   > #46, which was **partial**. A full untranslated status from an AC0850/31 on
   > firmware `0.1.3` reports the model directly:
   >
   > ```json
   > {"D01102":5,"D01S03":"Bedroom","D01S04":"Pluto","D01S05":"AC0850/31",
   >  "D01S12":"0.1.3","ProductId":"89be7eb8...","DeviceId":"82487fb3...",
   >  "Runtime":1948236132,"rssi":-42,"WifiVersion":"AWS_Philips_AIR_Combo@86",
   >  "StatusType":"status","ConnectType":"Online","D0310A":2,"D0310C":0, ...}
   > ```
   >
   > So `D01S05` is the model, `D01S12` the firmware, and **`D01S03`/`D01S04`
   > are owner-settable names** from the Philips app. That last point is why
   > `identifyModel` reads an allowlist of model-bearing fields rather than
   > scanning every string value: a device its owner named `AC1715` in the app
   > would otherwise identify as one. Issue #46's candidate set for `mode`/`cl`
   > is also narrower than that dump suggested, since several of its unknowns
   > are now named. It also lists `mode` and `cl` as
   > `unsupported`: no register for either appears in its status dumps or its key maps, so
   > the plugin never sends `mode=`/`cl=` and exposes no child lock. Auto/manual is still
   > exposed, through `modeMaps`, because Auto lives in `D0310C`. Believed, not proven —
   > issue #46 carries the status-diff experiment that settles it.
   > A **baseline register inventory** is now attached to that issue: 89 status payloads from
   > one unit on firmware `0.1.3`, off versus on, showing the complete set of 27 registers it
   > reports. That closes the candidate list for `mode`/`cl` to the 16 unmapped constants. It
   > **identifies neither key**, because the unit never changed mode or lock state during the
   > capture, so anything encoding them would read as constant. The experiment still needs
   > someone at the physical unit. That capture also showed `D0310D` apparently tracking
   > power, but only because the air was clean: a later eight-day capture showed it is the
   > fan level (see `fanLevel` below), which removes it from the `mode`/`cl` candidates.

**Imported models.** 35 entries after these four were imported in bulk from
ruaan-deysel/ha-philips-airpurifier, with corrections from ruaan-deysel/homebridge-philips-airctrl
(`THIRD_PARTY_NOTICES.md`), and none is validated here. They fall into the same three
dialects:

- **Legacy** (20: AC1214, AC2729, AC2889, AC29xx, AC3033/AC3039, AC305x, AC3259, AC3836,
  AC3854/AC3858, AC4236, AC4550/AC4558, AC5659/AC5660): no key maps, a `mode`/`om` ladder
  and Auto `P` (with allergen `A`) or `AG` on the selector, like the AC3829 and AC3036.
  The AC3836 writes and reads Auto as `AG` with `om` `'1'`, and the AC4550/AC4558 as `AG`
  (allergen `A`) with `om` `'a'`, their manual speeds being `om` alone.
- **Dashed** (AC0650): the AC1715 shape cut down to `Sleep`/`Turbo`, with no light, lock or
  pre-filter registers.
- **Dash-less** (14: AC0950/AC0951, AC22xx, AC32xx, AC3420/AC3421, AC3737, AC4220/AC4221,
  AMF765): the AC0850 shape plus `cl` → `D03103` (1/0 through `valueMaps.cl`), `rh` →
  `D03125` and the pre-filter `D0520D`/`D05207`. `D0310C` is mode and speed, Auto is
  `D0310C` 0, and the AC3737 alone pairs it with `D0310A`. The light maps both `aqil` and
  `uil` onto one register so the two writes agree: the lamp mode `D03135` (on/off; the
  `D03105` backlight is read-only on an AC4220/12), or `D0312D` on the AMF765. `temp` is
  not mapped, because `D03224` reports tenths of a degree and a value map cannot scale it,
  and the humidifier models (AC3420/AC3421, AC3737) mark `func` unsupported, since it has
  no dash-less counterpart: the service needs `func`, so the `humidifier` option is ignored
  there with a startup warning, and their `D03128` target register is left unmapped.

**AC0651.** One more dash-less entry comes from a different source, the cloud plugin
Micheledipaola/homebridge-philips-airplus (MIT, `THIRD_PARTY_NOTICES.md`), whose data was
read over the Philips cloud (MQTT) rather than local CoAP. It is the AC0850 shape with a
Medium step (`D0310C` 17, 1, 18; Auto 0, no `D0310A`) and the pre-filter pair, and like the
AC0850 it marks `mode` and `cl` unsupported and has no light. Power is `D03102`, not the
`D0310D` the cloud plugin names, because on the AC0850 `D03102` is power and `D0310D` is the
fan's actual level (`fanLevel` below). It sits right after the AC0850 in `models` so that `identifyModel`, which gives
a tie to the first entry, picks it over the imported dash-less models on an AC0651 status.

A fourth field, **`unsupported`**, is a per-model list of generic keys the device has no
register for at all. `Handler.supports(key)` reads it, and it gates three things: the `set*`
method, the optimistic push, and the characteristic in `accessories.service.js`. Adding a key
here removes a control from users' Home apps, so it belongs on observed absence from a status
dump, never on a mapping that merely has not been worked out yet.
`func` on the AC3420/AC3421/AC3737 is listed on the imported sources' evidence instead (none
names a dash-less counterpart), and there it gates the whole humidifier service, both
humidifier setters, and a startup warning that the `humidifier` option does nothing.

A fifth field, **`modeMaps`**, is every model's auto/manual concept, and the only mechanism
behind `TargetAirPurifierState`: there is no separate legacy `mode === 'M'` path. Its entries,
in generic key space like everything else (so `keyMaps`/`valueMaps` apply on the way out and
back), are:

- `auto`: the register values that mean Auto. Never one of the `speeds`, so Auto is on the
  selector and not the slider (AC0850 `{ D0310A: 2, D0310C: 0 }`, AC1715
  `{ mode: 'Auto General' }`, AC3036 `{ mode: 'AG' }`, default `{ mode: 'P' }`).
- `manual`: optional registers Manual writes. Without it, Manual restores the last of the
  `speeds` the device was in or was sent (`Handler.lastManualSpeed`, the first step until one
  is known). Only the default map has one, `{ mode: 'M' }`, because its speeds write `om`
  alone and nothing confirms `om` takes an unknown model out of Auto.
- `allergen`: a plain allergen mode, also automatic. The default map (`{ mode: 'A' }`),
  the AC3829, the imported P/A models and the AC4550/AC4558 (`A` with `om` `'a'`) have one;
  on any other model `allergicFunc` is ignored with a startup warning
  (`hasAllergenMode`, `accessories.setup.js`). The option only changes what Auto sends
  (`modelConfig(...).autoWrite`, `Handler.autoWrite`); `modeMaps` stays whole.

A sixth field, **`alsoAuto`**, sits beside `modeMaps` rather than in it: a read-only list of
further automatic states a device can be put in from its panel or the Philips app. They read
as Auto (`Handler.autoStates()`), and are never written, offered, or sent by Auto. The
imported presets with no place on the selector go here: pollution `P` and gas `F` with `om`
`'a'` on the AC4550/AC4558, and bacteria `B` on the AC2889, AC3259, AC5659 and AC5660.
Without it a device left in one read as Manual at 0%, which a captured scene replays as off.

A seventh field, **`fanLevel`**, is optional, for a model that reports the fan's actual level
in a register of its own. `key` names that register (a wire register: `handleResponse` passes
unmapped keys through), and `steps` are the slider's steps, slowest first, each a `level` it
reads and a `write` it sends: one of the `speeds` (a manual step) or `'auto'` (Auto, as the
selector sends it). With it, `speedsMinStep` is `100 / steps.length`; `rotationSpeed()` shows
the level in every mode (`fanLevelPercent`: 0 when off or at level 0, else the matched step),
and falls back to the speeds when the level is unreported or not one of the steps; and
`setPurifierRotationSpeed` rounds to the **nearest** step (`fanLevelWrite`, never below the
first step for a value above 0). An `'auto'` step takes the same path as Auto on the switch
(`setPurifierTargetState(1)`), so it never yields, and a Manual restore it displaces puts
the switch back to AUTO; an identical Auto from the switch in the same scene is sent once. A
manual step yields to Auto and sets MANUAL like any speed. Manual on the switch still
restores the last of the `speeds`, shown at its step (`speedPercent`).

Only the dash-less AC0850 has one, and only because its levels were observed: `D0310D` is its fan's
actual level. Evidence from the maintainer's AC0850/31 (45,505 statuses, plus a manual Turbo
capture on 2026-10-22; issue #46): off 0; Sleep (`D0310C` 17) always 1; manual Turbo
(`D0310C` 18) 18; Auto (`D0310C` 0) 1, 2, 3 or 18, following the allergen index in bands
1-3, 4-6, 7-9 and 10-12. Levels 2 and 3 occur only in Auto, so its slider is 25% Sleep, 50%
and 75% Auto, 100% Turbo. Nearest rounding keeps 1.3.1's 33/67/100% scenes on Sleep, Auto and
Turbo; 1.4.0's 50% Sleep now selects Auto. Other dash-less models may well report `D0310D`
too, but their levels are unknown, so they keep the existing approach until they are observed.

**Two dialects under one model ID: `dialect` and `dialects`.** Some models ship both register
dialects, depending on the Wi-Fi firmware, so the model ID alone does not say which mapping a
device needs. ruaan-deysel/ha-philips-airpurifier keys this off `WifiVersion`: AC0850 units on
`AWS_Philips_AIR` firmware speak dashed registers (`D03-02`, words on `D03-12`), units on
`AWS_Philips_AIR_Combo` and the AC0850/81 dash-less ones. Its per-suffix table does not hold
here, though: it files the AC0850/31 as dashed, and the validated AC0850/31 is on
`AWS_Philips_AIR_Combo@86` and dash-less. So the plugin trusts the key shape it observes, not
the suffix or the firmware string. The AC1715 is the mirror image: validated dashed, while
Micheledipaola/homebridge-philips-airplus defines AC1715/70 and AC1715/11 dash-less.

Such an entry names the dialect its plain fields are written in as `dialect` (`'dashed'` or
`'dashless'`), and carries the other in `dialects`, a map from dialect name to an ordinary entry
that **replaces** the plain fields whole (nothing merges, so `extraSetFlags: ['-I']` or an
`unsupported` list cannot leak across). A plain entry has neither and is untouched by all of this:
`modelConfig` returns it unchanged whatever dialect it is asked for, with `dialect` undefined and
`dialects` empty. The plain fields are also what `identifyModel` fingerprints against, so adding
a variant never changes which model a status fingerprints as.

The flow mirrors model detection (`Handler.checkModelMapping` → `Handler.checkDialect`):
`detectDialect` reads the first substantial status (dashed keys `/^D\d{2}-\d{2,3}$/` versus
dash-less `/^D\d{2}[0-9A-F]{3}$/`; a status with both or neither names none). When the configured
model has a variant for that dialect and it is not the one in force, it is recorded as
`accessory.context.detectedDialect = { model, dialect }`, flushed with `updatePlatformAccessories`,
warned about once, and applied by the constructor on the next start (the slider steps and
`unsupported` shape the services built at startup, so it cannot switch mid-run). A firmware update
that flips it back is caught the same way. A device naming another model (`certainty: 'reported'`)
is handled as a model mismatch first, and its dialect is judged against the model it names, not
the configured one (`Handler.recordDialectFor`): a non-default variant is recorded with
`detectedModel` before the one flush, so a single restart adopts both. Short of a named model, a
status in the model's other dialect is not treated as a wrong model, though it fingerprints as one
(a dashed AC0850 looks like an AC1715). The constructor adopts a detected model first, then applies
the recorded dialect only if its `model` is the model now in force, so a dialect never follows a
config edit or a later detection onto a different model. The debug log carries
what the status says about the device (`deviceDetails`: model as printed from `D01S05` or the
dashed `D01-05`, its regional suffix, and `WifiVersion`), for diagnostics only: none of it touches
an accessory's UUID or the meaning of the config.

The two variants, both **unvalidated**:

- **AC0850 dashed** (ruaan-deysel, Apache-2.0, `device_models.py` gen2 config and `const.py`):
  `pwr` → `D03-02` as `ON`/`OFF`; `mode` → `D03-12`, speeds `Sleep`, `Turbo`, `modeMaps.auto`
  `Auto General`; `iaql` `D03-32`; `pm25` `D03-33`; `fltsts1`/`flttotal1` `D05-14`/`D05-08` (ruaan
  lists the `D05-13` pre-filter as unavailable); no set flags; `cl` unsupported (ruaan exposes no
  lock for the family).
- **AC1715 dash-less** (homebridge-philips-airplus `models.yaml`, MIT, plus ruaan's gen3
  vocabulary): `D0310C` speeds 17 Sleep, 1 Medium, 2 Fast, 18 Turbo, `modeMaps.auto` `D0310C` 0;
  `pwr` `D03102` (ruaan's `NEW2_POWER`; airplus names `D0310D`, which on the AC0850 only follows
  power); `iaql` `D03120`; `pm25` `D03221`; filters `D0520D`/`D05207` (pre) and `D0540E`/`D05408`;
  `-I`; `mode` and `cl` unsupported. No `D0310A`, since neither source writes it for this model.

A variant replaces `fanLevel` too, so the dashed AC0850 has none: its firmware has no `D0310D`,
and its slider is its own two `speeds`, 50% Sleep and 100% Turbo (`speedsMinStep` 50), while the
dash-less AC0850 keeps the four fan-level steps. The AC1715 has four steps in both dialects.
docs/controls.md gives each dialect of such a model its own slider row, named like
`AC0850 (dash-less)`, and `test/docs.test.js` counts each row against that variant's
`fanLevel.steps` or `speeds`.
`test/accessories.models.test.js` guards that every variant's registers have the shape of the
dialect it is filed under, and the data-driven round trip covers each variant with it in force.

The default map's entries live in `DEFAULT_MODE_MAPS`, applied to any unmapped model.
`Handler.inAutoMode()` is true when a status matches `auto`, `allergen` or an `alsoAuto`
state (whichever the option sends, since the panel or the Philips app can start any), and also before any of
their registers has been reported. A status that omits those registers confirms nothing:
`rotationSpeed()` still reads the speed it reports, and hides it behind the last manual step
only in a confirmed automatic mode (`Handler.confirmedAuto()`). `Handler.supportsMode()` is true for a model with `modeMaps`,
and gates everything that means "has an auto/manual concept"; `supports('mode')` keeps
meaning the register itself. Because Auto and the speeds can share registers, a scene that
writes both in one coalescing window is resolved by `queueWrite`'s `yielding` levels: Auto
wins over a speed, and a speed wins over Manual's restore (the same levels let a real power
write win over RotationSpeed 0's implied power-off). After that, a power-on to a device
whose last status reports it on is left out of the batch (`dropRedundantPowerOn`), and out
of any resend (`withoutRedundantPowerOn`); a power-on alone is then not sent at all. Any other
power write is never merged: it goes as its own `set`, after the rest of the batch, because an
AC0850 ignores every register merged with a power-on, whether it was off or already on (#117).
Sent apart, it applied them in either order (live test 2026-10-24: Sleep written while off held
through the power-on). The fields are listed in the header of
`accessories.models.js`, and `test/docs.test.js` fails if a model uses one that header and this
section do not name.

Translation mechanics in `accessories.handler.js`:

- Inbound (`handleResponse`): for each `keyMaps` entry, copy `obj[mappedKey]` to the
  generic key (through `valueMaps[key]` if present) and delete the wire key. Unmapped
  keys pass through untouched.
- Outbound (`handleCommand`): **value is translated first (value maps are keyed by the
  generic key), then the key** — reversing this order is a historical bug (commit
  bf691b0). Returns a single `key=value` argv element; no quoting, ever (see
  `architecture-and-invariants`).

## Speed model → HomeKit RotationSpeed

`speeds` is an ordered array, slowest first. Each entry is a set of key/value conditions
that must ALL match the current status (stringified equality) in
`Handler.rotationSpeed`. HomeKit percentage = `(index + 1) * (100 / speeds.length)`;
`speedsMinStep` gives the slider step. A model with `fanLevel` (above) replaces both
directions with its level steps and rounds writes to the nearest one. Writing a speed reverses this: `Math.ceil(value /
minStep)` picks the entry and every pair in it is sent as a `set` command, and 0% is a power-off
(#118). In Auto the slider reads the last manual step instead of matching at all, on every
model: 0% would mean off, so a scene captured in Auto would replay as off, and a speed the
device reports in Auto (the default map's `om`) is Auto's choice, so it neither shows nor
becomes the manual step. Outside Auto, a status that matches no entry yields RotationSpeed 0.

## The HomeKit surface (services and characteristics)

The other end of the translation: which HomeKit services the plugin exposes and which
generic key feeds each characteristic. Services are wired in
`src/accessories/accessories.service.js` (conditional ones are added when the device
config enables the option and removed otherwise); values are pushed from
`processUpdate` and the `set*` methods in `accessories.handler.js`.

| Service                                      | Condition         | Key characteristics (source key → HAP)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessoryInformation`                       | always            | Manufacturer/Model/SerialNumber from config; FirmwareRevision = package version (`src/platform.js`)                                                                                                                                                                                                                                                                                                                                                           |
| `AirPurifier`                                | always            | `Active` (`pwr`), `CurrentAirPurifierState` (`pwr`→0/2), `TargetAirPurifierState` (`Handler.inAutoMode()`: the `modeMaps.auto` or `modeMaps.allergen` registers, AUTO while no mode is reported; pinned to `validValues: [AUTO]` when `supportsMode()` is false, since HAP requires the characteristic), `LockPhysicalControls` (`cl`; not added at all, and removed from a cached accessory, when `cl` is `unsupported`), `RotationSpeed` (previous section) |
| `AirQualitySensor`                           | always            | `AirQuality` (`iaql`, clamped `ceil(iaql/3)`), `PM2_5Density` (`pm25`)                                                                                                                                                                                                                                                                                                                                                                                        |
| `FilterMaintenance` ("Pre Filter")           | `preFilter`       | `FilterChangeIndication` (`fltsts0 == 0`), `FilterLifeLevel` (`fltsts0`)                                                                                                                                                                                                                                                                                                                                                                                      |
| `FilterMaintenance` ("Active carbon filter") | `carbonFilter`    | same, from `fltsts2`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `FilterMaintenance` ("HEPA filter")          | `hepaFilter`      | same, from `fltsts1`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `FilterMaintenance` ("Wick filter")          | with `humidifier` | same, from `wicksts`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `HumidifierDehumidifier`                     | `humidifier`      | `Active`, `CurrentHumidifierDehumidifierState` (validValues INACTIVE/HUMIDIFYING only), `TargetHumidifierDehumidifierState` (HUMIDIFIER only), `RelativeHumidityHumidifierThreshold` (`rhset`, minStep 25), `WaterLevel` (`wl`)                                                                                                                                                                                                                               |
| `TemperatureSensor`                          | `temperature`     | `CurrentTemperature` (`temp`)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `HumiditySensor`                             | `humidity`        | `CurrentRelativeHumidity` (`rh`)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Lightbulb`                                  | `light`           | `On` (`pwr === '1' && aqil > 0`; forced off when the device is off), `Brightness` (`aqil`, minStep 25)                                                                                                                                                                                                                                                                                                                                                        |

Two behaviours worth memorising:

- `onGet` handlers return the **last polled** state from `this.obj` — the plugin is
  poll-driven, never request-driven. Most `onSet` handlers optimistically
  `updateCharacteristic` before sending the device command, but not all:
  `setPurifierLockPhysicalControls`, `setLightOn`, and `setLightBrightness` just send
  and let the next poll confirm.
- The `FilterMaintenance` subtypes are addressed by the quoted display names above
  (`accessory.getService('Pre Filter')` etc.); renaming them orphans the existing
  service instance on users' accessories.

## Provenance and maintenance

Verified against the repo at commit 36067a6, 2026-07-12. Re-verify:

```bash
grep -n "status-observe\|'set'" src/accessories/accessories.handler.js   # CLI subcommands in use
grep -n "'-I'" src/accessories/accessories.models.js src/accessories/accessories.handler.js  # -I call sites
node --test test/accessories.handler.test.js test/accessories.models.test.js  # dialect + mapping behaviour
grep -n "handleCommand" src/accessories/accessories.handler.js            # value-before-key order intact
grep -n "context.config.\|addService" src/accessories/accessories.service.js  # service conditions + subtypes
```
