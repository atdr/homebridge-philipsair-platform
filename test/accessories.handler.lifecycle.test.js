'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const logger = require('../src/utils/logger');
const Handler = require('../src/accessories/accessories.handler');

const noop = () => {};
const silenceLogger = () => logger.configure({ info: noop, warn: noop, error: noop }, {});

silenceLogger();

//captures what the plugin would actually print at default verbosity, so the
//tests can assert that a failure is visible rather than only recoverable
const captureLogs = () => {
  const entries = { info: [], warn: [], error: [] };
  const record = (bucket) => (message) =>
    entries[bucket].push(message instanceof Error ? message.message : String(message));

  logger.configure({ info: record('info'), warn: record('warn'), error: record('error') }, {});

  return entries;
};

const SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl');
const STREAM_SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl-stream');
const SILENT_SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl-silent');
const BROKEN_SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl-broken');
const STATEFUL_SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl-stateful');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//characteristics resolve to their own names so updates can be asserted by name
const fakeApi = {
  hap: { Service: { AirPurifier: 'AirPurifier' }, Characteristic: new Proxy({}, { get: (target, prop) => prop }) },
};

const makeService = () => {
  const service = { updates: [] };
  service.updateCharacteristic = (characteristic, value) => {
    service.updates.push([characteristic, value]);
    return service;
  };
  return service;
};

const makeHandler = (config = {}) =>
  new Handler(fakeApi, {
    displayName: 'Lifecycle Purifier',
    context: { config: { host: '192.168.1.142', port: 5683, debug: false, ...config } },
  });

const updated = (service, characteristic) => service.updates.filter(([name]) => name === characteristic);

describe('processUpdate', () => {
  it('parses a status line and pushes purifier characteristics', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2' }));

    assert.deepEqual(updated(handler.purifierService, 'Active'), [['Active', 1]]);
    assert.deepEqual(updated(handler.purifierService, 'RotationSpeed'), [['RotationSpeed', 2 * (100 / 3)]]);
  });

  it('survives malformed JSON without updating anything', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();

    await handler.processUpdate('{definitely not json');

    assert.equal(handler.purifierService.updates.length, 0);
  });

  it('clamps the air quality value to the valid HomeKit range', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.airQualityService = makeService();

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2', iaql: 100, pm25: 4 }));
    assert.deepEqual(updated(handler.airQualityService, 'AirQuality'), [['AirQuality', 5]]);

    handler.airQualityService = makeService();
    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2', pm25: 4 }));
    assert.deepEqual(updated(handler.airQualityService, 'AirQuality'), [['AirQuality', 0]]);
  });

  it('skips the wick filter when the device does not report wicksts', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.humidifierService = makeService();
    handler.wickFilterService = makeService();

    const status = { pwr: '1', mode: 'P', cl: false, om: '2', func: 'P', rh: 45, wl: 100 };
    await handler.processUpdate(JSON.stringify(status));
    assert.equal(handler.wickFilterService.updates.length, 0);

    await handler.processUpdate(JSON.stringify({ ...status, wicksts: 2400 }));
    assert.deepEqual(updated(handler.wickFilterService, 'FilterLifeLevel'), [['FilterLifeLevel', 50]]);
  });
});

describe('handleStdoutChunk', () => {
  it('buffers partial lines and processes complete ones', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();

    const status = JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2' });
    handler.handleStdoutChunk(status.slice(0, 10));
    assert.equal(handler.purifierService.updates.length, 0);

    handler.handleStdoutChunk(status.slice(10) + '\n');
    await delay(10);
    assert.ok(updated(handler.purifierService, 'Active').length > 0);
  });

  it('discards buffered data that exceeds the size limit', () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();

    handler.handleStdoutChunk('x'.repeat(1024 * 1024 + 1));

    assert.equal(handler.stdoutBuffer, '');
    assert.equal(handler.purifierService.updates.length, 0);
  });
});

