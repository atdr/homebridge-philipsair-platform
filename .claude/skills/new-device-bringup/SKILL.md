---
name: new-device-bringup
description: >-
  Decision-gated runbook for the project's hardest task: adding or fixing a
  Philips model's speed/key/value mappings so HomeKit controls it correctly. Load
  when a user reports an unsupported or misbehaving model, when a fan reads 0% or
  a control does nothing on a specific device, or when adding a model to
  accessories.models.js. Walks from a real-hardware baseline through deriving the
  maps to wiring schema/docs/tests and promoting through change control.
---

# New-device bring-up campaign

Bringing up a new Philips model is the highest-uncertainty change in this repo:
the device's field names and value encodings are only knowable by observing the
real hardware, and a wrong guess ships a plausible-but-broken mapping. Work the
gates in order; capture evidence at each one; never skip to editing
`accessories.models.js` from intuition.

- Prerequisite reading: `homekit-device-reference` (what the keys and maps mean)
  and `debugging-playbook` (how to read the device and confirm a symptom).
- To land the result: `testing-and-validation` then `change-control-and-docs`.
- **Not** for changing an _already-mapped_ model's unrelated behaviour — that is
  ordinary work under the other skills.

**Unwritten rules that bind this whole task** (from the maintainer): do not
change device I/O blindly, and do not "tidy up" or guess at existing maps — they
were copied from working configs and other projects and are correct by
provenance, not by looking neat.

## Gate 0 — Confirm you can observe the real device

You need the physical unit on the network (the maintainer has hardware; a
drive-by contributor working only from a pasted status dump can do Gates 1–4 but
**cannot** discharge Gate 5's evidence). As the Homebridge user:

```bash
sudo -u homebridge aioairctrl -H <device-ip> -P 5683 status-observe -J
```

- **Expected:** one JSON object per line, streaming.
- **If `aioairctrl` not found / connection error instead →** stop and fix the
  environment first via `debugging-playbook` ("aioairctrl not found"). You cannot
  bring up a model you cannot talk to.

## Gate 1 — Capture a known-good baseline

Record raw status in several device states, because the maps are derived from how
values _change_:

1. Device off; on; each fan speed (low → turbo, and sleep if present); auto mode;
   allergic mode if supported; humidify on/off; light on/off.
2. Save each raw JSON line, labelled with the state, to a scratch file.

This baseline is your ground truth for the rest of the campaign and your
before/after reference for Gate 5. Keep it.

## Gate 2 — Decide whether a dedicated map is even needed

Look at the keys in the baseline:

- **If the device reports plain `om` / `pwr` / `mode` etc. and the default
  `om`-based speeds already track the fan →** it likely needs _no_ map at all;
  the model works with default config. In that case you may still add it to the
  typeahead + README as a tested device (no `models.js` entry), which is allowed:
  the typeahead is a superset of `mappedModels` (AC3829 is present without a map).
- **If the fan reads 0%/off while running, or controls do nothing →** the device
  uses different registers or value encodings. Proceed to Gate 3.
  (Root cause of the 0% symptom: `rotationSpeed()` finds no matching `speeds`
  entry and returns 0 — see `homekit-device-reference`.)

## Gate 3 — Derive the maps from the baseline (ranked menu)

Add the minimum that makes the baseline states map correctly. Each option carries
an evidence obligation: a unit test asserting the derived behaviour (Gate 4) plus
a live check (Gate 5).

1. **`speeds` (most common).** Build an ordered array where entry _n_ is the set
   of key/values observed at HomeKit speed step _n_. Order defines the slider.
   _Evidence:_ a `speeds`/`rotationSpeed` unit test (see
   `test/accessories.handler.test.js` "speeds per model").
2. **`keyMaps`** when the device uses model-specific registers (like AC1715's
   `D03-13` or AC0850's `D0310C`). Map each generic key you care about to its
   register. Applied both directions. _Evidence:_ a `handleResponse` test showing
   the register value surfaces under the generic key.
3. **`valueMaps`** when a value is an encoded string, not the literal HomeKit
   expects (like AC1715 `pwr`: `ON↔1`). Provide both directions. _Evidence:_ a
   `handleCommand`/`handleResponse` round-trip test.
4. **`extraSetFlags`** when writes need an extra CLI flag (AC0850 uses `['-I']`).
   Only add a flag you have observed a working config use — **do not guess flag
   semantics** (`homekit-device-reference` explicitly leaves `-I` undocumented).
   _Evidence:_ confirm a live `set` actually changes the device (Gate 5).

If a state in the baseline can't be explained by any of these, stop and record
the anomaly rather than inventing a mapping — an unexplained field is a signal,
not noise.

## Gate 4 — Wire it in (all four spots, or CI fails)

1. Add the model object to `models` in `src/accessories/accessories.models.js`.
2. Add the model ID to the `devices[].model` typeahead `source` in
   `config.schema.json`. _(CI-enforced: `test/config.schema.test.js`.)_
3. Add the model to the README "Tested devices" list. _(CI-enforced:
   `test/docs.test.js`.)_
4. Add unit tests for the derived maps (Gate 3 evidence).

Then run the gates locally (`change-control-and-docs`). The two drift tests will
fail immediately if you missed spot 2 or 3.

## Gate 5 — Validate on real hardware (never by eye alone)

For each control the model exposes, drive it from the Home app (or a live `set`)
and confirm the device physically responds **and** the Home app reflects the
polled-back state:

```bash
sudo -u homebridge aioairctrl -H <ip> -P 5683 set <key>=<value>   # then re-observe
```

- **Expected:** the state you set appears in the next `status-observe` line and
  the HomeKit characteristic settles to the matching value.
- **If it doesn't →** the map is wrong for that control; return to Gate 3 with the
  new observation. Success is _measured against the device_, not judged by
  whether the code looks right.

If you only have a pasted dump and no hardware, say so explicitly in the PR: the
change is fixture-validated, awaiting a real-device confirmation.

## Promotion protocol

1. Commit as `feat(models): add <MODEL> mappings` (a `feat` — it adds a supported
   device and should cut a minor release). One logical change per commit.
2. Open a PR to `main`; all six gates green.
3. State the Gate 5 evidence in the PR body (which controls were live-verified,
   on what firmware, or that it is fixture-only).
4. On merge, release-please handles the version bump and npm publish — do not
   publish by hand. See `change-control-and-docs`.

## Fenced-off wrong paths

- Don't add a `models.js` entry without a test and without the typeahead + README
  rows — CI will block it, and an untested map is exactly the failure this task
  exists to prevent.
- Don't rename or "normalise" existing register/value maps; they are correct by
  provenance.
- Don't infer a register or flag you haven't seen in a real dump or a known-good
  config.

## Provenance and maintenance

Facts verified 2026-07-12 against the working tree. Re-verify:

```bash
# The four wiring spots and their CI guards
grep -n "mappedModels\|speeds\|keyMaps\|valueMaps\|extraSetFlags" src/accessories/accessories.models.js
grep -n "typeahead" config.schema.json
grep -n "Tested devices" README.md
node --test test/accessories.handler.test.js test/config.schema.test.js test/docs.test.js

# The 0%-fan root cause referenced above
grep -n "findIndex\|speedIndex" src/accessories/accessories.handler.js
```
