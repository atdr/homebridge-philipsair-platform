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

Fixed for #48 by making the stall timer state-dependent rather than by choosing a different
constant, which the experiment above rules out. `armStallTimeout` picks its timeout from
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

**[AC0850] A fresh subscription elicits a reading.** This is why the pre-#30 fixed 60 s process
lifetime accidentally worked as a ~65 s poll loop, and why raising `STALL_TIMEOUT` alone
makes idle staleness worse rather than better. The deliberate periodic refresh in
`armRefreshTimeout` is the fix, and the 60 s default is that accidental v1.1.0 behaviour made
explicit rather than a number derived from these measurements. Since #71 it is only the **floor**:
the elicited reading is not free, and `adaptRefresh` backs the interval off wherever a
re-subscription costs more than the wait it replaced, so the trade is made per device rather than
per constant.

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

| Generic key     | Meaning in this repo                        | Values seen in code/tests                                                                                                   |
| --------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `pwr`           | Power                                       | `'1'`/`'0'` (AC1715 device-side: `'ON'`/`'OFF'`, value-mapped)                                                              |
| `mode`          | Operating mode                              | Set path: `'P'` (auto), `'M'` (manual), `'A'` (allergen, when `allergicFunc`). Read path: `mode === 'M'` → HomeKit "manual" |
| `om`            | Fan speed register (default dialect)        | `'s'` (sleep), `'1'`, `'2'`, `'t'` (turbo)                                                                                  |
| `cl`            | Child lock                                  | boolean                                                                                                                     |
| `aqil`          | Display/light brightness                    | 0–100 (set with `-I`)                                                                                                       |
| `uil`           | Buttons/UI light                            | `'1'`/`'0'`                                                                                                                 |
| `func`          | Function (humidifier-capable models)        | `'P'` purification, `'PH'` purification + humidification                                                                    |
| `rhset`         | Target humidity                             | 40/50/60/70, mapped to HomeKit threshold 25/50/75/100                                                                       |
| `wl`            | Water level                                 | 0 (empty) or 100 in the code's branches                                                                                     |
| `iaql`          | Indoor allergen index                       | HomeKit AirQuality = `ceil(iaql / 3)` clamped 0–5                                                                           |
| `pm25`          | PM2.5 density                               | clamped 0–1000                                                                                                              |
| `rh` / `temp`   | Humidity % / temperature °C                 | clamped 0–100 / −270–100                                                                                                    |
| `fltsts0/1/2`   | Filter hours remaining: pre / HEPA / carbon | 0 = "change now"; life% = `fltsts / flttotal`                                                                               |
| `flttotal0/1/2` | Filter total hours                          | fallbacks when absent: 360 / 4800 / 4800                                                                                    |
| `wicksts`       | Wick filter hours remaining                 | life% = `wicksts / 4800`                                                                                                    |

A key missing from a status line is normal — devices only report what they have; the
filter blocks in `processUpdate` skip on `undefined` (regression fixed in commit
6f81c9a).

## The three model dialects

Defined in `src/accessories/accessories.models.js` (pure data; see
`architecture-and-invariants` for why):

1. **Default / legacy** (AC3829 and anything unlisted): generic keys are the wire keys.
   Speeds are `om`-based: `['1','2','t']`, with `'s'` prepended when the device config
   sets `sleepSpeed`. AC3036 is a variant: no key maps, but five `mode`/`om` composite
   speed steps.
2. **AC1715-style**: wire keys are dashed registers (`pwr` → `D03-02`), values are
   words (`'ON'`, `'Auto General'`); `valueMaps.pwr` translates both directions. Speeds
   are `mode`-word steps.
