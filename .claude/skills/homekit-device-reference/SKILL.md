---
name: homekit-device-reference
description: >-
  Domain reference for the two vocabularies this plugin translates between:
  Apple HomeKit services/characteristics and the Philips device key/value
  protocol spoken over the aioairctrl CLI. Load when mapping a device value to a
  characteristic, decoding an aioairctrl status line (pwr, mode, om, func, rhset,
  iaql, wl, fltsts*...), reading the per-model speed/key/value maps, or working
  out what an aioairctrl invocation does. Reference material, not a change
  procedure.
---

# HomeKit and Philips device reference

The plugin's whole job is a translation layer: read Philips device state and push
it onto HomeKit characteristics (`processUpdate`), and turn HomeKit `onSet` calls
into device commands (the `set*` methods). This skill is the dictionary for both
sides. It is anchored to `accessories.service.js`, `accessories.handler.js`, and
`accessories.models.js` — when the code and this table disagree, the code wins;
fix this skill.

- To add a _new model's_ maps, use `new-device-bringup`.
- To diagnose a value that looks wrong at runtime, use `debugging-playbook`.

Jargon, defined once:

- **aioairctrl** — the third-party pip CLI that speaks Philips' encrypted CoAP
  protocol. This repo shells out to it; it does not implement the protocol.
- **register / device key** — a model-specific field name in the device's JSON
  (e.g. `D03-13`). **generic key** — the model-independent name the handler uses
  internally (e.g. `om`). `keyMaps`/`valueMaps` translate between them.

## The aioairctrl CLI surface (only what this repo uses)

The handler builds a base argument array and appends a subcommand. Verified in
`accessories.handler.js`:

```text
aioairctrl -H <host> -P <port> [-D] status-observe -J
aioairctrl -H <host> -P <port> [-D] set [<extraSetFlags>] <key>=<value> [-I]
```

- `-H <host>` host/IP, `-P <port>` port (default 5683, the CoAP port).
- `-D` debug output — appended only when the device `debug` flag is set.
- `status-observe -J` — long-lived observe stream that emits one JSON status
  object per line (consumed by `longPoll`).
- `set <key>=<value>` — one-shot writes (consumed by `sendCMD` via `execFile`).
- `-I` — a flag `aioairctrl` accepts on `set`; used as the AC0850
  `extraSetFlags` and on specific humidifier/light writes. **This repo does not
  document what `-I` means** — treat it as an opaque aioairctrl set flag copied
  from working configs (inferred: an "immediate/no-confirm" style flag; do not
  assert this in code or docs without checking aioairctrl).

To reproduce a status line by hand (you need a real device or a stand-in):

```bash
aioairctrl -H <device-ip> -P 5683 status-observe -J   # Ctrl-C after the first JSON line
```

## Philips generic keys (the internal vocabulary)

These are the keys the handler reads off `this.obj` after `handleResponse` has
applied any model `keyMaps`/`valueMaps`. Values are whatever the device sends
(often strings).

| Key             | Meaning                      | Notable values / handling                                                                                                                                                        |
| --------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pwr`           | Power                        | `'1'` on, `'0'`/other off. `parseInt(pwr)` gates most state.                                                                                                                     |
| `mode`          | Purifier mode                | `'M'` manual; anything else treated as auto for `TargetAirPurifierState`. `'P'` purification, `'A'` allergic, plus model-specific (`'S'`, `'AG'`, `'T'`, `'Auto General'`, ...). |
| `om`            | Fan output/speed             | default speed key: `'1'`, `'2'`, `'t'` (turbo), `'s'` (sleep).                                                                                                                   |
| `func`          | Function                     | `'P'` purify only; `'PH'` purify + humidify.                                                                                                                                     |
| `rhset`         | Target humidity %            | 40 / 50 / 60 / 70 → HomeKit threshold 25 / 50 / 75 / 100.                                                                                                                        |
| `cl`            | Child lock                   | truthy = locked.                                                                                                                                                                 |
| `aqil`          | Air-quality light brightness | 0–100; drives the Lightbulb On/Brightness.                                                                                                                                       |
| `uil`           | Button/UI light              | `'1'`/`'0'` written alongside `aqil` on light changes.                                                                                                                           |
| `iaql`          | Indoor air-quality index     | mapped to HomeKit AirQuality 1–5 (see formula).                                                                                                                                  |
| `pm25`          | PM2.5 density                | clamped `hapNumber(pm25, 0, 1000)`.                                                                                                                                              |
| `rh`            | Relative humidity %          | clamped `hapNumber(rh, 0, 100)`.                                                                                                                                                 |
| `temp`          | Temperature                  | clamped `hapNumber(temp, -270, 100)`.                                                                                                                                            |
| `wl`            | Water level                  | `0` = empty; empties the humidifier and forces purifier auto.                                                                                                                    |
| `wicksts`       | Wick filter status           | life = `round(wicksts / 4800 * 100)`.                                                                                                                                            |
| `fltsts0`       | Pre-filter remaining         | life = `fltsts0 / (flttotal0 \|\| 360) * 100`.                                                                                                                                   |
| `fltsts1`       | HEPA filter remaining        | life = `fltsts1 / (flttotal1 \|\| 4800) * 100`.                                                                                                                                  |
| `fltsts2`       | Active-carbon remaining      | life = `fltsts2 / (flttotal2 \|\| 4800) * 100`.                                                                                                                                  |
| `flttotal0/1/2` | Filter capacities            | denominators above; fall back to the defaults shown.                                                                                                                             |

For any filter, `fltsts* == 0` sets `FilterChangeIndication` (needs changing).

## HomeKit services and characteristics (what gets exposed)

Built in `accessories.service.js`; updated in `accessories.handler.js`
(`processUpdate` and the `set*` handlers). Services marked _conditional_ are
added only when the device config enables the matching option, and removed
otherwise.

| Service                                    | Condition         | Key characteristics (source key → HAP)                                                                                                                                                                              |
| ------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessoryInformation`                     | always            | Manufacturer/Model/SerialNumber from config; FirmwareRevision = package version                                                                                                                                     |
| `AirPurifier`                              | always            | `Active` (`pwr`), `CurrentAirPurifierState` (`pwr`→0/2), `TargetAirPurifierState` (`mode==='M'`→0 else 1), `LockPhysicalControls` (`cl`), `RotationSpeed` (see below)                                               |
| `AirQualitySensor`                         | always            | `AirQuality` (`iaql`, see formula), `PM2_5Density` (`pm25`)                                                                                                                                                         |
| `FilterMaintenance` (Pre Filter)           | `preFilter`       | `FilterChangeIndication`, `FilterLifeLevel` (`fltsts0`)                                                                                                                                                             |
| `FilterMaintenance` (Active carbon filter) | `carbonFilter`    | `fltsts2`                                                                                                                                                                                                           |
| `FilterMaintenance` (HEPA filter)          | `hepaFilter`      | `fltsts1`                                                                                                                                                                                                           |
| `FilterMaintenance` (Wick filter)          | with `humidifier` | `wicksts`                                                                                                                                                                                                           |
| `HumidifierDehumidifier`                   | `humidifier`      | `Active`, `CurrentHumidifierDehumidifierState` (INACTIVE/HUMIDIFYING only), `TargetHumidifierDehumidifierState` (HUMIDIFIER only), `RelativeHumidityHumidifierThreshold` (`rhset`, minStep 25), `WaterLevel` (`wl`) |
| `TemperatureSensor`                        | `temperature`     | `CurrentTemperature` (`temp`)                                                                                                                                                                                       |
| `HumiditySensor`                           | `humidity`        | `CurrentRelativeHumidity` (`rh`)                                                                                                                                                                                    |
| `Lightbulb`                                | `light`           | `On` (`pwr==='1' && aqil>0`), `Brightness` (`aqil`, minStep 25)                                                                                                                                                     |

