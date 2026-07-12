---
name: architecture-and-invariants
description: >-
  Load-bearing architecture and invariants of the homebridge-philipsair-platform
  plugin. Load before refactoring, when changing the platform/accessory/handler
  layers, when wiring a new characteristic or service, or whenever you need the
  WHY behind a decision. Covers the runtime flow, the CommonJS / singleton-logger
  / child-process-arg-array / name-derived-UUID invariants with their enforcement
  points, and the known-fragile spots (device I/O, the long-poll loop).
---

# Architecture and invariants

Runbook for understanding the shape of this plugin before you change it. This
skill adds the WHY and the fragile-spot map; it does not restate setup or the
git workflow.

- For what device keys and HomeKit characteristics _mean_, use
  `homekit-device-reference`.
- For how a change lands (gates, commits, release), use `change-control-and-docs`.
- For diagnosing a live misbehaviour, use `debugging-playbook`.

`AGENTS.md` (repo root) is the doc of record for the architecture summary and the
rules below; this skill assumes it and layers on rationale and enforcement.

## Runtime flow (source of truth: the files named)

1. `index.js` — `module.exports = (homebridge) => homebridge.registerPlatform(PLUGIN_NAME, 'PhilipsAirPlatform', PhilipsAirPlatform, true)`.
   `PLUGIN_NAME` is the package `name` (`@atdr/homebridge-philipsair-platform`).
   The trailing `true` registers a **dynamic platform**.
2. `src/platform.js` — `PhilipsAirPlatform`. Constructor returns early if
   `!api || !config`, configures the logger, runs `generateConfig`, and defers
   real work to the `didFinishLaunching` event. `didFinishLaunching` →
   `AccessoriesSetup(...)` then `configure()` (register new / remove stale /
   `setupAccessory` each live one). `configureAccessory` receives Homebridge's
   cached accessories on restart.
3. `src/accessories/`
   - `accessories.setup.js` — validates and de-dupes device configs; keys the
     device map by UUID.
   - `accessories.config.js` — shapes one device config, applying defaults and
     `validHost` / `validPort`.
   - `accessories.service.js` — `Accessory` class; adds/removes HomeKit services
     and wires `onGet`/`onSet`. Ends by calling `handler.longPoll()`.
   - `accessories.handler.js` — `Handler` class; all device I/O and the state
     object `this.obj`. **The bulk of the logic and the most fragile file.**
   - `accessories.models.js` — pure per-model data (`speeds`, `keyMaps`,
     `valueMaps`, `extraSetFlags`) plus `modelConfig.mappedModels`.
   - `index.js` — barrel export of the four classes above.
4. `src/utils/` — `logger.js` (singleton) and `utils.js` (`generateConfig`,
   `validHost`, `validPort`, `hapNumber`).

## Invariants (rule → WHY → where enforced)

### 1. CommonJS only, no ESM

`require` / `module.exports`, every runtime file starts with `'use strict';`.
WHY: the whole toolchain is configured for CommonJS. **Enforced mechanically:**
`eslint.config.js` sets `sourceType: 'commonjs'` (an `import`/`export` statement
is a parse error) and `tsconfig.json` sets `module: 'commonjs'` — so both
`npm run lint` and `npm run typecheck` fail on ESM.

### 2. All log output through the singleton logger

`src/utils/logger.js` exports a single `new Logger()` instance. It is configured
exactly once, in the `PhilipsAirPlatform` constructor, via
`logger.configure(log, config)`, which binds it to the Homebridge log and honours
the `debug` / `warn` / `error` / `extendedError` flags. Everywhere else,
`require` the logger and call `logger.info/debug/warn/error`. WHY: a plugin must
write to the Homebridge log, not stdout, and the flags gate verbosity centrally.
**Enforcement is by convention + code review, NOT lint** — the ESLint config
(`js.configs.recommended` + `eslint-config-prettier`) has **no `no-console`
rule**, so a stray `console.log` will pass CI. Treat this as a rule you uphold by
hand; AGENTS.md states it.

### 3. Child processes are spawned with argument arrays, never a shell string