describe('polling lifecycle', () => {
  it('reassembles chunked stdout and stops cleanly on kill', async () => {
    const handler = makeHandler({ aioairctrlPath: SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);

    handler.longPoll();
    await delay(400);

    //the shim splits the JSON line across two writes 50ms apart
    assert.equal(handler.obj.pwr, '1');
    assert.ok(updated(purifier, 'Active').length > 0);

    handler.kill(true);
    await delay(200);

    assert.equal(handler.restartTimeout, null);
    assert.ok(handler.airControl.killed);
  });

  it('leaves a stream that keeps notifying alone past the stall timeout', async () => {
    const handler = makeHandler({ aioairctrlPath: STREAM_SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);

    //the shim notifies every 20ms, so a stall timer reset by incoming data
    //never fires; a fixed process lifetime would kill the stream at 200ms.
    //the 10x margin keeps this from flaking on a loaded CI runner
    handler.stallTimeout = 200;
    handler.restartDelay = 10;

    handler.longPoll();
    const firstPid = handler.airControl.pid;
    await delay(500);

    assert.equal(handler.airControl.pid, firstPid, 'a healthy stream was restarted anyway');
    assert.ok(updated(purifier, 'Active').length > 1);

    handler.kill(true);
    await delay(50);
  });

  it('restarts a stream that accepts the subscription and then goes silent', async () => {
    const handler = makeHandler({ aioairctrlPath: SILENT_SHIM });
    handler.accessory.getService = () => null;

    handler.stallTimeout = 100;
    handler.restartDelay = 10;

    handler.longPoll();
    const firstPid = handler.airControl.pid;
    await delay(400);

    assert.notEqual(handler.airControl.pid, firstPid, 'a stalled stream was never restarted');

    handler.kill(true);
    await delay(50);
  });

  it('does not schedule overlapping restarts', () => {
    const handler = makeHandler({});

    handler.scheduleRestart(1000);
    const first = handler.restartTimeout;
    assert.ok(first);

    handler.scheduleRestart(1000);
    assert.equal(handler.restartTimeout, first);

    handler.kill(true);
    assert.equal(handler.restartTimeout, null);
  });

  it('does not schedule restarts after shutdown', () => {
    const handler = makeHandler({});

    handler.kill(true);
    handler.scheduleRestart(1000);

    assert.equal(handler.restartTimeout, null);
  });
});

//the logger is a module singleton, so these tests must not capture it at the same time
describe('poll failure reporting', { concurrency: 1 }, () => {
  it('warns with the CLI stderr when an installed binary keeps dying', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ aioairctrlPath: BROKEN_SHIM });
    handler.accessory.getService = () => null;
    handler.restartDelay = 10;

    handler.longPoll();
    await delay(400);
    handler.kill(true);

    assert.ok(
      logs.warn.some((line) => line.includes('exited with code 1')),
      `no warning about the failing process, got ${JSON.stringify(logs.warn)}`
    );
    assert.ok(
      logs.error.some((line) => line.includes("No module named 'aioairctrl'")),
      'the CLI stderr was never surfaced'
    );

    //one warning for the run, not one per retry
    assert.equal(logs.warn.filter((line) => line.includes('exited with code 1')).length, 1);
  });

  it('stays quiet while a single failure is still plausibly transient', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ aioairctrlPath: BROKEN_SHIM });
    handler.accessory.getService = () => null;
    //long enough that only the first attempt runs inside the window
    handler.restartDelay = 5000;

    handler.longPoll();
    await delay(200);
    handler.kill(true);

    assert.deepEqual(logs.warn, []);
  });

  it('warns as soon as a subscription is accepted but nothing ever arrives', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ aioairctrlPath: SILENT_SHIM });
    handler.accessory.getService = () => null;
    handler.stallTimeout = 60;
    handler.restartDelay = 5000;

    handler.longPoll();
    await delay(300);
    handler.kill(true);

    assert.ok(
      logs.warn.some((line) => line.includes('No status received from the device')),
      `a silent device was never reported, got ${JSON.stringify(logs.warn)}`
    );
  });

  it('reports recovery once status arrives again', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.loggedFailureKind = 'exit';
    handler.pollFailures = 4;

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2' }));

    assert.deepEqual(logs.info, ['Lifecycle Purifier: Device is responding again']);
    assert.equal(handler.pollFailures, 0);
    assert.equal(handler.loggedFailureKind, null);
  });

  it('does not treat an unparseable stdout line as proof of health', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.loggedFailureKind = 'exit';
    handler.pollFailures = 4;

    //a broken CLI writing its traceback to stdout rather than stderr
    await handler.processUpdate("ModuleNotFoundError: No module named 'aioairctrl'");

    assert.deepEqual(logs.info, [], 'an unparseable line was reported as recovery');
    assert.equal(handler.pollFailures, 4);
    assert.equal(handler.receivedData, false);
    assert.equal(handler.loggedFailureKind, 'exit');
  });

  it('warns again when the kind of failure changes', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    //an earlier spawn failure has already been warned about
    handler.loggedFailureKind = 'spawn';
    //at the escalation threshold, so the exit is reportable on its own merits
    handler.pollFailures = 3;

    handler.reportPollFailure(1);

    assert.ok(
      logs.warn.some((line) => line.includes('without returning any status')),
      `a new kind of failure was suppressed, got ${JSON.stringify(logs.warn)}`
    );
    assert.equal(handler.loggedFailureKind, 'exit');

    //the same kind repeating stays quiet
    logs.warn.length = 0;
    handler.reportPollFailure(1);

    assert.deepEqual(logs.warn, []);
  });

  it('keeps the tail of stderr so a trailing traceback survives the cap', async () => {
    const handler = makeHandler({});

    handler.stderrBuffer = '';
    handler.captureStderr('x'.repeat(8 * 1024));
    handler.captureStderr("ModuleNotFoundError: No module named 'aioairctrl'");

    assert.ok(handler.stderrBuffer.length <= 4 * 1024, 'the stderr capture exceeded its cap');
    assert.ok(handler.stderrBuffer.endsWith("ModuleNotFoundError: No module named 'aioairctrl'"));
  });
});