`onGet` handlers report the **last polled** state from `this.obj` (the plugin is
poll-driven, not request-driven). `onSet` handlers optimistically
`updateCharacteristic` and then send the device command.

### Derived values worth memorising

- **Rotation speed.** `speedsMinStep() = 100 / speeds.length`. `rotationSpeed()`
  finds the index of the `speeds` entry whose every key matches `this.obj`, then
  returns `(index + 1) * minStep`. No match → index `-1` → **0%** (reads as off).
- **Air quality.** `AirQuality = min(max(ceil(iaql / 3) || 0, 0), 5)` — HomeKit
  only accepts 0 (unknown) to 5 (poor).
- **Humidity threshold.** `rhset` 40/50/60/70 ↔ 25/50/75/100 %, symmetric in
  `setHumidifierTargetState` and `processUpdate`.
- **Water empty.** `func === 'PH' && wl === 0` → `WaterLevel` 0, humidifier forced
  inactive, and (if not already purify-only) the purifier is pushed to auto.

## Per-model maps (`accessories.models.js`)

`modelConfig(deviceConfig)` returns `{ speeds, keyMaps, valueMaps, extraSetFlags }`
for the configured `model`, falling back to defaults for unlisted models.

- **`speeds`** — ordered array; each entry is an object of `key: value` pairs that
  must _all_ match `this.obj` for that speed to be selected. Order defines the
  HomeKit slider steps. Default: `[{om:'1'},{om:'2'},{om:'t'}]`; with
  `sleepSpeed`, `{om:'s'}` is prepended.
- **`keyMaps`** — generic key → device register, applied both directions
  (`handleResponse` device→generic, `handleCommand` generic→device).
- **`valueMaps`** — per-key value translation table, also bidirectional (e.g.
  AC1715 `pwr`: `ON↔1`, `OFF↔0`).
- **`extraSetFlags`** — extra CLI flags injected into every `set` (AC0850 uses
  `['-I']`).

Currently mapped models (`modelConfig.mappedModels`): **AC3036** (mode-based
speeds), **AC1715** (`D03-`/`D05-` registers + `pwr` value map), **AC0850**
(composite `D0310A`/`D0310C` speeds + `-I`). Anything else uses the `om` defaults.

Note: the `config.schema.json` model typeahead may suggest models that have **no**
dedicated map (e.g. AC3829) — a suggestion is not a guarantee of a mapping. The
invariant is only that every mapped model appears in the typeahead and README
(enforced by the drift tests; see `testing-and-validation`).

## Provenance and maintenance

Facts verified 2026-07-12 against the working tree. Re-verify with:

```bash
# CLI invocation shapes
grep -n "status-observe\|'set'\|'-I'\|'-D'\|'-J'\|'-H'\|'-P'" src/accessories/accessories.handler.js

# Derived formulas
grep -n "speedsMinStep\|rotationSpeed\|iaql / 3\|rhset\|hapNumber" src/accessories/accessories.handler.js

# Services + conditions
grep -n "addService\|context.config\." src/accessories/accessories.service.js

# Model maps + the mapped-model list
grep -n "speeds\|keyMaps\|valueMaps\|extraSetFlags\|mappedModels" src/accessories/accessories.models.js
```

If a key, formula, or model is out of date, update this table in the same PR as
the code change (docs-sync row in `change-control-and-docs`).
