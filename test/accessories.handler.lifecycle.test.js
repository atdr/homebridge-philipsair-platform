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
const ONCE_SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl-once');
const CLI_ERROR_SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl-cli-error');
const DEBUG_LOG_SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl-debug-log');
const HANG_SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl-hang');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

//waits for the first status to be processed, since a shim is a node process and
//its startup is slower than the timers these tests shorten
const answered = async (handler, timeout = 2000) => {
  for (let waited = 0; waited < timeout; waited += 20) {
    if (handler.obj.pwr !== undefined) {
      return;
    }
    await delay(20);
  }
  throw new Error('the shim never answered');
};

//characteristics resolve to their own names so updates can be asserted by name
const fakeApi = {
  hap: { Service: { AirPurifier: 'AirPurifier' }, Characteristic: new Proxy({}, { get: (target, prop) => prop }) },
  updatePlatformAccessories: () => {},
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

describe('adaptive refresh', () => {
  const status = JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2' });

  //the refresh is a trade: a fresh subscription elicits a reading, and on some
  //devices it costs far more than waiting for one. these drive the price
  //directly rather than through wall-clock timing, which CI cannot hold steady.
  //the price is the gap between the kill and the reading, so both ends have to
  //come off one frozen clock: processUpdate stamps its own Date.now(), and the
  //millisecond a loaded runner spends reaching it lands in the cost otherwise
  const priced = (handler, cost) => {
    handler.purifierService = makeService();

    const now = Date.now();
    const realNow = Date.now;

    Date.now = () => now;
    handler.refreshKilledAt = now - cost;

    return handler.processUpdate(status).finally(() => {
      Date.now = realNow;
    });
  };

  it('moves the wait toward what a refresh measured to cost', async () => {
    const handler = makeHandler({ refreshInterval: 60 });

    //from the configured interval as the prior, half the way to the measurement
    await priced(handler, 140 * 1000);

    assert.equal(handler.refreshDelay(), 100 * 1000);
  });

  it('trusts an expensive refresh more than a cheap one', async () => {
    //#71's lesson is that the expensive mistake is being too eager, so an equal
    //gap in each direction must not move the wait equally
    const dearer = makeHandler({ refreshInterval: 60 });
    const cheaper = makeHandler({ refreshInterval: 60 });
    dearer.refreshCost = 200 * 1000;
    cheaper.refreshCost = 200 * 1000;

    await priced(dearer, 280 * 1000);
    await priced(cheaper, 120 * 1000);

    const rise = dearer.refreshDelay() - 200 * 1000;
    const fall = 200 * 1000 - cheaper.refreshDelay();

    assert.ok(rise > fall, `a ${rise}ms rise did not outweigh a ${fall}ms fall over the same gap`);
  });

  it('never lets the refresh outlast the fault detector', async () => {
    const handler = makeHandler({ refreshInterval: 60 });

    for (let i = 0; i < 20; i += 1) {
      await priced(handler, 600 * 1000);
      assert.ok(
        handler.refreshDelay() <= handler.stallTimeout,
        `waited ${handler.refreshDelay()}ms, past the ${handler.stallTimeout}ms the fault detector allows`
      );
    }

    //the average approaches the ceiling rather than landing on it, which is the
    //point: the clamp is the guarantee, not the arithmetic
    assert.ok(handler.refreshDelay() > handler.stallTimeout * 0.99);
  });

  it('holds the configured interval as a floor', async () => {
    const handler = makeHandler({ refreshInterval: 60 });

    await priced(handler, 1000);

    assert.equal(handler.refreshDelay(), 60 * 1000);
  });

  it('prices nothing when no refresh killed the stream', async () => {
    const handler = makeHandler({ refreshInterval: 60 });
    handler.purifierService = makeService();

    await handler.processUpdate(status);

    assert.equal(handler.refreshCost, null);
    assert.equal(handler.refreshKilledAt, null);
  });

  it('leaves the adaptation alone when the refresh is switched off', async () => {
    const handler = makeHandler({ refreshInterval: 0 });

    await priced(handler, 600 * 1000);

    assert.equal(handler.refreshCost, null);
    assert.equal(handler.refreshDelay(), 0);
  });

  it('settles on a bimodal cost instead of flipping across it', async () => {
    //the regression this rule exists for. comparing each cost against the
    //current wait cannot settle when the costs straddle it: on a live AC0850
    //the old multiplier changed 88 times over 4.5 days, 43 of them the same
    //60s/120s pair, so half the time it sat at the floor #71 rules out
    const handler = makeHandler({ refreshInterval: 60 });
    const seen = [];

    for (let i = 0; i < 40; i += 1) {
      await priced(handler, (i % 2 ? 10 : 200) * 1000);
      seen.push(handler.refreshDelay());
    }

    const settled = seen.slice(-10);
    const low = Math.min(...settled);
    const high = Math.max(...settled);

    assert.ok(high / low < 1.25, `the wait still swings between ${low}ms and ${high}ms`);
    assert.ok(low > handler.refreshInterval, `the wait fell back to the ${handler.refreshInterval}ms floor`);
  });
});

describe('stall deadline', () => {
  it('measures the stall from the last reading, not from the process', async () => {
    //production ratios in miniature: the refresh cuts in well inside the stall
    //timeout, which is what made every stall fire at 60 + 5 + 300 rather than 300
    const handler = makeHandler({ refreshInterval: 1 });
    handler.purifierService = makeService();
    handler.stallTimeout = 5000;

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2' }));
    //four fifths of the way through the timeout already, as a refresh teardown
    //and its restart delay leave a replacement subscription
    handler.lastReadingAt = Date.now() - 4000;

    assert.ok(
      Math.abs(handler.stallDelay() - 1000) <= 50,
      `waited ${handler.stallDelay()}ms, which is not the 1000ms left of the timeout`
    );
  });

  it('gives a replacement subscription time to answer a past-due deadline', () => {
    const handler = makeHandler({ refreshInterval: 1 });
    handler.stallTimeout = 5000;
    //silent for far longer than the timeout already: without a floor the
    //deadline is past, and every respawn is killed before it can answer
    handler.lastReadingAt = Date.now() - 600 * 1000;

    assert.equal(handler.stallDelay(), handler.refreshDelay());
  });

  it('gives a device that has never answered the full timeout', () => {
    const handler = makeHandler({});
    handler.stallTimeout = 5000;

    assert.equal(handler.lastReadingAt, null);
    assert.equal(handler.stallDelay(), handler.stallTimeout);
  });

  it('keeps the off-state backstop on its own timeout', async () => {
    const handler = makeHandler({ refreshInterval: 1 });
    handler.purifierService = makeService();
    handler.offStallTimeout = 9000;

    await handler.processUpdate(JSON.stringify({ pwr: '0', mode: 'P', cl: false, om: '2' }));

    assert.ok(Math.abs(handler.stallDelay() - handler.offStallTimeout) <= 50);
  });

  it('keeps the off-state backstop on its own timeout after it has fired', async () => {
    //the arm that was never covered. measured from the reading alone the
    //deadline stays past for as long as the device stays quiet, so every arm
    //after the first fell through to the refresh floor: on a live AC0850 that
    //turned the 30 min backstop into a teardown every 5 min, 472 of them over
    //three nights with the purifier switched off
    const handler = makeHandler({ refreshInterval: 1 });
    handler.purifierService = makeService();
    handler.offStallTimeout = 9000;

    await handler.processUpdate(JSON.stringify({ pwr: '0', mode: 'P', cl: false, om: '2' }));

    const firedAt = Date.now();
    handler.lastReadingAt = firedAt - handler.offStallTimeout;
    handler.lastStallAt = firedAt;

    assert.ok(
      handler.stallDelay() > handler.refreshDelay(),
      `waited ${handler.stallDelay()}ms, which is the ${handler.refreshDelay()}ms refresh floor rather than the backstop`
    );
    assert.ok(Math.abs(handler.stallDelay() - handler.offStallTimeout) <= 50);
  });

  it('records the teardown so the next deadline can run from it', async () => {
    const handler = makeHandler({ refreshInterval: 0 });
    handler.purifierService = makeService();
    handler.stallTimeout = 20;
    //the teardown only needs something to kill, so this stands in for the child
    handler.airControl = /** @type {any} */ ({ kill: () => true });

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2' }));
    assert.equal(handler.lastStallAt, null);

    handler.armStallTimeout();
    await delay(100);

    assert.ok(handler.lastStallAt, 'the stall teardown left no mark for the next deadline to run from');
    assert.ok(handler.lastStallAt >= handler.lastReadingAt);
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

  it('asks for a fresh reading once an answered stream goes quiet', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    //the shim answers once and then stays alive without notifying, which is
    //what an idle purifier does between value changes
    const handler = makeHandler({ aioairctrlPath: SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);
    handler.stallTimeout = 5000;
    handler.restartDelay = 10;
    handler.refreshInterval = 150;

    handler.longPoll();
    await delay(120);
    const firstPid = handler.airControl.pid;
    await delay(400);

    assert.notEqual(handler.airControl.pid, firstPid, 'an idle stream was never refreshed');
    assert.equal(handler.pollFailures, 0, 'a deliberate refresh counted as a failed poll');
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
    await delay(50);
  });

  it('leaves a stream that keeps notifying alone past the refresh interval', async () => {
    const handler = makeHandler({ aioairctrlPath: STREAM_SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);

    //the shim notifies every 20ms, so a refresh timer re-armed by every reading
    //never fires: the interval measures silence, not process age
    handler.stallTimeout = 5000;
    handler.restartDelay = 10;
    handler.refreshInterval = 200;

    handler.longPoll();
    const firstPid = handler.airControl.pid;
    await delay(500);

    assert.equal(handler.airControl.pid, firstPid, 'a device reporting on its own was refreshed anyway');

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

  it('captures nothing reportable from the CLI progress log that cliDebug writes', async () => {
    //with 'cliDebug' enabled the plugin passes -D and aioairctrl logs its whole
    //run to stderr, so the buffer used to be full of progress records that then
    //surfaced as errors. this drives the real stream rather than the buffer
    const handler = makeHandler({ aioairctrlPath: DEBUG_LOG_SHIM, cliDebug: true });
    handler.accessory.getService = () => null;
    handler.restartDelay = 5000;

    handler.longPoll();
    await delay(200);
    handler.kill(true);

    assert.equal(handler.reportableStderr(), '');
  });

  it('reports a failure without the progress records that came with it', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ cliDebug: true });

    handler.captureStderr('DEBUG:aioairctrl.coap.client:syncing\n');
    handler.pollFailures = 3;
    handler.reportPollFailure(1);

    assert.ok(
      logs.warn.some((line) => line.includes('exited with code 1')),
      `no warning about the failing process, got ${JSON.stringify(logs.warn)}`
    );
    assert.deepEqual(logs.error, [], 'the CLI progress log was reported as an error');
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

  it('still reports a stall when the refresh keeps restarting the stream', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const marker = path.join(os.tmpdir(), `fake-once-${process.pid}-${Date.now()}`);
    process.env.FAKE_ONCE_FILE = marker;

    t.after(() => {
      delete process.env.FAKE_ONCE_FILE;
      fs.rmSync(marker, { force: true });
    });

    //answers once, then never again: the refresh restarts the stream on a
    //cadence far shorter than the stall timeout, and the fault must still surface
    const handler = makeHandler({ aioairctrlPath: ONCE_SHIM });
    handler.accessory.getService = () => null;
    handler.stallTimeout = 150;
    handler.restartDelay = 10;
    handler.refreshInterval = 60;

    handler.longPoll();
    await delay(600);

    assert.ok(
      logs.warn.some((line) => line.includes('No status received from the device')),
      `a device that went dark was never reported, got ${JSON.stringify(logs.warn)}`
    );

    handler.kill(true);
    await delay(50);
  });

  it('leaves a stream alone while the device reports itself switched off', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const marker = path.join(os.tmpdir(), `fake-off-${process.pid}-${Date.now()}`);
    process.env.FAKE_ONCE_FILE = marker;
    process.env.FAKE_ONCE_PWR = '0';

    t.after(() => {
      delete process.env.FAKE_ONCE_FILE;
      delete process.env.FAKE_ONCE_PWR;
      fs.rmSync(marker, { force: true });
    });

    //a purifier that is switched off answers only intermittently, and killing
    //the subscription does not make it answer sooner, so silence must neither
    //restart the stream on the short timeout nor be reported as a fault
    const handler = makeHandler({ aioairctrlPath: ONCE_SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);
    //long enough that the shim's own startup cannot outrun the first arming,
    //which happens before any status and so cannot know the device is off
    handler.stallTimeout = 5000;
    handler.offStallTimeout = 5000;
    handler.restartDelay = 10;
    handler.refreshInterval = 0;

    handler.longPoll();
    await answered(handler);

    const pid = handler.airControl.pid;

    //re-arm the way a status does, now that the device has reported itself off
    handler.stallTimeout = 50;
    handler.armStallTimeout();
    await delay(400);

    assert.equal(handler.airControl.pid, pid, 'the stream serving a switched-off device was restarted');
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
    await delay(50);
  });

  it('still restarts and reports a device that went dark while switched on', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const marker = path.join(os.tmpdir(), `fake-on-${process.pid}-${Date.now()}`);
    process.env.FAKE_ONCE_FILE = marker;
    process.env.FAKE_ONCE_PWR = '1';

    t.after(() => {
      delete process.env.FAKE_ONCE_FILE;
      delete process.env.FAKE_ONCE_PWR;
      fs.rmSync(marker, { force: true });
    });

    //the contrast to the test above, and the regression the off-state timeout
    //could introduce: a running device has no reason to go quiet
    const handler = makeHandler({ aioairctrlPath: ONCE_SHIM });
    handler.accessory.getService = () => null;
    handler.stallTimeout = 5000;
    handler.offStallTimeout = 5000;
    handler.restartDelay = 10;
    handler.refreshInterval = 0;

    handler.longPoll();
    await answered(handler);

    handler.stallTimeout = 50;
    handler.armStallTimeout();
    await delay(400);

    assert.ok(
      logs.warn.some((line) => line.includes('No status received from the device')),
      `a running device that went dark was never reported, got ${JSON.stringify(logs.warn)}`
    );

    handler.kill(true);
    await delay(50);
  });

  it('waits for the threshold when a device that has answered goes quiet', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2' }));

    //21 of these in one night on an AC0850, every one self-recovering: a single
    //dropped subscription is not the same claim as a purifier that is unplugged
    handler.stalled = true;
    handler.pollFailures = 1;
    handler.reportPollFailure(null);

    assert.deepEqual(logs.warn, [], 'a single self-recovering stall reached the user');

    handler.pollFailures = 3;
    handler.reportPollFailure(null);

    assert.ok(
      logs.warn.some((line) => line.includes('No status received from the device')),
      `a stall that kept repeating stayed quiet, got ${JSON.stringify(logs.warn)}`
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

  it('warns once while stdout keeps failing to parse', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();

    for (let i = 0; i < 4; i += 1) {
      await handler.processUpdate('not json at all');
    }

    assert.deepEqual(logs.warn, ['Lifecycle Purifier: Failed to parse device response']);
    assert.equal(logs.error.length, 1, 'every unparseable line logged its own error');

    //a line that parses clears the latch, so a later burst is reported again
    await handler.processUpdate(JSON.stringify({ pwr: '1' }));
    await handler.processUpdate('not json at all');

    assert.equal(logs.warn.length, 2, 'a fresh burst of unparseable output was swallowed');
  });

  it('says so when it was stopping the process that failed, not starting it', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ aioairctrlPath: SILENT_SHIM });
    handler.accessory.getService = () => null;
    handler.restartDelay = 5000;

    handler.longPoll();
    await delay(150);

    //node reports a kill that failed on the same 'error' event as a command
    //that never started; only the second is anything to do with the install
    handler.airControl.emit('error', new Error('kill ESRCH'));
    await delay(20);

    assert.deepEqual(logs.warn, ['Lifecycle Purifier: Failed to stop the polling process']);
    assert.equal(handler.loggedFailureKind, 'stop');

    handler.kill(true);
    await delay(50);
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

    assert.ok(handler.reportableStderr().length <= 4 * 1024, 'the stderr capture exceeded its cap');
    assert.ok(handler.reportableStderr().endsWith("ModuleNotFoundError: No module named 'aioairctrl'"));
  });
});

//the logger is a module singleton, so these tests must not capture it at the same time
describe('write verification', { concurrency: 1 }, () => {
  //these tests stand in for the CLI and drive the verification directly. the
  //stub replaces sendCMD rather than runCMD, so it bypasses the queue: what is
  //under test here is what happens to a write, not how commands are spaced
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

  it('reports a set command the CLI refused instead of recording it', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    //the CLI prints its complaint on stdout and still exits 0
    const handler = makeHandler({ aioairctrlPath: CLI_ERROR_SHIM });
    handler.purifierService = makeService();

    await handler.setPurifierActive(true);

    assert.equal(handler.pendingWrites.size, 0, 'a command that never went out was registered as pending');
    assert.ok(
      logs.error.some((line) => line.includes("Cannot encode value 'P' as int")),
      `the CLI's own complaint never reached the log, got ${JSON.stringify(logs.error)}`
    );
    assert.ok(
      logs.warn.some((line) => line.includes('An error occured during changing purifier state!')),
      `a rejected command was logged as success, got ${JSON.stringify(logs.warn)}`
    );

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
    handler.verifyWindow = 60;

    await handler.setPurifierActive(true);
    await delay(150);

    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('measures a write to a sleeping device against the off-state backstop', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler } = recordingHandler();
    //the device has said it is off, so silence from it is the expected answer
    //rather than evidence. #77: an AC0850 answered nothing for eleven minutes
    //and then contradicted the write, long after the responsive window closed
    await handler.processUpdate(status({ pwr: '0' }));
    handler.verifyWindow = 60;
    handler.offStallTimeout = 100000;

    await handler.setPurifierActive(true);
    await delay(150);

    assert.equal(handler.pendingWrites.size, 1, 'a wake-up write was discarded on the responsive window');
    assert.equal(handler.pendingWrites.get('pwr').window, 100000);
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('keeps the responsive window for a write to a device that was answering', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler } = recordingHandler();
    //the wider window follows the regime the device is in, not the write: a
    //device that was talking is still expected to answer within a refresh cycle
    await handler.processUpdate(status({ pwr: '1' }));
    handler.verifyWindow = 60;
    handler.offStallTimeout = 100000;

    await handler.setPurifierActive(false);
    await delay(150);

    assert.equal(handler.pendingWrites.size, 0, 'a write to a responsive device outlived its window');
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('resends a wake-up once unprompted, without spending the retry budget', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    await handler.processUpdate(status({ pwr: '0' }));
    handler.verifyWindow = 60;
    handler.offStallTimeout = 100000;

    await handler.setPurifierActive(true);
    sent.length = 0;

    await delay(150);

    assert.deepEqual(sent.length, 1, 'a wake-up nothing answered was never resent');
    assert.ok(sent[0].includes('pwr=1'));
    //the retry the device's own answer will ask for must still be available
    assert.equal(handler.pendingWrites.get('pwr').attempts, 0);
    assert.equal(handler.pendingWrites.get('pwr').blindResent, true);
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('resends a wake-up unprompted only once, however long the silence lasts', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    await handler.processUpdate(status({ pwr: '0' }));
    handler.verifyWindow = 40;
    handler.offStallTimeout = 100000;

    await handler.setPurifierActive(true);
    sent.length = 0;

    await delay(300);

    assert.equal(sent.length, 1, 'the unprompted resend repeated on every sweep');
    assert.deepEqual(logs.warn, [], 'a write still inside its window was reported');

    handler.kill(true);
  });

  it('resends when the device contradicts a wake-up long after the responsive window', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    await handler.processUpdate(status({ pwr: '0' }));
    handler.verifyWindow = 60;
    handler.offStallTimeout = 100000;

    await handler.setPurifierActive(true);
    sent.length = 0;

    //the write is still pending when the evidence finally lands, so the retry
    //path that already worked gets to act on it. this is the whole of #77
    await delay(150);
    //the unprompted resend has already gone by now. charging it to `attempts`
    //would leave nothing for this, the one moment the device is known to listen
    await handler.processUpdate(status({ pwr: '0' }));

    assert.equal(sent.length, 2, 'the write the device contradicted was never resent');
    assert.ok(sent.every((args) => args.includes('pwr=1')));
    assert.equal(handler.pendingWrites.get('pwr').attempts, 1);
    assert.deepEqual(logs.warn, [], 'a single retry should not bother the user');

    handler.kill(true);
  });

  it('reports a wake-up the device never answered', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler } = recordingHandler();
    await handler.processUpdate(status({ pwr: '0' }));
    handler.verifyWindow = 40;
    handler.offStallTimeout = 120;

    await handler.setPurifierActive(true);
    await delay(300);

    assert.equal(handler.pendingWrites.size, 0);
    assert.ok(
      logs.warn.some((line) => line.includes('never answered pwr=1')),
      `a dropped wake-up was discarded in silence, got ${JSON.stringify(logs.warn)}`
    );
    //asked once, then once more unprompted, before it was given up on
    assert.ok(logs.warn.some((line) => line.includes('after 2 attempts')));

    //a repeating automation reports once, not on every cycle
    logs.warn.length = 0;
    await handler.setPurifierActive(true);
    await delay(300);

    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('puts HomeKit back to the last reading when a wake-up is given up on', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler } = recordingHandler();
    await handler.processUpdate(status({ pwr: '0' }));
    handler.verifyWindow = 40;
    handler.offStallTimeout = 120;

    await handler.setPurifierActive(true);
    //the optimistic update HomeKit is given while the write is still live
    assert.deepEqual(updated(handler.purifierService, 'CurrentAirPurifierState').at(-1), [
      'CurrentAirPurifierState',
      2,
    ]);

    await delay(300);

    //#77: the Home app kept reporting PURIFYING_AIR for a purifier the plugin
    //knew was off, and stayed wrong until a real status happened to arrive
    assert.deepEqual(updated(handler.purifierService, 'Active').at(-1), ['Active', 0]);
    assert.deepEqual(updated(handler.purifierService, 'CurrentAirPurifierState').at(-1), [
      'CurrentAirPurifierState',
      0,
    ]);

    handler.kill(true);
  });

  it('leaves HomeKit alone for a device that has never answered', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler } = recordingHandler();
    handler.verifyWindow = 40;

    await handler.setPurifierActive(true);
    handler.purifierService.updates.length = 0;

    await delay(300);

    //there is no reading to revert to, so publishing one would be a guess
    assert.deepEqual(handler.purifierService.updates, []);
    assert.equal(handler.pendingWrites.size, 0);

    handler.kill(true);
  });

  it('resends one command per command, not once per key it carries', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({ model: 'AC0850' });
    handler.purifierService = makeService();
    /** @type {string[]} */
    const sent = [];
    let inFlight = 0;
    let overlapped = 0;
    handler.sendCMD = async (args) => {
      inFlight += 1;
      overlapped = Math.max(overlapped, inFlight);
      await delay(20);
      inFlight -= 1;
      sent.push(args.join(' '));
    };

    await handler.processUpdate(JSON.stringify({ D03102: 0, D0310A: 2, D0310C: 17 }));
    assert.equal(handler.deviceKnownOff(), true);

    handler.verifyWindow = 50;
    handler.offStallTimeout = 100000;

    //the scene #77 was observed under: power and speed set together
    await handler.setPurifierActive(true);
    await handler.setPurifierRotationSpeed(50);
    assert.deepEqual([...handler.pendingWrites.keys()], ['pwr', 'D0310A', 'D0310C']);
    sent.length = 0;

    await delay(250);

    //an AC0850 speed is D0310A and D0310C in one command, so resending per key
    //would fire that same command twice. the wake-up goes last: it has to be
    //the last thing a sleeping device hears if wake disturbance is what #77 saw
    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=0',
      '-H 192.168.1.142 -P 5683 set -I D03102=1',
    ]);
    //these purifiers serve one connection, and the plugin already holds one
    assert.equal(overlapped, 1, 'resends raced each other at a single-connection device');

    handler.kill(true);
  });

  it('expires a pending write on its own deadline, not on the last status', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler } = recordingHandler();
    handler.verifyWindow = 200;

    await handler.setPurifierActive(true);

    //a chatty device that never mentions pwr must not hold the write open: the
    //expiry timer is re-armed by every status, the deadline is not
    for (let i = 0; i < 6; i += 1) {
      await delay(50);
      await handler.processUpdate(JSON.stringify({ mode: 'M', cl: false, om: '1' }));
    }

    assert.equal(handler.pendingWrites.size, 0, 'a pending write outlived its window');
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
    //the refresh under test here is the explicit one, not the timer
    handler.refreshInterval = 0;

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

  it('records the write before the command has been sent', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    //a send that never settles, which is what an unreachable device does
    handler.sendCMD = () => new Promise(() => {});

    const setting = handler.setPurifierActive(true);
    await delay(20);

    //the whole point: a command that has not left the host is still a write the
    //give-up machinery can act on
    assert.equal(handler.pendingWrites.size, 1);
    assert.equal(
      handler.pendingWrites.get('pwr').since,
      Infinity,
      'a status arriving now would have been treated as evidence about a command still in flight'
    );

    handler.kill(true);
    void setting;
  });

  it('puts HomeKit back when the command never leaves the host', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    await handler.processUpdate(status({ pwr: '0' }));
    handler.sendCMD = async () => {
      throw new Error('nope');
    };

    await handler.setPurifierActive(true);

    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(updated(handler.purifierService, 'Active').at(-1), ['Active', 0]);
    assert.deepEqual(updated(handler.purifierService, 'CurrentAirPurifierState').at(-1), [
      'CurrentAirPurifierState',
      0,
    ]);
    assert.equal(logs.warn.length, 1, 'the setter still reports the failure in its own words');

    handler.kill(true);
  });

  it('cuts off a set command the device never answers', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ aioairctrlPath: HANG_SHIM });
    handler.purifierService = makeService();
    handler.sendTimeout = 150;

    await handler.setPurifierActive(true);

    //without the cap this never returns at all, and the child outlives the run
    assert.equal(handler.pendingWrites.size, 0);
    assert.match(logs.error.join(' '), /got no answer from 192\.168\.1\.142:5683 within 0\.15s/);
    assert.doesNotMatch(logs.error.join(' '), /not found|could not be executed/, 'reported as an install fault');

    handler.kill(true);
  });

  it('never runs two set commands at once', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({ model: 'AC0850' });
    handler.purifierService = makeService();
    /** @type {string[]} */
    const sent = [];
    let inFlight = 0;
    let overlapped = 0;
    handler.runCMD = async (args) => {
      inFlight += 1;
      overlapped = Math.max(overlapped, inFlight);
      await delay(20);
      inFlight -= 1;
      sent.push(args.join(' '));
    };

    //the scene shape: HomeKit delivers these as independent onSet calls, so
    //nothing awaits one before making the other
    await Promise.all([handler.setPurifierActive(true), handler.setPurifierRotationSpeed(50)]);

    assert.equal(overlapped, 1, 'two set processes raced at a single-connection device');
    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D03102=1',
      '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=0',
    ]);

    handler.kill(true);
  });

  it('resends in turn when a status contradicts two commands', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({ model: 'AC0850' });
    handler.purifierService = makeService();
    /** @type {string[]} */
    const sent = [];
    let inFlight = 0;
    let overlapped = 0;
    handler.sendCMD = async (args) => {
      inFlight += 1;
      overlapped = Math.max(overlapped, inFlight);
      await delay(20);
      inFlight -= 1;
      sent.push(args.join(' '));
    };

    await handler.processUpdate(JSON.stringify({ D03102: 1, D0310A: 2, D0310C: 17 }));
    await handler.setPurifierActive(true);
    await handler.setPurifierRotationSpeed(50);
    sent.length = 0;

    //the device answers, still disagreeing about both commands
    await handler.processUpdate(JSON.stringify({ D03102: 0, D0310A: 2, D0310C: 17 }));
    await delay(120);

    assert.equal(overlapped, 1, 'two contradicted commands were resent at once');
    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=0',
      '-H 192.168.1.142 -P 5683 set -I D03102=1',
    ]);

    handler.kill(true);
  });
});
