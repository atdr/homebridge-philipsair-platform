---
name: debugging-and-operations
description: Triage playbook and day-2 operations for this plugin - the expected startup/log sequence, symptom-to-cause table with discriminating commands (aioairctrl not found, no HomeKit updates, parse failures, wrong speeds, accessories re-added), the polling/restart loop timings, log access, what state survives restarts and upgrades, and failure archaeology from git history. Load when something is broken at runtime, a user reports an issue, or you need to operate/upgrade a live install. Not for adding device models (new-model-support-campaign) or understanding protocol semantics (aioairctrl-and-device-protocol).
---

# Debugging and operations

Audience: contributors and AI agents triaging a live problem, often reported by a
non-technical user. Commands are copy-pasteable; replace `<hbuser>` with the account
running Homebridge (often `homebridge` or `pi`) and `<ip>` with the device address.

When NOT to use this skill: installation steps live in the README (doc of record);
protocol/key semantics in `aioairctrl-and-device-protocol`; adding a new model in
`new-model-support-campaign`.

## Golden path: what a healthy startup looks like

Sequence verified against the code (`src/platform.js` → `accessories.setup.js` →
`accessories.service.js` → `accessories.handler.js`), in this order per device:

1. Homebridge loads the plugin; cached accessories are restored silently
   (`configureAccessory`).
2. On Homebridge's `didFinishLaunching`: `Initializing device...` (device validated and
   keyed by UUID).
3. `Configuring new accessory...` (first ever run) **or** `Configuring cached
accessory...` (every later run).
4. `Setup accessory...`
5. `Initializing <device name>` (services wired), then the handler spawns
   `aioairctrl -H <ip> -P <port> status-observe -J`.
6. With `debug: true`: each status line logs as `[DEBUG] <name>: {"pwr":"1",...}` and
   HomeKit characteristics update.

Steady state is a deliberate restart loop: a 60 s watchdog kills the observe process
(recovers from silent stalls), the `close` handler logs
`[DEBUG] <name>: airControl process exited with code ... (not expected)` and respawns after
5 s. So the observe process cycles roughly every 65 s — **this is healthy, not a
crash**. Spawn failures retry after 30 s and log only once (`spawnErrorLogged`).

First move on any runtime issue: set `debug: true` in the platform config (Homebridge
UI → plugin config, or config.json) and restart. Log access: Homebridge UI log page, or
`journalctl -u homebridge -f`, or `hb-service logs`, depending on the install (standard
Homebridge, not plugin-specific).

## Symptom → triage

