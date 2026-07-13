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
  `debug` option is on. Confirm base args:
  `node --test --test-name-pattern 'builds the base arguments' test/accessories.handler.test.js`.
- `set` accepts multiple `key=value` pairs in one invocation (used by
  `setPurifierRotationSpeed` for composite speed entries).
- `-I` after `set` is appended per model via `extraSetFlags` (AC0850: every set), and
  hard-coded on specific numeric commands: `aqil` (light brightness) and `rhset`
  (humidity target). Per `aioairctrl set --help` (`-I, --int`), it encodes the value as
  an integer instead of a string (maintainer-confirmed against the CLI, 2026-07-13).
- The plugin logs the CLI's **stderr** at debug level and assumes **stdout carries
  only status JSON lines** — anything else on stdout triggers
  `Failed to parse device response` (see `debugging-and-operations`).

The `status-observe` stream is line-buffered by `handleStdoutChunk` (chunks may split or
merge JSON lines), capped at 1 MB, and each complete line goes to `processUpdate`.

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
   numeric, every `set` needs `-I` (`extraSetFlags`). Speeds are composite register
   pairs (`{ D0310A: 2, D0310C: 17|0|18 }`). The exact model ID in config is
   **required** for this dialect (README note 1).

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

| Service                                      | Condition         | Key characteristics (source key → HAP)                                                                                                                                                                                          |
| -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AccessoryInformation`                       | always            | Manufacturer/Model/SerialNumber from config; FirmwareRevision = package version (`src/platform.js`)                                                                                                                             |
| `AirPurifier`                                | always            | `Active` (`pwr`), `CurrentAirPurifierState` (`pwr`→0/2), `TargetAirPurifierState` (`mode==='M'`→0 else 1), `LockPhysicalControls` (`cl`), `RotationSpeed` (previous section)                                                    |
| `AirQualitySensor`                           | always            | `AirQuality` (`iaql`, clamped `ceil(iaql/3)`), `PM2_5Density` (`pm25`)                                                                                                                                                          |
| `FilterMaintenance` ("Pre Filter")           | `preFilter`       | `FilterChangeIndication` (`fltsts0 == 0`), `FilterLifeLevel` (`fltsts0`)                                                                                                                                                        |
| `FilterMaintenance` ("Active carbon filter") | `carbonFilter`    | same, from `fltsts2`                                                                                                                                                                                                            |
| `FilterMaintenance` ("HEPA filter")          | `hepaFilter`      | same, from `fltsts1`                                                                                                                                                                                                            |
| `FilterMaintenance` ("Wick filter")          | with `humidifier` | same, from `wicksts`                                                                                                                                                                                                            |
| `HumidifierDehumidifier`                     | `humidifier`      | `Active`, `CurrentHumidifierDehumidifierState` (validValues INACTIVE/HUMIDIFYING only), `TargetHumidifierDehumidifierState` (HUMIDIFIER only), `RelativeHumidityHumidifierThreshold` (`rhset`, minStep 25), `WaterLevel` (`wl`) |
| `TemperatureSensor`                          | `temperature`     | `CurrentTemperature` (`temp`)                                                                                                                                                                                                   |
| `HumiditySensor`                             | `humidity`        | `CurrentRelativeHumidity` (`rh`)                                                                                                                                                                                                |
| `Lightbulb`                                  | `light`           | `On` (`pwr === '1' && aqil > 0`; forced off when the device is off), `Brightness` (`aqil`, minStep 25)                                                                                                                          |

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
