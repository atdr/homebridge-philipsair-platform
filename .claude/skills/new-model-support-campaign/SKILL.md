---
name: new-model-support-campaign
description: Decision-gated runbook for adding or fixing support for a Philips purifier/humidifier model (a user reports an unsupported device, wrong speeds, or ineffective controls). Covers capturing a baseline status dump, identifying the wire dialect, deriving speed/key/value maps from observation, encoding them in accessories.models.js, and the live verification protocol before a model may be called tested. Load when a device model misbehaves or a new model is requested. Not for general runtime triage (debugging-and-operations) or protocol background (aioairctrl-and-device-protocol - read it alongside this).
---

# New-model support campaign

This is the project's hardest recurring problem (maintainer-confirmed, 2026-07-12): a
user has a Philips model this plugin doesn't map correctly, and the fix requires
evidence from hardware nobody in the repo can see. Work the gates in order; each gate
states what you should observe and where to branch if you don't. Read
`aioairctrl-and-device-protocol` first for the vocabulary (dialects, `speeds`,
`keyMaps`, `valueMaps`, `extraSetFlags`).

Two hard rules, both paid for in git history:

- **Never derive a mapping by analogy with another model.** The AC0850 turbo value
  (commit 7417a2d) and the AC1715 mode register (commit bf691b0) were both guessed and
  both wrong. Only observed status dumps count.
- **Success is measured in the `status-observe` stream and the Home app, never judged
  by eye or ear** ("the fan sounds faster" is not evidence).

The person with the device is often a non-technical user: give them exact
copy-pasteable commands (theirs run on the Homebridge host) and ask for pasted output.

## Gate 0 — prerequisites

Commands for the device owner, on the Homebridge host:

```bash
aioairctrl --help
ping -c 3 <device-ip>
```

EXPECTED: usage text; ping replies. If `aioairctrl` is missing → README installation
section. If ping fails → network problem, branch to `debugging-and-operations`. Also
record: exact model ID from the device label (e.g. AC2889), firmware if visible in the
Philips app.

## Gate 1 — capture the known-good baseline

```bash
timeout 30 aioairctrl -H <device-ip> -P 5683 status-observe -J | head -n 1 | tee baseline-status.json
```

EXPECTED: one JSON object within a few seconds. If nothing arrives → the device doesn't
answer CoAP on 5683; branch to `debugging-and-operations` (frozen-state row). If output
is not JSON → capture it verbatim and treat as an upstream aioairctrl issue.

Save this baseline **and every dump from later gates** — attach them to the GitHub
issue/PR; they are the evidence record. Capture the baseline in the device's "normal
on" state before touching anything.

## Gate 2 — identify the dialect

Look at the keys in `baseline-status.json`:

- Keys like `pwr`, `om`, `mode`, `aqil` → **default dialect**. Real chance no mapping
  is needed at all — go to Gate 3 and test the default behaviour first.
- Dashed registers like `D03-02` → AC1715-style (word values, needs `keyMaps` +
  `valueMaps`).
- Dash-less registers like `D03102` → AC0850-style (numeric values, needs `keyMaps` +
  `extraSetFlags: ['-I']`; the exact model ID in config will be required).
- Anything else → new dialect; capture generously and expect Gate 4 experimentation.

## Gate 3 — map controls by differential observation

Leave this running in one terminal on the Homebridge host:

```bash
aioairctrl -H <device-ip> -P 5683 status-observe -J
```

Then change ONE thing at a time on the physical device or in the Philips app — power,
each fan speed step in order, sleep/auto/turbo modes, display light, child lock — and
record which keys change in the emitted JSON after each action. EXPECTED: each control
flips one or two keys. Build a table: control → key(s) → value per position. The
ordered speed positions become the `speeds` array (slowest first); remember entries
match on ALL their keys with stringified equality (`rotationSpeed` in
`accessories.handler.js`).

If a control changes nothing in the stream, the device doesn't report it — that
feature can't be supported; note it rather than faking it.