| Symptom (exact log text where applicable)                            | Likely cause                                                                                         | Discriminating check                                                                                                                                                                         | Fix                                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `aioairctrl not found. Install it with 'pipx install aioairctrl'...` | Binary missing or not on the Homebridge user's PATH                                                  | `sudo -u <hbuser> aioairctrl --help`                                                                                                                                                         | README "aioairctrl not found" section (doc of record): install per README or set `aioairctrlPath`                 |
| `Failed to run polling process` (once, then silence)                 | Same as above, but on the observe spawn; retries every 30 s                                          | Same as above                                                                                                                                                                                | Same as above                                                                                                     |
| No errors, but Home app state is frozen/stale                        | Observe stream produces no lines: device off network, wrong host/port, or CLI failing per-connection | `sudo -u <hbuser> aioairctrl -H <ip> -P 5683 status-observe -J` — a healthy device prints a JSON line within seconds. No output → ping the device; nonzero exit → read its stderr (add `-D`) | Fix network/config; if the CLI itself fails, the problem is upstream of this repo                                 |
| `Failed to parse device response`                                    | Non-JSON line on stdout                                                                              | With `debug: true`, look at the offending line in the log just before the warning                                                                                                            | If aioairctrl started printing diagnostics to stdout, that's an upstream change — pin/downgrade and file upstream |
| `Device response exceeded buffer limit, discarding buffered data`    | >1 MB of stdout without a newline                                                                    | Run the manual observe command and inspect raw output                                                                                                                                        | Same as above; the cap protects Homebridge memory (PR #5)                                                         |
| Purifier shows RotationSpeed 0 / wrong speed while running           | Device status matches no entry in the model's `speeds`                                               | Compare a captured status line against `speeds` for the model in `src/accessories/accessories.models.js` (matching is exact stringified equality on ALL keys of an entry)                    | Fix the model mapping via `new-model-support-campaign`                                                            |
| Set commands (power, speed) do nothing, no error                     | Wrong register/value for this model, or missing `-I` flag                                            | With `debug: true`, copy the logged `CMD: aioairctrl ...` line and run it as `<hbuser>`; then watch `status-observe` for the change                                                          | Model mapping issue → `new-model-support-campaign`                                                                |
| `An error occured during changing ... !` + error                     | The one-shot `set` invocation failed                                                                 | Run the logged `CMD:` line manually                                                                                                                                                          | Read the CLI's stderr; usually network or model mapping                                                           |
| HomeKit "characteristic ... warning" in Homebridge log               | A raw device value reached HomeKit unclamped                                                         | Find which characteristic; check the code path pushes through `hapNumber` (`src/utils/utils.js`)                                                                                             | Route the value through `hapNumber` with the characteristic's range                                               |
| Accessory vanished from its room / re-added as new                   | Its UUID changed: device renamed in config, or plugin identifier changed                             | `git log -p config.schema.json src/platform.js`; ask the user if they renamed the device                                                                                                     | Restore the old name; warn users before renames. See invariants in `architecture-and-invariants`                  |
| One device works, a same-named duplicate is skipped                  | `Multiple devices are configured with this name.` warning                                            | Check config for duplicate `name` values                                                                                                                                                     | Give devices unique names (UUID is name-derived)                                                                  |

## State: what survives what

- **Survives restart and plugin upgrade**: HomeKit pairing, room/scene/automation
  assignments (keyed to the name-derived accessory UUID), Homebridge's
  `cachedAccessories` store. `accessory.context.config` is overwritten from the live
  config on every launch (`setupAccessory` in `src/platform.js`), so config edits win.
- **Destroyed by**: renaming a device in config (new UUID → HomeKit treats it as a new
  accessory), changing the npm package name (new plugin identifier → cached accessories
  orphaned), or the user deleting Homebridge's persist/cache directories.
- Nothing else is persisted by this plugin — there is no database, no state files.

Upgrade loop for a live install: update via the Homebridge UI Plugins page (or
`sudo npm install -g @atdr/homebridge-philipsair-platform@latest`), restart Homebridge,
then confirm the golden-path sequence above. Local development uses `npm run watch`
(see CONTRIBUTING.md).

## Failure archaeology (mined from git history)

| Symptom back then                                                               | Root cause                                                                                                              | Fix                                                                                 | Status                                                                                                                            |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ModuleNotFoundError: No module named 'aioairctrl'` with a working pipx install | Old code ran `python3 lib/pyaircontrol.py`, which imported the module from the **system** interpreter; pipx isolates it | Issue #1 → PR #3 (a9f8715): invoke the `aioairctrl` executable directly             | Fixed. The old README workaround `sudo pip install --break-system-packages` is obsolete — do not recommend it as the primary path |
| Poller died once and never came back                                            | Restart listener was on `stderr.on('exit')`, an event that never fires                                                  | PR #3: proper `error`/`close` handlers on the child process                         | Fixed. **Fenced: do not hang lifecycle logic on stream events**                                                                   |
| Intermittent `JSON.parse` failures on healthy devices                           | Status lines split/merged across stdout chunks                                                                          | PR #3: line buffering (`handleStdoutChunk`)                                         | Fixed + regression-tested                                                                                                         |
| HomeKit warning spam every poll                                                 | `NaN` pushed when a filter key was absent                                                                               | 6f81c9a (fltsts) and PR #3 (wicksts): `!== undefined` guards + `hapNumber`          | Fixed + regression-tested                                                                                                         |
| AC0850 turbo set the wrong speed                                                | Register value guessed (`D0310A: 3`) instead of observed (2)                                                            | 7417a2d                                                                             | Fixed. Lesson: derive mappings from observed status dumps, never by analogy                                                       |
| AC1715 mode never applied                                                       | Wrong register guess (`D03-11` vs `D03-12`)                                                                             | bf691b0                                                                             | Fixed. Same lesson                                                                                                                |
| Values with spaces broke commands                                               | Commands went through a shell string; quoting hacks followed (bf691b0, 358fb82)                                         | PR #3: `execFile`/`spawn` argument arrays                                           | Fixed. **Fenced: never rebuild commands as shell strings**                                                                        |
| Unbounded memory growth possible from device stdout                             | No buffer cap                                                                                                           | PR #5 (9ce2128): 1 MB cap                                                           | Fixed + tested                                                                                                                    |
| Accessories orphaned after fork                                                 | `registerPlatformAccessories` used the pre-fork unscoped plugin name                                                    | PR #3: identifier derived from `package.json`; one-time re-add documented in README | Fixed                                                                                                                             |

## Provenance and maintenance

Verified against the repo at commit 36067a6, 2026-07-12. Re-verify:

```bash
grep -n "60 \* 1000\|30 \* 1000\|5 \* 1000" src/accessories/accessories.handler.js  # watchdog/retry timings
grep -n "Failed to run polling process\|Failed to parse device response\|exceeded buffer limit" src/accessories/accessories.handler.js  # exact log strings
grep -n "Initializing device\|Configuring new accessory\|Setup accessory" src/platform.js src/accessories/accessories.setup.js  # startup log order
grep -n "context.config" src/platform.js  # config still overwritten per launch
```