`accessories.handler.js` runs the external `aioairctrl` CLI via
`execFile(this.binary, args, cb)` (`sendCMD`) and
`spawn(this.binary, [...this.args, 'status-observe', '-J'])` (`longPoll`).
Arguments are always arrays; no `exec`, no template-string command, no
`shell: true`. WHY: prevents shell/argument injection from user-supplied config
(hardening landed in PR #5, `fix: security hardening from project security
review`). Reinforced by `validHost` in `utils.js`, which rejects a host that is
empty, starts with `-` (could be read as a CLI flag), or contains whitespace.
**Enforced by:** `test/utils.test.js` (validHost cases) + review. Keep the
handler on `execFile`/`spawn` with arrays.

### 4. Accessory UUID is derived from the device NAME

`accessories.setup.js` computes `generateUUID(device.name)` (Homebridge
`api.hap.uuid.generate`). WHY: gives a stable identity without requiring a
serial. **Consequence / weak point:** renaming a device in config produces a new
UUID, so Home drops the old accessory and adds a fresh one — the user loses room
assignment, scenes, and automations for that device. Duplicate names collide and
the later one is skipped (a warning is logged). Do not switch the UUID source
casually; it is a breaking change for every existing user.

### 5. The published plugin identifier is the package name

Accessories are registered/unregistered under `PLUGIN_NAME` (the package
`name`). WHY it matters: `README.md` records that releases at or before v1.1.0
used a _different_ internal identifier, so upgrading past it re-adds each device
in HomeKit once. Renaming the package (or the `PLATFORM_NAME`
`'PhilipsAirPlatform'`) would orphan every cached accessory. Treat both strings
as frozen public contract.

### 6. Device values are coerced before reaching HAP

`hapNumber(value, min, max)` (`utils.js`) returns a finite, clamped number (0 on
non-finite input). WHY: Homebridge 2.x validates characteristic values strictly
and warns on `undefined` / `NaN` / out-of-range. Numeric characteristics fed from
`this.obj` (temp, rh, pm25, filter life, water level) go through `hapNumber` or an
explicit clamp. Add new numeric characteristics the same way.

## The long-poll lifecycle (the other fragile area)

`Handler.longPoll()` is a self-healing loop; know its shape before touching it.
The exact event order is verified in `debugging-playbook` ("Golden path") — do
not re-derive it from memory. Key invariants:

- One live child process per handler (`this.airControl`). `processTimeout` kills
  it every 60s to recover from silent stalls; `on('close')` reschedules in 5s,
  `on('error')` in 30s.
- `scheduleRestart` is idempotent: it no-ops if `this.shutdown` is set or a
  `restartTimeout` is already pending, so retries never stack.
- `kill(shutdown)` clears both timers and kills the process; `shutdown === true`
  (wired to Homebridge's `shutdown` event in `platform.js`) prevents any further
  restart.
- stdout is line-buffered in `handleStdoutChunk`; a partial line is held until
  its newline. Buffered data over `MAX_STDOUT_BUFFER` (1 MiB) is discarded with a
  warning.

**Unwritten rule (from the maintainer): do not change device I/O blindly.** The
handler and the `aioairctrl` boundary cannot be validated without a real device
or the fake fixture; a plausible-looking edit here is the highest-risk change in
the repo. See `testing-and-validation` for what proof such a change requires.

## Known weak points (stated plainly)

- **The `aioairctrl` boundary is not owned by this repo.** Device comms run the
  third-party [`aioairctrl`](https://pypi.org/project/aioairctrl/) pip package
  (encrypted Philips CoAP). Its behaviour, output format, and flags can change
  outside this codebase; a "device bug" may live there.
- **`rotationSpeed()` returns 0 when no speed entry matches.** `findIndex` yields
  `-1` → `speedIndex` 0 → speed reads as 0%. A wrong/incomplete `speeds` map for a
  model shows up as "fan always at 0/off," not an error. See
  `new-device-bringup`.
- **Timing-sensitive lifecycle tests.** The `polling lifecycle` cases in
  `test/accessories.handler.lifecycle.test.js` use real `setTimeout` delays and
  can flake under CPU contention (observed 2026-07-12). See
  `testing-and-validation`.

## Provenance and maintenance

Facts verified 2026-07-12 against the working tree. Re-verify with:

```bash
# Registration + dynamic-platform flag, and the frozen platform name
grep -n "registerPlatform" index.js
grep -n "PLATFORM_NAME" src/platform.js

# Invariant enforcement points
grep -n "sourceType" eslint.config.js          # commonjs => ESM is a parse error
grep -n '"module"' tsconfig.json               # commonjs
grep -rn "no-console" eslint.config.js || echo "no no-console rule (convention only)"
grep -n "execFile\|spawn" src/accessories/accessories.handler.js
grep -n "generateUUID(device.name)" src/accessories/accessories.setup.js

# Coercion + fragile helpers
grep -n "hapNumber" src/utils/utils.js
grep -n "MAX_STDOUT_BUFFER\|scheduleRestart\|processTimeout" src/accessories/accessories.handler.js
```

If any grep misses, the code moved — update this skill in the same PR (see the
docs-sync table in `change-control-and-docs`).
