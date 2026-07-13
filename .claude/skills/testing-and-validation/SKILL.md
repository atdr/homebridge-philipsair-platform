---
name: testing-and-validation
description: The evidence hierarchy for changes to this plugin (what proof a mapping change vs a lifecycle change vs a docs change requires), node:test writing patterns used here (fake HAP api proxy, service update recorders, the fake-aioairctrl shim, pinned UUID vectors, drift-guard tests), and the live-device testing rules. Load before writing or modifying tests, deciding whether a change is proven, or when a test fails and you're tempted to weaken it. Not for running a triage (debugging-and-operations) or the PR mechanics (change-control-and-docs).
---

# Testing and validation

Audience: contributors and AI agents proving a change works. The test framework rules
(built-in `node:test`, no framework dependencies, "new logic should come with tests")
are in AGENTS.md — doc of record. This skill adds the evidence hierarchy, the house
patterns, and the live-device discipline.

When NOT to use this skill: to diagnose a runtime failure use
`debugging-and-operations`; for what must ship in the same PR use
`change-control-and-docs`.

## Evidence hierarchy: what proof each change requires

Ordered weakest to strongest. A change needs the highest applicable rung, not just the
gates.

1. **Docs-only change**: the six gates (notably `npm run lint:md`, `npm run
format:check`, and `npm test` — the docs drift-guards in `test/docs.test.js` run in
   the suite).
2. **Pure logic/data change** (utils, models, config shaping): gates + unit tests
   asserting the new behaviour, in the matching `test/*.test.js` file.
3. **Handler/lifecycle change** (process spawning, buffering, restarts, characteristic
   pushes): gates + unit tests + a lifecycle test against the `fake-aioairctrl` shim if
   process behaviour changed. PR #3 additionally verified with a real Homebridge run
   (`npm run watch`) against a shim; do that for anything touching spawn/kill/restart
   paths.
4. **Model mapping change** (anything in `accessories.models.js` beyond formatting):
   all of the above **plus live-device verification** by someone who owns the device,
   following the protocol in `new-model-support-campaign`. Unit tests can only prove the
   mapping is applied, not that it is correct for the hardware.
5. **Release plumbing** (workflows, publishing): can only be fully proven by the next
   release; say so in the PR rather than claiming it works (PR #3 did exactly this with
   its OIDC checklist).

**Live-device rules** (maintainer-confirmed, 2026-07-12): never assume a reachable
purifier — CI has none and most agents have none. Tests must run against the shim, never
a real device or the network. The maintainer owns an AC0850 and can be asked to run a
verification protocol; other contributors verify on their own hardware.

## House test patterns (copy these, don't invent)

All in `test/`, run with `npm test` (`node --test`; each file runs in its own process,
so per-file setup does not leak).

- **Silence the singleton logger first.** Every test file starts with
  `logger.configure({ info: noop, warn: noop, error: noop }, {})` (capture instead of
  noop when asserting warnings — see `test/utils.test.js`).
- **Fake HAP api via Proxy** (`test/accessories.handler.lifecycle.test.js`):
  characteristics resolve to their own names, so updates can be asserted by name
  without hap-nodejs:

  ```js
  const fakeApi = {
    hap: { Service: { AirPurifier: 'AirPurifier' }, Characteristic: new Proxy({}, { get: (t, prop) => prop }) },
  };
  ```

- **Service update recorders**: a `makeService()` object whose `updateCharacteristic`
  pushes `[name, value]` pairs and returns itself (chainable). Assert on the recorded
  list.
- **Handlers are constructed directly** with a fake accessory
  (`{ displayName, context: { config } }`) — no platform, no Homebridge boot.
- **The `fake-aioairctrl` shim** (`test/fixtures/fake-aioairctrl`, executable): answers
  `status-observe` with one JSON line deliberately split across two stdout writes 50 ms
  apart, then stays alive until killed. Point a handler at it with
  `aioairctrlPath: SHIM`. Extend the shim rather than spawning anything else.
- **Timer hygiene**: lifecycle tests use short `delay(ms)` waits and MUST end with
  `handler.kill(true)` so no watchdog/restart timer keeps the test process alive.
- **Pinned compatibility vectors**: `test/accessories.setup.test.js` pins the exact
  UUID for 'Livingroom Philips' produced by HAP's generator. If this test fails, your
  change breaks every user's HomeKit setup — fix the change, never the vector.
- **Drift-guard tests** (`test/config.schema.test.js`, `test/docs.test.js`,
  `test/skills.test.js`): read repo
  files, assert a doc/code invariant, fail with a pointed message. When a drift guard
  fails, **the fix is almost always to update the doc, not to weaken the test**
  (comment at the top of `test/docs.test.js`). Copy this shape for new invariants.

## Pitfalls seen in this repo

- The logger is a process-wide singleton: within one test file, a later
  `logger.configure` overrides an earlier one (this is how `test/logger.test.js`
  works). Configure once per file unless testing the logger itself.
- `speeds` matching is stringified-equality; when writing mapping tests, mirror the
  exact types the device reports (numbers for AC0850, words for AC1715).
- Don't assert on debug-level output: it's gated by `debugMode` and off in the test
  configuration.
- A "pre-existing test failure" in a sandbox is usually missing dev dependencies, not a
  real failure — run `npm ci` before believing it (this exact misdiagnosis is recorded
  in PR #19).

## Provenance and maintenance

Verified against the repo at commit 36067a6, 2026-07-12. Re-verify:

```bash
npm test                                            # suite green (64 tests as of 2026-07-12)
ls test/fixtures/fake-aioairctrl && test -x test/fixtures/fake-aioairctrl && echo executable
grep -rn "logger.configure" test/ | head            # per-file logger silencing pattern
grep -n "e0ab97d2" test/accessories.setup.test.js   # pinned UUID vector intact
```