//the logger is a module singleton, so these tests must not capture it at the same time
describe('write verification', { concurrency: 1 }, () => {
  //a write is only registered once the command has been sent, so these tests
  //stand in for the CLI and drive the verification directly
  const recordingHandler = () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    /** @type {string[][]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args);
    };
    return { handler, sent };
  };

  const status = (extra) => JSON.stringify({ pwr: '0', mode: 'M', cl: false, om: '1', ...extra });

  it('clears a pending write once the device reports the new value', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    await handler.setPurifierActive(true);
    assert.equal(handler.pendingWrites.size, 1);
    sent.length = 0;

    await handler.processUpdate(status({ pwr: '1' }));

    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(sent, [], 'a write the device applied was resent anyway');
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('resends a write the device answered without applying', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    await handler.setPurifierActive(true);
    sent.length = 0;

    await handler.processUpdate(status({ pwr: '0' }));

    assert.equal(sent.length, 1, 'a lost write was never resent');
    assert.ok(sent[0].includes('pwr=1'));
    assert.equal(handler.pendingWrites.get('pwr').attempts, 1);
    assert.deepEqual(logs.warn, [], 'a single retry should not bother the user');

    handler.kill(true);
  });

  it('warns once when the device still disagrees after the retry', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler } = recordingHandler();
    await handler.setPurifierActive(true);

    await handler.processUpdate(status({ pwr: '0' }));
    await handler.processUpdate(status({ pwr: '0' }));

    assert.ok(
      logs.warn.some((line) => line.includes('did not apply pwr=1')),
      `a write the device never applied was never reported, got ${JSON.stringify(logs.warn)}`
    );
    assert.equal(handler.pendingWrites.size, 0);

    //a repeating automation reports once, not on every cycle
    logs.warn.length = 0;
    await handler.setPurifierActive(true);
    await handler.processUpdate(status({ pwr: '0' }));
    await handler.processUpdate(status({ pwr: '0' }));

    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('does not treat a status that predates the write as evidence', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    await handler.setPurifierActive(true);
    sent.length = 0;
    //a status the device sent before it could have seen the command
    handler.pendingWrites.get('pwr').since = Date.now() + 10000;

    await handler.processUpdate(status({ pwr: '0' }));

    assert.deepEqual(sent, [], 'a stale status triggered a resend');
    assert.equal(handler.pendingWrites.size, 1);
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('does not treat a key the device never reports as a disagreement', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    await handler.setPurifierLockPhysicalControls(1);
    sent.length = 0;

    //an AC0850-shaped status: the model reports no 'cl' register at all
    await handler.processUpdate(JSON.stringify({ pwr: '0', D0310A: 2, D0310C: 0 }));

    assert.deepEqual(sent, [], 'a key the device never mentioned triggered a resend');
    assert.deepEqual(logs.warn, [], 'a write the device said nothing about was reported as lost');
    assert.equal(handler.pendingWrites.size, 1, 'the write should still be waiting for evidence');

    handler.kill(true);
  });

  it('does not register a write on a key the device has never reported', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler } = recordingHandler();
    await handler.processUpdate(JSON.stringify({ pwr: '0', D0310A: 2, D0310C: 0 }));

    await handler.setPurifierLockPhysicalControls(1);

    assert.equal(handler.pendingWrites.size, 0, 'an expectation that can never be met was registered');
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('gives up quietly when the device never answers at all', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler } = recordingHandler();
    //silence means this device is slower than the one the delays were chosen
    //against, which is not evidence that the command was lost
    handler.verifyRefreshDelay = 20;
    handler.verifyWindow = 60;

    await handler.setPurifierActive(true);
    await delay(150);

    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('elicits a reading by re-subscribing, without counting it as a failure', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ aioairctrlPath: STREAM_SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);
    handler.stallTimeout = 5000;
    handler.restartDelay = 10;

    handler.longPoll();
    await delay(100);
    const firstPid = handler.airControl.pid;

    handler.requestRefresh();
    await delay(300);

    assert.notEqual(handler.airControl.pid, firstPid, 'the stream was never re-subscribed');
    assert.equal(handler.pollFailures, 0, 'a deliberate refresh counted as a failed poll');
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
    await delay(50);
  });

  it('recovers a dropped write end to end against a stateful device', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const statePath = path.join(os.tmpdir(), `fake-air-${process.pid}-${Date.now()}.json`);
    //the first set is transmitted and never applied, as a lost NON packet is
    fs.writeFileSync(statePath, JSON.stringify({ pwr: '0', mode: 'M', cl: false, om: '1', drops: 1 }));
    process.env.FAKE_STATE_FILE = statePath;

    t.after(() => {
      delete process.env.FAKE_STATE_FILE;
      fs.rmSync(statePath, { force: true });
    });

    const handler = makeHandler({ aioairctrlPath: STATEFUL_SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);
    handler.stallTimeout = 5000;
    handler.restartDelay = 10;
    handler.verifyRefreshDelay = 100;
    handler.verifyWindow = 400;

    handler.longPoll();
    await delay(60);
    await handler.setPurifierActive(true);
    await delay(400);

    assert.equal(handler.obj.pwr, '1', 'the dropped write was never resent');
    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(logs.warn, []);
    assert.deepEqual(updated(purifier, 'Active').at(-1), ['Active', 1]);

    handler.kill(true);
    await delay(50);
  });
});
