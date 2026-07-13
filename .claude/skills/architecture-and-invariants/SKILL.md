---
name: architecture-and-invariants
description: Load-bearing design decisions, invariants, and known weak points of this Homebridge plugin. Load before changing src/platform.js, src/accessories/*, package identity, UUID/naming logic, or dependency policy; before any refactor; or when you need the WHY behind the external aioairctrl CLI, the zero-runtime-dependency rule, or the accessory-identity rules. Not a module map (AGENTS.md has that) and not a debugging guide (use debugging-and-operations).
---

# Architecture and invariants

Audience: engineers and AI agents changing this plugin's source. AGENTS.md is the doc of
record for the module map, code style, and workflow — read it first. This skill adds what
AGENTS.md deliberately leaves out: why the load-bearing decisions were made, which
invariants must never break, where each one is enforced, and where the code is weak.

When NOT to use this skill: for triage of a live problem use `debugging-and-operations`;
for device protocol details use `aioairctrl-and-device-protocol`; for adding a new
Philips model use `new-model-support-campaign`.

## Load-bearing decisions and their WHY

### 1. Device I/O goes through the external `aioairctrl` CLI — never reimplement it

Philips purifiers speak an **encrypted CoAP** (Constrained Application Protocol, a UDP
protocol for small devices) dialect. This repo does not implement it. All device I/O
shells out to the [`aioairctrl`](https://pypi.org/project/aioairctrl/) Python CLI from
`src/accessories/accessories.handler.js` (`sendCMD` uses `execFile`, `longPoll` uses
`spawn`).

- WHY: the encryption/protocol maintenance burden lives in a dedicated upstream project;
  this plugin stays a thin HomeKit mapping layer. Decided in issue #1 / PR #3
  (commit a9f8715).
- Corollary (unwritten rule, maintainer-confirmed 2026-07-12): **the published npm
  package has zero runtime dependencies** — `package.json` has only `devDependencies`.
  Do not add a runtime dependency (e.g. a CoAP or crypto library) without explicit
  maintainer sign-off.

### 2. Child processes get argument arrays — never a shell string

`execFile(this.binary, args, ...)` and `spawn(this.binary, [...])` take arrays. The old
code built a shell string (`exec(args.join(' '))`), which forced value-quoting
workarounds (commits bf691b0, 358fb82) and let config values reach a shell. PR #3
removed the shell; PR #5 (commit 9ce2128) additionally made `validHost` in
`src/utils/utils.js` reject hosts that start with `-` or contain whitespace so a config
value can never be parsed as a CLI flag. **Fenced wrong path: any change that routes a
command through a shell string, or that reintroduces manual quoting of values.**

### 3. Per-model behaviour is pure data in `accessories.models.js`

Model differences (speed steps, register names, value translations, extra CLI flags)
live in one data file, `src/accessories/accessories.models.js`, consumed by the handler
constructor. Supporting a new device is a data change plus docs, not new logic (PR #3
extracted this from duplicated `if (model == ...)` blocks in the handler; PR #19
explains the design). See `new-model-support-campaign` for the procedure.

### 4. The plugin identifier and accessory UUIDs are compatibility surfaces

- The Homebridge plugin identifier is the **package name**
  (`@atdr/homebridge-philipsair-platform`), taken from `package.json` in both `index.js`
  and `src/platform.js`. Pre-fork versions registered accessories under a different
  identifier; fixing that (PR #3) cost users a one-time accessory re-add, documented in
  README "Upgrading from v1.1.0 or earlier".
- Accessory UUIDs are generated from the configured device `name`: `src/platform.js`
  passes `api.hap.uuid.generate` into `AccessoriesSetup`, which calls it as
  `generateUUID(device.name)` (`src/accessories/accessories.setup.js`).

## Invariants and enforcement points

| Invariant                                                                                                              | Where enforced                                                                                                                        | Breaks what if violated                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Accessory UUID is derived from the configured device `name` with HAP's sha1 algorithm                                  | Pinned-vector test in `test/accessories.setup.test.js` ("historical name-derived UUID")                                               | Every user's HomeKit rooms, scenes, automations (accessories re-pair)                            |
| Plugin identifier == package name                                                                                      | `index.js` and `src/platform.js` both read `package.json`; no test                                                                    | Cached accessories orphaned on upgrade                                                           |
| In `Handler.handleCommand`, value translation happens BEFORE key translation (value maps are keyed by the generic key) | `handleCommand` in `accessories.handler.js`; test "maps keys and values through the model maps" in `test/accessories.handler.test.js` | Model value maps silently stop applying (this exact bug was fixed in commit bf691b0)             |
| `status-observe` stdout is line-buffered and capped at 1 MB (`MAX_STDOUT_BUFFER`)                                      | `handleStdoutChunk` in `accessories.handler.js`; tests in `test/accessories.handler.lifecycle.test.js`                                | Memory exhaustion from a misbehaving device/CLI (PR #5)                                          |
| Values pushed to HomeKit are finite and clamped to the characteristic's range                                          | `hapNumber` in `src/utils/utils.js`; `test/utils.test.js`                                                                             | Homebridge 2's strict validation logs a warning on every poll (PR #3 fixed a `wicksts` NaN case) |
| Hosts that look like CLI flags are rejected; ports validated to 1–65535                                                | `validHost` / `validPort` in `src/utils/utils.js`; `test/utils.test.js`                                                               | Config values interpreted as `aioairctrl` arguments (PR #5)                                      |
| Every model with a dedicated mapping appears in the config UI typeahead and the README tested-devices list             | `test/config.schema.test.js`, `test/docs.test.js`                                                                                     | Docs/UI drift from code (PR #19, #20)                                                            |
| CommonJS only, `'use strict'`, no runtime deps, singleton logger                                                       | AGENTS.md (doc of record); eslint `sourceType: 'commonjs'`                                                                            | See AGENTS.md                                                                                    |

The docs-sync invariants and how to add new mechanical guards are covered in
`change-control-and-docs`.

## Known weak points (2026-07-12)

- **Humidifier logic is fragile and unverified on hardware** (maintainer-confirmed).
  The `rhset`/water-level branches in `accessories.handler.js`
  (`setHumidifierActive`, `setHumidifierTargetState`, and the humidifier block of
  `processUpdate`) duplicate a hard-coded rhset→percent table in three places, contain
  commented-out methods (`setHumidifierCurrentState`, `setHumidifierThreshold`), and no
  current tester owns a humidifier-capable device. **Do not refactor these
  opportunistically**; touch them only with a live device to verify against.
- **AC3829 is unverified with the current configuration approach** (README "Not yet
  confirmed" list). Its README example config is plausible but untested.
- Speed matching in `Handler.rotationSpeed` compares stringified values for exact
  equality against the model's `speeds` entries; a device reporting an unexpected value
  matches nothing and reports speed index 0 (RotationSpeed 0) with no warning.
- `setLightOn`/`setLightBrightness` guard against each other with the
  `settingLightState`/`settingBrightness` flags, dropping one command when both fire
  (inferred purpose: HomeKit sends On and Brightness together; commit records no
  rationale). Treat the mutual exclusion as intentional until proven otherwise.
- When the humidifier water tank is empty (`wl == 0`), `processUpdate` actively sends a
  mode command to the device (`setPurifierTargetState(true)`) — a read path that writes.
  Inherited behaviour; commit records no rationale.

## Provenance and maintenance

Verified against the repo at commit 36067a6, 2026-07-12. Re-verify volatile claims:

```bash
node -e "console.log(Object.keys(require('./package.json').dependencies || {}).length)"  # 0 = still no runtime deps
grep -n "execFile\|spawn(" src/accessories/accessories.handler.js                        # arg-array invocations only
grep -n "MAX_STDOUT_BUFFER" src/accessories/accessories.handler.js                       # buffer cap still present
grep -n "uuid.generate" src/platform.js; grep -n "generateUUID" src/accessories/accessories.setup.js  # UUID derivation path
grep -rn "historical name-derived UUID" test/                                            # pinned-vector test still exists
grep -n "Not yet confirmed" README.md                                                    # AC3829 verification status
```