3. **AC0850-style**: wire keys are dash-less registers (`pwr` → `D03102`), values are
   numeric, every `set` asks for `-I` (`extraSetFlags`). Speeds are composite register
   pairs (`{ D0310A: 2, D0310C: 17|0|18 }`). The exact model ID in config is
   **required** for this dialect (README note 1). It no longer has to be typed
   perfectly: `resolveModel` normalises case, spacing and the `/NN` regional
   suffix printed on the device, and falls back to a model ID left in the device
   name. Failing all that, `identifyModel` reads the model out of the status
   itself on the first reading and adopts it from the next restart
   (`Handler.checkModelMapping`).

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
   > the plugin neither sends those commands nor exposes the HomeKit controls bound to them.
   > Believed, not proven — issue #46 carries the status-diff experiment that settles it.
   > A **baseline register inventory** is now attached to that issue: 89 status payloads from
   > one unit on firmware `0.1.3`, off versus on, showing the complete set of 27 registers it
   > reports. That closes the candidate list for `mode`/`cl` to the 16 unmapped constants, and
   > shows `D0310D` tracking power alongside `D03102`. It **identifies neither key**, because
   > the unit never changed mode or lock state during the capture, so anything encoding them
   > would read as constant. The experiment still needs someone at the physical unit.

A fourth field, **`unsupported`**, is a per-model list of generic keys the device has no
register for at all. `Handler.supports(key)` reads it, and it gates three things: the `set*`
method, the optimistic push, and the characteristic in `accessories.service.js`. Adding a key
here removes a control from users' Home apps, so it belongs on observed absence from a status
dump, never on a mapping that merely has not been worked out yet.

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
`speedsMinStep` gives the slider step. Writing a speed reverses this: `Math.ceil(value /
minStep)` picks the entry and every pair in it is sent as a `set` command. A status that
matches no entry yields RotationSpeed 0.

## The HomeKit surface (services and characteristics)

The other end of the translation: which HomeKit services the plugin exposes and which
generic key feeds each characteristic. Services are wired in
`src/accessories/accessories.service.js` (conditional ones are added when the device
config enables the option and removed otherwise); values are pushed from
`processUpdate` and the `set*` methods in `accessories.handler.js`.

| Service                                      | Condition         | Key characteristics (source key → HAP)                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessoryInformation`                       | always            | Manufacturer/Model/SerialNumber from config; FirmwareRevision = package version (`src/platform.js`)                                                                                                                                                                                                                                                                  |
| `AirPurifier`                                | always            | `Active` (`pwr`), `CurrentAirPurifierState` (`pwr`→0/2), `TargetAirPurifierState` (`mode==='M'`→0 else 1; pinned to `validValues: [AUTO]` when `mode` is `unsupported`, since HAP requires the characteristic), `LockPhysicalControls` (`cl`; not added at all, and removed from a cached accessory, when `cl` is `unsupported`), `RotationSpeed` (previous section) |
| `AirQualitySensor`                           | always            | `AirQuality` (`iaql`, clamped `ceil(iaql/3)`), `PM2_5Density` (`pm25`)                                                                                                                                                                                                                                                                                               |
| `FilterMaintenance` ("Pre Filter")           | `preFilter`       | `FilterChangeIndication` (`fltsts0 == 0`), `FilterLifeLevel` (`fltsts0`)                                                                                                                                                                                                                                                                                             |
| `FilterMaintenance` ("Active carbon filter") | `carbonFilter`    | same, from `fltsts2`                                                                                                                                                                                                                                                                                                                                                 |
| `FilterMaintenance` ("HEPA filter")          | `hepaFilter`      | same, from `fltsts1`                                                                                                                                                                                                                                                                                                                                                 |
| `FilterMaintenance` ("Wick filter")          | with `humidifier` | same, from `wicksts`                                                                                                                                                                                                                                                                                                                                                 |
| `HumidifierDehumidifier`                     | `humidifier`      | `Active`, `CurrentHumidifierDehumidifierState` (validValues INACTIVE/HUMIDIFYING only), `TargetHumidifierDehumidifierState` (HUMIDIFIER only), `RelativeHumidityHumidifierThreshold` (`rhset`, minStep 25), `WaterLevel` (`wl`)                                                                                                                                      |
| `TemperatureSensor`                          | `temperature`     | `CurrentTemperature` (`temp`)                                                                                                                                                                                                                                                                                                                                        |
| `HumiditySensor`                             | `humidity`        | `CurrentRelativeHumidity` (`rh`)                                                                                                                                                                                                                                                                                                                                     |
| `Lightbulb`                                  | `light`           | `On` (`pwr === '1' && aqil > 0`; forced off when the device is off), `Brightness` (`aqil`, minStep 25)                                                                                                                                                                                                                                                               |

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
