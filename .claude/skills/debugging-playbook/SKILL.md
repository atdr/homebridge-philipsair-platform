---
name: debugging-playbook
description: >-
  Triage playbook for a misbehaving Philips air accessory: nothing updating in
  the Home app, "aioairctrl not found", parse failures, a fan stuck at 0%, a
  restart loop, or a dead humidifier. Load when diagnosing runtime behaviour or a
  user bug report. Contains the golden-path event sequence (verified against
  accessories.handler.js), a symptom to cause table with exact commands, and
  failure archaeology mined from git history.
---

# Debugging playbook

Diagnose first, change second. This skill is for figuring out _what is wrong_ at
runtime. Once you know the fix:

- Structural / invariant questions → `architecture-and-invariants`.
- What a value or key means → `homekit-device-reference`.
- A new/unsupported model's mappings → `new-device-bringup`.
- Proving the fix and landing it → `testing-and-validation`, then
  `change-control-and-docs`.

## First moves: see the logs, then see the device

1. **Turn on debug.** Set `"debug": true` on the platform in the Homebridge
   config and restart. This enables `logger.debug` output _and_ appends `-D` to
   every `aioairctrl` call.
2. **Read the Homebridge log** wherever this install sends it — the Homebridge UI
   "Logs" page, `journalctl -u homebridge -f` (systemd), `docker logs -f
<container>`, etc. Log lines are prefixed with the accessory display name.
3. **Talk to the device directly**, bypassing the plugin, as the Homebridge user:

   ```bash
   sudo -u homebridge aioairctrl -H <device-ip> -P 5683 status-observe -J
   # Ctrl-C after the first JSON line prints
   ```

   This one command discriminates most failures: whether the binary runs, whether
   the device answers, and what raw keys it sends.

## Golden path (expected event order)

Verified against `Handler.longPoll` / `handleStdoutChunk` / `processUpdate` in
`accessories.handler.js` — do not reorder from memory. On a healthy device you
should see this cycle:

1. `longPoll()` resolves the HomeKit services, clears any pending
   `processTimeout`, empties `stdoutBuffer`, and
   `spawn(binary, [...args, 'status-observe', '-J'])`.
2. stdout arrives in chunks → `handleStdoutChunk` appends to `stdoutBuffer` and
   splits on `\n`; a trailing partial line is held for the next chunk.
3. Each complete line → `processUpdate(line)` → `handleResponse(JSON.parse(line))`
   sets `this.obj` and applies the model `keyMaps`/`valueMaps`.
4. `processUpdate` then pushes values onto the HomeKit characteristics (purifier
   always; air-quality/temp/humidity/light/humidifier/filters when their services
   exist).
5. After **60 s**, `processTimeout` kills the child to defeat silent stalls →
   `on('close')` logs `airControl process exited with code <n> (...)` and, if not
   shutting down, `scheduleRestart(5 * 1000)` → back to step 1.

A failed spawn instead fires `on('error')`: the first failure logs
`Failed to run polling process`, subsequent ones drop to debug (to avoid spamming
every 30 s), and `scheduleRestart(30 * 1000)` retries.

## Symptom → cause → discriminating test

Log strings below are quoted **exactly** (typos and all) so you can grep them.