## Gate 4 — verify set commands round-trip

For each key from Gate 3, have the device owner run the write and watch the observe
stream:

```bash
aioairctrl -H <device-ip> -P 5683 set <key>=<value>
```

EXPECTED: the observe stream reflects the new value within a few seconds, and the
command exits without error. If the command errors or silently does nothing → retry
with `-I` between `set` and the pair (integer parsing; the AC0850 dialect needs it on
every set). If `-I` fixes it, record that — it becomes `extraSetFlags`. If neither form
works, the register may be read-only or the value space wrong; re-observe (Gate 3)
rather than guessing.

## Gate 5 — choose the smallest encoding (ranked)

Each option carries an evidence obligation from Gates 3–4:

1. **No entry needed** — dump shows default keys and the observed speed values are
   exactly `om: '1'/'2'/'t'` (plus `'s'`). Evidence: Gate 3 table. Action: docs only —
   add the model to the README tested list and the `config.schema.json` typeahead.
2. **`sleepSpeed: true` config flag only** — as above plus an `om: 's'` position.
3. **`speeds`-only entry** (AC3036 shape) — default keys but different speed
   positions/registers. Evidence: full Gate 3 speed table.
4. **`keyMaps`/`valueMaps` entry** (AC1715 shape) — dashed registers or word values.
   Evidence: Gate 3 table covering every generic key you map, Gate 4 round-trip for
   every writable one.
5. **`extraSetFlags` entry** (AC0850 shape) — Gate 4 showed sets need `-I`. Evidence:
   the failing and succeeding command outputs.
6. **Handler code change** — last resort, only when the dialect cannot be expressed as
   data in `accessories.models.js`. Stop and discuss with the maintainer first; this
   crosses from data into the fragile paths listed in `architecture-and-invariants`.

Encode in `src/accessories/accessories.models.js` with a comment naming the evidence
source (issue/PR number). The sync tests will force the typeahead and README updates —
see `change-control-and-docs`; write unit tests per `testing-and-validation` (copy
`test/accessories.models.test.js` and the `handleCommand`/`handleResponse` cases in
`test/accessories.handler.test.js`).

## Gate 6 — live verification protocol (before "tested" status)

The device owner runs the plugin build from your branch and confirms, from the Home
app, with the observe stream or Homebridge debug log as the measurement:

1. Power on and off — `pwr` follows within a few seconds each way.
2. Every speed slider step — the mapped register(s) hit the Gate 3 values, and the
   slider position survives the next status update (no snap-back).
3. Auto/manual mode switch, child lock, and light toggle if mapped.
4. Filter percentages plausible (0–100, no HomeKit characteristic warnings in the log).
5. A state change made on the physical device appears in the Home app within ~65 s
   (one observe restart cycle — see `debugging-and-operations`).

Snap-back on the speed slider (step 2) means a `speeds` entry doesn't match the
device's actual reported state — back to Gate 3 for that position.

## Gate 7 — promotion

Land via the normal PR flow (`change-control-and-docs`). In the PR: the Gate 1
baseline, the Gate 3 table, Gate 4 outputs, and the Gate 6 checklist results. A model
goes in the README "Tested devices" list only with Gate 6 evidence; with anything less
it belongs in the "Not yet confirmed" list (the AC3829 precedent — listed but
unconfirmed, README). Commit type: `feat` (it changes what devices users can run —
minor version bump).

## Provenance and maintenance

Verified against the repo at commit 36067a6, 2026-07-12. Re-verify:

```bash
grep -n "extraSetFlags\|keyMaps\|valueMaps\|speeds" src/accessories/accessories.models.js  # encoding surface unchanged
grep -n "rotationSpeed()" -A 8 src/accessories/accessories.handler.js                      # all-keys stringified matching
grep -n "Tested devices\|Not yet confirmed" README.md                                       # promotion targets exist
node --test test/config.schema.test.js test/docs.test.js                                    # sync guards active
```
