---
name: testing-and-validation
description: >-
  What proof each kind of change needs, how to write node:test tests here, the
  fake-aioairctrl fixture and its timing pitfalls, and the drift-check tests that
  keep docs/schema in sync with code. Load when adding or changing behaviour,
  writing or fixing tests, deciding whether a change is validated enough to
  commit, or when a lifecycle test flakes.
---

# Testing and validation

Decide what evidence a change owes before you commit it, then produce that
evidence. This repo uses only the built-in `node:test` runner — no Jest, Mocha,
or other framework dependencies.

- To ship the change once it's proven, use `change-control-and-docs`.
- For a new model's mappings specifically, `new-device-bringup` defines the
  extra validation that task needs.

## Evidence hierarchy (what proof each change owes)

Match the proof to the risk. Higher rows include the obligations of the rows
above.

1. **Pure data / logic** — `accessories.models.js` maps, `utils.js` helpers,
   handler mapping (`handleCommand`, `handleResponse`, `rotationSpeed`,
   `speedsMinStep`). Cheapest to test and the easiest to get right. **Required:**
   a `node:test` unit test. This is the bulk of the existing suite.
2. **Characteristic-update logic** — `processUpdate` and the `set*` handlers.
   **Required:** a test that drives the method with a fake HomeKit service and
   asserts the resulting `updateCharacteristic` calls (pattern below).
3. **Process lifecycle** — `longPoll`, `handleStdoutChunk`, `scheduleRestart`,
   `kill`. **Required:** a test using the `fake-aioairctrl` fixture (below).
   Mind the timing caveat.
4. **Real device I/O** — anything whose correctness depends on what a physical
   Philips unit actually does over `aioairctrl`. **Cannot be proven in CI.**
   Per the maintainer's unwritten rule _(do not change device I/O blindly)_, a
   change at this level owes a manual smoke test against real hardware before it
   is released — `sudo -u homebridge aioairctrl -H <ip> -P 5683 status-observe -J`
   plus a live `set`, and a Home-app check. State plainly in the PR when a change
   has only been validated against the fixture, not real hardware.

## node:test patterns used here

Every test file is CommonJS and self-contained. The idioms, from
`test/accessories.handler.lifecycle.test.js` and friends:

```js
'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const logger = require('../src/utils/logger');
const Handler = require('../src/accessories/accessories.handler');

// silence the singleton logger for the whole file
const noop = () => {};
logger.configure({ info: noop, warn: noop, error: noop }, {});

// characteristics resolve to their own names so updates assert by name
const fakeApi = {
  hap: { Service: {}, Characteristic: new Proxy({}, { get: (_t, p) => p }) },
};

// a fake HomeKit service that records updateCharacteristic calls
const makeService = () => {
  const service = { updates: [] };
  service.updateCharacteristic = (c, v) => (service.updates.push([c, v]), service);
  return service;
};

const makeHandler = (config = {}) =>
  new Handler(fakeApi, {
    displayName: 'Test',
    context: { config: { host: '192.168.1.142', port: 5683, debug: false, ...config } },
  });
```

Then assign the services you want to observe (`handler.purifierService =
makeService()`), call the method, and assert against `service.updates`. Run a
single file with `node --test test/<file>.test.js`.

## The fake-aioairctrl fixture

`test/fixtures/fake-aioairctrl` is an executable Node script that stands in for
the real CLI. It:

- exits `2` unless invoked with `status-observe` (so non-observe calls fail
  loudly);
- emits one JSON status line, **deliberately split across two stdout writes 50 ms
  apart**, to exercise the plugin's chunk buffering;
- then stays alive (a 1 s interval) until the handler kills it.

Use it by pointing the handler's binary at it:

```js
const path = require('node:path');
const SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl');
const handler = makeHandler({ aioairctrlPath: SHIM });
handler.longPoll();
```

To extend a lifecycle scenario, edit the fixture's `status` object or add
branches on `process.argv`. Keep it dependency-free and executable
(`#!/usr/bin/env node`, `chmod +x`).

## Drift-check tests (copy this pattern for docs/schema)

Two suites turn "keep the docs in sync" into CI failures instead of review
burden. When they fail, the fix is almost always to update the doc/schema, **not**
to weaken the test:

- `test/config.schema.test.js` — asserts every `mappedModels` entry from
  `accessories.models.js` appears in the `devices[].model` typeahead source.
- `test/docs.test.js` — asserts (a) every `config.schema.json` property is in the
  README field table and vice versa, (b) `example-config.json` uses only schema
  properties, and (c) every mapped model is listed in the README "Tested devices"
  section.

Adding a config option, model, or device? Add or extend a check here in the same
PR so drift can't recur. This is the mechanism the docs-sync table in
`change-control-and-docs` points at.

## Isolation pitfalls

- **The logger is a global singleton.** Tests configure it to no-ops at module
  load. A test that needs to _observe_ log calls must pass its own spies to
  `logger.configure` and accept that it mutates shared state for later tests in
  the same process.
- **Lifecycle tests use real timers and can flake.** The `polling lifecycle`
  cases rely on `setTimeout` delays (e.g. 400 ms / 200 ms) racing the fixture's
  50 ms split. Under CPU contention they can fail spuriously — this was observed
  on 2026-07-12 when the suite ran concurrently with `npm ci`. If one flakes,
  re-run it alone (`node --test test/accessories.handler.lifecycle.test.js`)
  before assuming a regression. Do **not** shrink these delays to speed the suite
  up; the margins are load-bearing.
- **`processUpdate` only updates services you attached.** It guards each optional
  service with `if (this.<x>Service)`, so a test that doesn't set, say,
  `humidifierService` simply exercises the purifier path — assign exactly the
  services your assertion needs.

## Provenance and maintenance

Facts verified 2026-07-12 against the working tree (suite: 64 tests pass with
`node --test`). Re-verify:

```bash
node --test                 # full suite
grep -n "status-observe\|split\|status.slice" test/fixtures/fake-aioairctrl
grep -n "mappedModels\|typeahead\|README" test/config.schema.test.js test/docs.test.js
grep -rn "require('node:test')" test | head   # confirms no external test framework
```