| Symptom                                                                                                                        | Likely cause                                                                                     | Discriminating test / fix                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log: `<bin> not found. Install it with 'pipx install aioairctrl' ...`, or `Failed to run polling process`                      | `aioairctrl` missing / not on the Homebridge user's PATH (ENOENT)                                | `sudo -u homebridge aioairctrl --help`; `which aioairctrl`. Fix: install it for that user, or set `aioairctrlPath` to the full path (pipx installs to `~/.local/bin`). See README "aioairctrl not found". |
| Nothing updates in Home, **no** error logged; restart every 5 s                                                                | Process starts but exits immediately (wrong host/port, device unreachable, auth)                 | Run the manual `status-observe -J` above with `-D`. If it hangs or errors there, it is the device/CLI, not the plugin.                                                                                    |
| Nothing updates, process stays up, then refreshes each minute                                                                  | Observe stream connected but silent (device stall) — the 60 s `processTimeout` is doing its job  | Confirm the manual command also goes silent; this is expected recovery, not a plugin bug.                                                                                                                 |
| Log: `Failed to parse device response`                                                                                         | A stdout line was not valid JSON (CLI printed an error/banner, or wrong output flag)             | Run the manual command and read the raw line. Confirm `-J` is present in the invocation.                                                                                                                  |
| Log: `Device response exceeded buffer limit, discarding buffered data`                                                         | >1 MiB streamed without a newline (misbehaving/compromised device or CLI)                        | Expected safety cap (`MAX_STDOUT_BUFFER`, added by PR #5). Investigate the device/CLI, not the plugin.                                                                                                    |
| Fan shows **0% / off** while the device is clearly running                                                                     | `rotationSpeed()` found no matching `speeds` entry → index `-1` → 0%                             | Dump status (manual command), compare the reported speed keys to the model's `speeds` in `accessories.models.js`. This is the classic unmapped-model tell → `new-device-bringup`.                         |
| Log: `Error updating characteristics from device response`                                                                     | A characteristic rejected a value (out of range / undefined), stricter under Homebridge 2        | Check the offending value is fed through `hapNumber(value,min,max)` or a clamp (`homekit-device-reference`).                                                                                              |
| Humidifier shows inactive though it is humidifying                                                                             | `func !== 'PH'`, or `wl === 0` (water-empty logic forces it off and pushes the purifier to auto) | Check `func` and `wl` in the raw status.                                                                                                                                                                  |
| A `set` did nothing; log: `An error occured during changing ... state!` (note: `occured` / `humidifer` are the real spellings) | The `set` subprocess failed (device rejected the write, or binary issue)                         | Look at the `error` line that follows it; reproduce with `aioairctrl ... set <key>=<value>`.                                                                                                              |

## Failure archaeology (mined from git history)

History is short and mostly squash-merged, so several entries carry only a title.
Do not invent rationale that the commit does not record.

| Symptom / area                                                                                               | Root cause                                                              | Fix                                                                                                                                                                                            | Status                      |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Runtime bugs + no direct device path (old code bundled a Python helper `lib/pyaircontrol.py`)                | Reworked to invoke the `aioairctrl` CLI directly and fixed runtime bugs | PR #3 `a9f8715` `feat: invoke aioairctrl directly, fix runtime bugs, add tests and CI` — **squash commit records no itemised rationale** for the individual bug fixes                          | Fixed; current architecture |
| Unbounded stdout buffer; loosely-validated host/config; CI token could carry write scope; dev-dep advisories | Security review                                                         | PR #5 `9ce2128` `fix: security hardening ...` — added the 1 MiB `MAX_STDOUT_BUFFER` cap, `validHost` rejection rules, `contents: read` CI token, npm-audit fixes (detailed in the commit body) | Fixed                       |
| Users picking model strings that don't match a mapping                                                       | Added a model typeahead of tested devices in `config.schema.json`       | PR #19 `20daa19` `feat(config): add model typeahead ...` (title only)                                                                                                                          | Fixed                       |
| Docs silently drifting from schema/models                                                                    | Added mechanical drift-guard tests                                      | PR #20 `36067a6` `docs: review docs and add drift-prevention gates` → `test/docs.test.js`, `test/config.schema.test.js`                                                                        | Fixed                       |
| CI jobs erroring on edited events after a squash merge                                                       | Commit range no longer resolves once the PR is closed                   | `b6ad63d` `ci: skip pull_request jobs for closed PRs` + the `if: ... pull_request.state == 'open'` guards in `ci.yml`                                                                          | Fixed                       |

### Fenced-off wrong paths (do not reintroduce)

- **Do not bundle a protocol implementation.** PR #3 deleted the in-repo Python
  helper (`lib/pyaircontrol.py`) in favour of shelling out to `aioairctrl`.
  Re-implementing the Philips CoAP protocol inside this repo is a reverted
  direction.
- **Do not remove the stdout buffer cap or loosen `validHost`.** Both are
  deliberate hardening from the PR #5 security review, not incidental code.
- **Do not build device commands with a shell string.** Keep `execFile`/`spawn`
  with argument arrays (see `architecture-and-invariants`, invariant 3).

## Provenance and maintenance

Facts verified 2026-07-12 against the working tree and git history. Re-verify:

```bash
# Exact log strings this playbook greps for
grep -n "not found\|Failed to run polling process\|Failed to parse device response\|exceeded buffer limit\|Error updating characteristics" src/accessories/accessories.handler.js

# Golden-path anchors and timings
grep -n "status-observe\|processTimeout\|scheduleRestart\|60 \* 1000\|5 \* 1000\|30 \* 1000" src/accessories/accessories.handler.js

# Archaeology commits still present
git log --oneline | grep -E "a9f8715|9ce2128|20daa19|36067a6|b6ad63d"
```
