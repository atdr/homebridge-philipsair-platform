'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const { ChildProcess } = require('node:child_process');
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
//debug lines go through log.info with a `[DEBUG] ` prefix, so they land in
//entries.info when a test asks for them
const captureLogs = (config = {}) => {
  const entries = { info: [], warn: [], error: [] };
  const record = (bucket) => (message) =>
    entries[bucket].push(message instanceof Error ? message.message : String(message));

  logger.configure({ info: record('info'), warn: record('warn'), error: record('error') }, config);

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

//polls until the condition holds, or fails once a generous deadline passes.
//every shim is a real node process, and under full-suite load spawning one
//takes far longer than on a quiet machine, so a fixed sleep sized for the
//second loses the race on the first (#58). A fixed delay() is kept only where
//a test asserts that something did NOT happen within a window
const waitFor = async (condition, { timeout = 10000, interval = 10, what = 'the condition' } = {}) => {
  const deadline = Date.now() + timeout;

  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeout}ms waiting for ${what}`);
    }
    await delay(interval);
  }
};

//waits for the first status to be processed, since a shim is a node process and
//its startup is slower than the timers these tests shorten
const answered = (handler) => waitFor(() => handler.obj.pwr !== undefined, { what: 'the shim to answer' });

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

//every handler a test makes, so teardown can stop it whether or not the test
//reached its own kill(true). An assertion that threw used to skip that line and
//leave the handler restarting its shim for as long as the file ran, which kept
//the file from ever exiting and loaded the machine for every later test (#58)
/** @type {Set<Handler>} */
const handlers = new Set();

const makeHandler = (config = {}) => {
  const handler = new Handler(fakeApi, {
    displayName: 'Lifecycle Purifier',
    context: { config: { host: '192.168.1.142', port: 5683, debug: false, ...config } },
  });

  handlers.add(handler);
  return handler;
};

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

//stops every handler the test made and waits until its polling child is really
//gone, so nothing from one test is still running, or logging, in the next
afterEach(async () => {
  const stopping = [...handlers];
  handlers.clear();

  for (const handler of stopping) {
    handler.kill(true);
  }

  for (const handler of stopping) {
    const child = handler.airControl;

    //some tests stand an object in for the child
    if (child instanceof ChildProcess && !exited(child)) {
      try {
        await waitFor(() => exited(child), { timeout: 5000, what: `shim ${child.pid} to exit after kill` });
      } catch {
        child.kill('SIGKILL');
        await waitFor(() => exited(child), { timeout: 5000, what: `shim ${child.pid} to exit after SIGKILL` });
      }
    }

    //a `set` still running holds the event loop open, and can log into the
    //next test's capture when it settles. execFile caps it at sendTimeout, and
    //the cap is cleared once the queue drains so it holds nothing open itself
    let cap;
    await Promise.race([
      handler.writeQueue,
      new Promise((resolve) => {
        cap = setTimeout(resolve, handler.sendTimeout + 1000);
      }),
    ]);
    clearTimeout(cap);
  }

  silenceLogger();
});

const updated = (service, characteristic) => service.updates.filter(([name]) => name === characteristic);

describe('processUpdate', () => {
  it('parses a status line and pushes purifier characteristics', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();

    //in Manual, where the slider shows the device's own speed
    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'M', cl: false, om: '2' }));

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

  it('reports the temperature and humidity sensors when present', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.temperatureService = makeService();
    handler.humidityService = makeService();

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2', temp: 21.5, rh: 45 }));

    assert.deepEqual(updated(handler.temperatureService, 'CurrentTemperature'), [['CurrentTemperature', 21.5]]);
    assert.deepEqual(updated(handler.humidityService, 'CurrentRelativeHumidity'), [['CurrentRelativeHumidity', 45]]);
  });

  it('reports the light on and its brightness while powered on', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.lightService = makeService();

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2', aqil: 50 }));

    assert.deepEqual(updated(handler.lightService, 'On'), [['On', true]]);
    assert.deepEqual(updated(handler.lightService, 'Brightness'), [['Brightness', 50]]);
  });

  it('reports the light off, without a brightness reading, while powered off', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.lightService = makeService();

    await handler.processUpdate(JSON.stringify({ pwr: '0', mode: 'P', cl: false, om: '2', aqil: 50 }));

    assert.deepEqual(updated(handler.lightService, 'On'), [['On', false]]);
    assert.equal(updated(handler.lightService, 'Brightness').length, 0, 'a powered-off device got a brightness push');
  });

  it('reports the humidifier state while actively humidifying', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.humidifierService = makeService();

    await handler.processUpdate(
      JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2', func: 'PH', rh: 45, wl: 100, rhset: 50 })
    );

    assert.deepEqual(updated(handler.humidifierService, 'Active'), [['Active', 1]]);
    assert.deepEqual(updated(handler.humidifierService, 'CurrentRelativeHumidity'), [['CurrentRelativeHumidity', 45]]);
    assert.deepEqual(updated(handler.humidifierService, 'WaterLevel'), [['WaterLevel', 100]]);
    assert.deepEqual(updated(handler.humidifierService, 'RelativeHumidityHumidifierThreshold'), [
      ['RelativeHumidityHumidifierThreshold', 50],
    ]);
  });

  it('switches back to purifier mode and forces the humidifier off when the tank runs dry', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.humidifierService = makeService();
    handler.sendCMD = async () => {};

    await handler.processUpdate(
      JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2', func: 'PH', rh: 45, wl: 0, rhset: 50 })
    );

    assert.deepEqual(updated(handler.humidifierService, 'WaterLevel'), [['WaterLevel', 0]]);
    //the reading-driven push, then the forced-off push once the empty tank is noticed
    assert.deepEqual(updated(handler.humidifierService, 'Active'), [
      ['Active', 1],
      ['Active', 0],
    ]);
    assert.deepEqual(updated(handler.humidifierService, 'CurrentHumidifierDehumidifierState'), [
      ['CurrentHumidifierDehumidifierState', 0],
    ]);

    handler.kill(true);
  });

  it('reports pre-filter, carbon-filter and HEPA-filter life and change indication', async () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.preFilterService = makeService();
    handler.carbonFilterService = makeService();
    handler.hepaFilterService = makeService();

    await handler.processUpdate(
      JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2', fltsts0: 0, fltsts1: 2400, fltsts2: 4800 })
    );

    assert.deepEqual(updated(handler.preFilterService, 'FilterChangeIndication'), [['FilterChangeIndication', true]]);
    assert.deepEqual(updated(handler.preFilterService, 'FilterLifeLevel'), [['FilterLifeLevel', 0]]);
    assert.deepEqual(updated(handler.hepaFilterService, 'FilterLifeLevel'), [['FilterLifeLevel', 50]]);
    assert.deepEqual(updated(handler.carbonFilterService, 'FilterLifeLevel'), [['FilterLifeLevel', 100]]);
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
    await waitFor(() => handler.lastStallAt !== null, {
      what: 'the stall teardown to leave its mark for the next deadline',
    });

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
    await waitFor(() => updated(handler.purifierService, 'Active').length > 0, { what: 'the completed line' });
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
    await answered(handler);

    //the shim splits the JSON line across two writes 50ms apart
    assert.equal(handler.obj.pwr, '1');
    assert.ok(updated(purifier, 'Active').length > 0);

    handler.kill(true);
    const child = handler.airControl;
    await waitFor(() => exited(child), { what: 'the killed shim to exit' });
    //a fixed window on purpose: nothing may schedule a restart after the
    //child's close, and a restart would land here if anything did
    await delay(200);

    assert.equal(handler.restartTimeout, null);
    assert.equal(handler.airControl, child, 'a killed stream was replaced');
    assert.ok(handler.airControl.killed);
  });

  it('leaves a stream that keeps notifying alone past the stall timeout', async () => {
    const handler = makeHandler({ aioairctrlPath: STREAM_SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);

    //the shim notifies every 20ms, so a stall timer reset by incoming data
    //never fires; a fixed process lifetime would kill the stream at 200ms.
    //the 10x margin keeps this from flaking on a loaded CI runner. the short
    //timeout goes on only once the stream is talking: armed at spawn, it was
    //racing node's own startup, which under load takes longer than 200ms
    handler.stallTimeout = 5000;
    handler.restartDelay = 10;

    handler.longPoll();
    const firstPid = handler.airControl.pid;
    await answered(handler);

    handler.stallTimeout = 200;
    handler.armStallTimeout();
    //a fixed window on purpose: the claim is that no restart happens in it
    await delay(500);

    assert.equal(handler.airControl.pid, firstPid, 'a healthy stream was restarted anyway');
    assert.ok(updated(purifier, 'Active').length > 1);
  });

  it('restarts a stream that accepts the subscription and then goes silent', async () => {
    const handler = makeHandler({ aioairctrlPath: SILENT_SHIM });
    handler.accessory.getService = () => null;

    handler.stallTimeout = 100;
    handler.restartDelay = 10;

    handler.longPoll();
    const firstPid = handler.airControl.pid;
    await waitFor(() => handler.airControl.pid !== firstPid, { what: 'the stalled stream to be restarted' });

    assert.notEqual(handler.airControl.pid, firstPid, 'a stalled stream was never restarted');
  });

  it('asks for a fresh reading once an answered stream goes quiet', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    //the shim answers once and then stays alive without notifying, which is
    //what an idle purifier does between value changes
    const handler = makeHandler({ aioairctrlPath: SHIM });
    const purifier = makeService();
    handler.accessory.getService = (service) => (service === 'AirPurifier' ? purifier : null);
    //far past the wait below, so a replaced stream can only be the refresh
    handler.stallTimeout = 30000;
    handler.restartDelay = 10;
    handler.refreshInterval = 150;

    handler.longPoll();
    const firstPid = handler.airControl.pid;
    await answered(handler);
    await waitFor(() => handler.airControl.pid !== firstPid, { what: 'the idle stream to be refreshed' });

    assert.notEqual(handler.airControl.pid, firstPid, 'an idle stream was never refreshed');
    assert.equal(handler.pollFailures, 0, 'a deliberate refresh counted as a failed poll');
    assert.deepEqual(logs.warn, []);
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
    //the window has to be spent with the stream talking, not starting up
    await answered(handler);
    //a fixed window on purpose: the claim is that no refresh happens in it
    await delay(500);

    assert.equal(handler.airControl.pid, firstPid, 'a device reporting on its own was refreshed anyway');
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
    //the warning needs three real spawn/exit cycles (FAILURE_ESCALATION_THRESHOLD),
    //and three more past it give the one-warning check below retries to repeat on
    await waitFor(() => handler.pollFailures >= 6, { what: 'six failed polls of the broken shim' });
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
    //the failure is counted on close, once all of its stderr has been read
    await waitFor(() => handler.pollFailures === 1, { what: 'the debug-log shim to exit' });
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
    await waitFor(() => handler.pollFailures === 1, { what: 'the first attempt to fail' });
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
    await waitFor(() => logs.warn.some((line) => line.includes('No status received from the device')), {
      what: 'the silent device to be reported',
    });
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
    await waitFor(() => logs.warn.some((line) => line.includes('No status received from the device')), {
      what: 'the device that went dark to be reported',
    });

    assert.ok(
      logs.warn.some((line) => line.includes('No status received from the device')),
      `a device that went dark was never reported, got ${JSON.stringify(logs.warn)}`
    );

    handler.kill(true);
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
    //a fixed window on purpose: the claim is that no restart happens in it
    await delay(400);

    assert.equal(handler.airControl.pid, pid, 'the stream serving a switched-off device was restarted');
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
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
    await waitFor(() => logs.warn.some((line) => line.includes('No status received from the device')), {
      what: 'the running device that went dark to be reported',
    });

    assert.ok(
      logs.warn.some((line) => line.includes('No status received from the device')),
      `a running device that went dark was never reported, got ${JSON.stringify(logs.warn)}`
    );

    handler.kill(true);
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
    //a child that started has a pid, which is what tells the two faults apart
    await waitFor(() => handler.airControl.pid !== undefined, { what: 'the shim to start' });

    //node reports a kill that failed on the same 'error' event as a command
    //that never started; only the second is anything to do with the install.
    //emit() runs the listener synchronously, so the warning is already logged
    handler.airControl.emit('error', new Error('kill ESRCH'));

    assert.deepEqual(logs.warn, ['Lifecycle Purifier: Failed to stop the polling process']);
    assert.equal(handler.loggedFailureKind, 'stop');

    handler.kill(true);
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
  //under test here is what happens to a write, not how commands are spaced.
  //the settling allowance goes to zero for the same reason: statuses are fed in
  //with no real time passing, so every one of them would otherwise be discounted
  const recordingHandler = () => {
    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.writeSettle = 0;
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
    await waitFor(() => handler.pendingWrites.size === 0, { what: 'the unanswered write to be given up on' });

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
    //the unprompted resend fires on the responsive window, so once it has gone
    //that window is known to have passed (or the write is gone, which the
    //assertion below reports)
    await waitFor(() => !handler.pendingWrites.has('pwr') || handler.pendingWrites.get('pwr').blindResent, {
      what: 'the responsive window to pass',
    });

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
    await waitFor(() => handler.pendingWrites.size === 0, { what: 'the write to expire on the responsive window' });

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

    await waitFor(() => sent.length > 0, { what: 'the unprompted resend' });

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

    await waitFor(() => sent.length > 0, { what: 'the unprompted resend' });
    //a fixed window on purpose, several sweeps long: the claim is that the
    //resend does not repeat in it
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
    await waitFor(() => sent.length > 0, { what: 'the unprompted resend' });
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
    await waitFor(() => handler.pendingWrites.size === 0, { what: 'the wake-up to be given up on' });

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
    await waitFor(() => handler.pendingWrites.size === 0, { what: 'the repeat wake-up to be given up on' });

    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('puts HomeKit back to the last reading when a wake-up is given up on', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs({ debug: true });

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

    await waitFor(() => handler.pendingWrites.size === 0, { what: 'the wake-up to be given up on' });

    //#77: the Home app kept reporting PURIFYING_AIR for a purifier the plugin
    //knew was off, and stayed wrong until a real status happened to arrive
    assert.deepEqual(updated(handler.purifierService, 'Active').at(-1), ['Active', 0]);
    assert.deepEqual(updated(handler.purifierService, 'CurrentAirPurifierState').at(-1), [
      'CurrentAirPurifierState',
      0,
    ]);

    //the revert publishes the same value HomeKit falls back to on its own, so
    //the log is the only place it can be told apart from not having run
    assert.ok(
      logs.info.some((line) => line.includes("Putting HomeKit's pwr back to the last reading the device gave (0)")),
      `the revert left no trace, got ${JSON.stringify(logs.info)}`
    );

    handler.kill(true);
  });

  it('leaves HomeKit alone for a device that has never answered', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs({ debug: true });

    const { handler } = recordingHandler();
    handler.verifyWindow = 40;

    await handler.setPurifierActive(true);
    handler.purifierService.updates.length = 0;

    await waitFor(() => handler.pendingWrites.size === 0, { what: 'the write to be given up on' });

    //there is no reading to revert to, so publishing one would be a guess
    assert.deepEqual(handler.purifierService.updates, []);
    assert.equal(handler.pendingWrites.size, 0);
    assert.ok(
      logs.info.some((line) => line.includes("Leaving HomeKit's pwr as it is")),
      `silence here is indistinguishable from the revert never being reached, got ${JSON.stringify(logs.info)}`
    );
    assert.ok(!logs.info.some((line) => line.includes('back to the last reading')));

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
    //these two setter calls are sequential, not the concurrent scene shape
    //#82 coalesces, but each still pays the coalescing window before its
    //write is recorded. Kept near-zero so the two recordWrite calls land
    //close enough together for one shared verify timer to catch both, as
    //they would have before #82 (that timer is armed once and not re-armed
    //for a later entry's earlier deadline, so a wide gap here would silently
    //miss the second write's own blind resend)
    handler.writeCoalesceWindow = 1;

    //the scene #77 was observed under: power and speed set together
    await handler.setPurifierActive(true);
    await handler.setPurifierRotationSpeed(100);
    assert.deepEqual([...handler.pendingWrites.keys()], ['pwr', 'D0310A', 'D0310C']);
    sent.length = 0;

    await waitFor(() => sent.length >= 2, { what: 'both unprompted resends' });

    //an AC0850 speed is D0310A and D0310C in one command, so resending per key
    //would fire that same command twice. the wake-up goes last: it has to be
    //the last thing a sleeping device hears if wake disturbance is what #77 saw
    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=18',
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
    //expiry timer is re-armed by every status, the deadline is not. fixed
    //delays on purpose: the claim is about a point in time, and load can only
    //stretch them, which gives a correct deadline more time, never less
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
    await answered(handler);
    const firstPid = handler.airControl.pid;

    handler.requestRefresh();
    await waitFor(() => handler.airControl.pid !== firstPid, { what: 'the stream to be re-subscribed' });

    assert.notEqual(handler.airControl.pid, firstPid, 'the stream was never re-subscribed');
    assert.equal(handler.pollFailures, 0, 'a deliberate refresh counted as a failed poll');
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
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
    //the resend under test is driven by the device contradicting the write,
    //not by this window, which only has to outlast a loaded runner's spawns
    handler.verifyWindow = 5000;
    //the shim answers in milliseconds, so the settling allowance scales with the
    //rest of the timings rather than staying at its real-device size
    handler.writeSettle = 20;

    handler.longPoll();
    await answered(handler);
    await handler.setPurifierActive(true);
    await waitFor(() => handler.obj.pwr === '1' && handler.pendingWrites.size === 0, {
      what: 'the dropped write to be resent and confirmed',
    });

    assert.equal(handler.obj.pwr, '1', 'the dropped write was never resent');
    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(logs.warn, []);
    assert.deepEqual(updated(purifier, 'Active').at(-1), ['Active', 1]);

    handler.kill(true);
  });

  it('records the write before the command has been sent', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    //near-zero so the coalescing window (issue #82) is not what this test is
    //measuring: it only exists to let a companion write arrive, and there is
    //none here
    handler.writeCoalesceWindow = 5;
    //a send that never settles, which is what an unreachable device does
    handler.sendCMD = () => new Promise(() => {});

    const setting = handler.setPurifierActive(true);
    await waitFor(() => handler.pendingWrites.size > 0, { what: 'the write to be recorded' });

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

  it('sends a write still waiting out its coalescing window on kill, rather than stranding it', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    /** @type {string[][]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args);
    };

    //a window that cannot close on its own, so the write is certain to still be
    //waiting in it when kill() runs, however slowly a loaded runner gets there
    handler.writeCoalesceWindow = 100000;

    const setting = handler.setPurifierActive(true);

    //still inside the coalescing window: the optimistic HomeKit update has
    //already applied, but recordWrite only runs at flush, so there is no
    //pendingWrites entry yet for kill() to act on the usual way
    await waitFor(() => handler.writeBatch.length === 1, { what: 'the write to join the coalescing batch' });
    assert.equal(handler.pendingWrites.size, 0, 'recorded earlier than the coalescing window allows');

    handler.kill(true);
    await setting;

    assert.equal(sent.length, 1, 'a write still queued when kill() ran was left stranded');

    handler.kill(true);
  });

  it('tracks nothing after shutdown for the writes kill() flushes on its way out', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    //an AC0850 scene goes out as two commands, the power-on after the rest, so
    //the second is recorded only after kill() has returned
    const handler = makeHandler({ model: 'AC0850' });
    handler.purifierService = makeService();
    handler.writeCoalesceWindow = 100000;
    /** @type {string[][]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args);
    };

    const setting = Promise.all([handler.setPurifierActive(true), handler.setPurifierRotationSpeed(100)]);
    await waitFor(() => handler.writeBatch.length === 2, { what: 'both writes to join the coalescing batch' });

    handler.kill(true);
    await setting;

    assert.equal(sent.length, 2, 'a write still queued when kill() ran was left stranded');
    //nothing is left to verify against a stream that has been shut down. a
    //verification timer armed here outlived kill() by the full window, five
    //minutes by default, and could resend to the device after shutdown
    assert.equal(handler.verifyTimeout, null, 'a verification timer was armed after shutdown');
    assert.equal(handler.pendingWrites.size, 0, 'a write was left pending after shutdown');
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

  it('does not let a stale abandon revert a newer write to the same command', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();

    const args = ['set', '-I', 'pwr=1'];

    //A is recorded and its send stalls, the way an unreachable device does
    let rejectFirst;
    const first = new Promise((_resolve, reject) => {
      rejectFirst = reject;
    });
    handler.sendCMD = () => first;
    const sendingA = handler.sendTracked(args, { pwr: 1 }).catch((err) => err);

    //B is the retry: same command, recorded before A has settled, and
    //pendingWrites is keyed by generic key -- this overwrites A's own entry
    handler.sendCMD = async () => {};
    const sendingB = handler.sendTracked(args, { pwr: 1 });
    await sendingB;

    assert.equal(handler.pendingWrites.size, 1, "B's write must be recorded");

    //A's send finally fails, well after B has taken over the same key. A
    //command-string match on abandonWrite would find B's entry here, not A's
    rejectFirst(new Error('nope'));
    await sendingA;

    assert.equal(handler.pendingWrites.size, 1, "A's late failure must not abandon B's write");
    assert.deepEqual(
      updated(handler.purifierService, 'Active'),
      [],
      "A's late failure must not revert HomeKit against B's still-live intent"
    );

    handler.kill(true);
  });

  it('does not let a stale success reopen a newer write not yet on the wire', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();

    const args = ['set', '-I', 'pwr=1'];

    let resolveFirst;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    handler.sendCMD = () => first;
    const sendingA = handler.sendTracked(args, { pwr: 1 });

    //B is recorded before A has settled, overwriting A's entry. B's own send
    //stays pending too, so its own horizon should still be closed
    let resolveSecond;
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    handler.sendCMD = () => second;
    const sendingB = handler.sendTracked(args, { pwr: 1 });

    assert.equal(handler.pendingWrites.get('pwr').since, Infinity, "B's write has not been sent yet");

    //A's send finally succeeds, well after B has taken over the same key. A
    //command-string match on markWriteSent would stamp B's `since` here, off
    //A's completion rather than B's own, opening B's verification horizon
    //before B's packet is actually on the wire
    resolveFirst();
    await sendingA;

    assert.equal(
      handler.pendingWrites.get('pwr').since,
      Infinity,
      "A's late success must not open B's still-unsent write's horizon early"
    );

    resolveSecond();
    await sendingB;

    handler.kill(true);
  });

  it("caps a set command a short margin above HAP's own write timeout by default", () => {
    const handler = makeHandler({});

    //HAP marks a characteristic write "didn't respond at all" after ~9s
    //(TIMEOUT_WARNING 3000 + TIMEOUT_AFTER_WARNING 6000); the message-format
    //assertion for this cap lives in 'cuts off a set command the device
    //never answers' above, with sendTimeout overridden for speed -- this
    //only pins that the *default* itself sits a few seconds above that
    //ceiling, not below it, so revertOptimisticUpdate fires after HAP has
    //already given up rather than while its own write is still open
    //(issue #86)
    assert.equal(handler.sendTimeout, 12000);
    assert.ok(handler.sendTimeout > 9000);

    handler.kill(true);
  });

  it('coalesces two setters that arrive together into one command', async (t) => {
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

    //HomeKit delivers a scene's setters as independent onSet calls, so nothing
    //awaits one before making the other (#82). Both are integer-encodable, so
    //they should be folded into one command rather than sent as two
    await Promise.all([
      handler.queueWrite(['D0310A=2', 'D0310C=18'], { D0310A: 2, D0310C: 18 }),
      handler.queueWrite(['D03130=1'], { D03130: 1 }),
    ]);

    assert.equal(overlapped, 1, 'a merged write is still one process on the wire');
    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=18 D03130=1']);

    const pending = [...handler.pendingWrites.values()];
    assert.ok(
      pending.every((entry) => entry.args === pending[0].args),
      'the merged keys should share one args reference, the same as an unmerged multi-register command'
    );

    handler.kill(true);
  });

  it('sends the power-on of a scene on its own, after the rest', async (t) => {
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

    //an AC0850 ignores every register merged with a power-on, off or on (#117),
    //so the power-on goes alone, last, as orderPowerLast has resends
    await Promise.all([handler.setPurifierActive(true), handler.setPurifierRotationSpeed(100)]);

    assert.equal(overlapped, 1, 'the power-on and the rest must still never overlap on the wire');
    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=18',
      '-H 192.168.1.142 -P 5683 set -I D03102=1',
    ]);
    assert.deepEqual([...handler.pendingWrites.keys()].sort(), ['D0310A', 'D0310C', 'pwr']);

    handler.kill(true);
  });

  it('does not merge writes that would lose -I for one of them', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
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

    //setHumidifierTargetState's exact trap shape (issue #82): func is a word,
    //rhset asks for -I explicitly. Merging them would recompute intEncodable
    //as false over the pair and silently drop -I from rhset, so the merge
    //must fall back to sending them separately, exactly as if arrived alone
    await Promise.all([
      handler.queueWrite(['func=PH'], { func: 'PH' }),
      handler.queueWrite(['rhset=70'], { rhset: 70 }, ['-I']),
    ]);

    assert.equal(overlapped, 1, 'writes that cannot merge must still never overlap on the wire');
    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set func=PH', '-H 192.168.1.142 -P 5683 set -I rhset=70']);

    handler.kill(true);
  });

  it('resends in turn when a status contradicts two commands', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({ model: 'AC0850' });
    handler.purifierService = makeService();
    //no real time passes between the setters and the status below
    handler.writeSettle = 0;
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

    //off, so the power-on is not redundant and is sent: a device already on
    //would have it left out
    await handler.processUpdate(JSON.stringify({ D03102: 0, D0310A: 2, D0310C: 17 }));
    await handler.setPurifierActive(true);
    await handler.setPurifierRotationSpeed(100);
    sent.length = 0;

    //the device answers, still disagreeing about both commands
    await handler.processUpdate(JSON.stringify({ D03102: 0, D0310A: 2, D0310C: 17 }));
    await waitFor(() => sent.length >= 2, { what: 'both resends' });

    assert.equal(overlapped, 1, 'two contradicted commands were resent at once');
    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=18',
      '-H 192.168.1.142 -P 5683 set -I D03102=1',
    ]);

    handler.kill(true);
  });

  it('resends only the speed when the device comes on without it', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({ model: 'AC0850' });
    handler.purifierService = makeService();
    handler.writeSettle = 0;
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };

    //off, so the power-on is needed, and goes out after the speed on its own
    await handler.processUpdate(JSON.stringify({ D03102: 0, D0310A: 2, D0310C: 0 }));
    await Promise.all([handler.setPurifierActive(true), handler.setPurifierRotationSpeed(25)]);
    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=17',
      '-H 192.168.1.142 -P 5683 set -I D03102=1',
    ]);
    sent.length = 0;

    //the device came on but without the speed, so only the speed goes again
    await handler.processUpdate(JSON.stringify({ D03102: 1, D0310A: 2, D0310C: 0 }));
    await waitFor(() => sent.length > 0, { what: 'the speed to be resent' });

    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=17']);
    //pwr and D0310A were confirmed by that status, D0310C is the one still owed
    assert.deepEqual([...handler.pendingWrites.keys()], ['D0310C']);

    //and the resent write is still tracked against the command that went out
    await handler.processUpdate(JSON.stringify({ D03102: 1, D0310A: 2, D0310C: 17 }));
    assert.equal(handler.pendingWrites.size, 0);

    handler.kill(true);
  });

  //the two below reach the resend with the power-on still pending although
  //the device reports on: the status that said so arrived inside the settling
  //allowance, so it confirmed nothing, and the unprompted wake-up resend then
  //fires on a write recorded while the device was off
  it('drops a still pending power-on from a scene it resends to a device now on', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({ model: 'AC0850' });
    handler.purifierService = makeService();
    handler.writeSettle = 100000;
    handler.verifyWindow = 60;
    handler.offStallTimeout = 100000;
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };

    await handler.processUpdate(JSON.stringify({ D03102: 0, D0310A: 2, D0310C: 0 }));
    await Promise.all([handler.setPurifierActive(true), handler.setPurifierRotationSpeed(25)]);
    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=17',
      '-H 192.168.1.142 -P 5683 set -I D03102=1',
    ]);
    sent.length = 0;

    //on, but too soon after the command to count as an answer to it
    await handler.processUpdate(JSON.stringify({ D03102: 1, D0310A: 2, D0310C: 0 }));
    assert.deepEqual([...handler.pendingWrites.keys()].sort(), ['D0310A', 'D0310C', 'pwr']);

    await waitFor(() => sent.length > 0, { what: 'the unprompted resend' });

    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=17']);
    //the reading of on is what the power-on was waiting for, and the speed is
    //tracked against the command that actually went out
    assert.deepEqual([...handler.pendingWrites.keys()].sort(), ['D0310A', 'D0310C']);
    for (const pending of handler.pendingWrites.values()) {
      assert.equal(pending.args.join(' '), '-H 192.168.1.142 -P 5683 set -I D0310A=2 D0310C=17');
    }

    handler.kill(true);
  });

  it('resends nothing for a lone power-on once the device reports on', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ model: 'AC0850' });
    handler.purifierService = makeService();
    handler.writeSettle = 100000;
    handler.verifyWindow = 60;
    handler.offStallTimeout = 100000;
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };

    await handler.processUpdate(JSON.stringify({ D03102: 0, D0310A: 2, D0310C: 0 }));
    await handler.setPurifierActive(true);
    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I D03102=1']);
    sent.length = 0;

    await handler.processUpdate(JSON.stringify({ D03102: 1, D0310A: 2, D0310C: 0 }));
    assert.deepEqual([...handler.pendingWrites.keys()], ['pwr']);

    //the unprompted sweep either drops it or, wrongly, sends it again
    await waitFor(() => handler.pendingWrites.size === 0 || sent.length > 0, {
      what: 'the unprompted sweep to deal with the power-on',
    });

    assert.deepEqual(sent, [], 'a power-on to a device reporting on was resent');
    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });

  it('does not count a status the device sent as the command reached it', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    handler.writeSettle = 200;

    await handler.setPurifierActive(true);
    sent.length = 0;

    //the push that was already on its way, still carrying the old value
    await handler.processUpdate(status({ pwr: '0' }));

    assert.deepEqual(sent, [], 'a push that raced the command was read as a contradiction');
    assert.equal(handler.pendingWrites.size, 1);
    assert.deepEqual(logs.warn, []);

    //the allowance is a window, not a permanent exemption: once it has passed,
    //a device still reporting the old value is contradicting the command. a
    //fixed delay is right here: it only has to let the window pass, and load
    //can only make it longer
    await delay(220);
    await handler.processUpdate(status({ pwr: '0' }));

    assert.equal(sent.length, 1, 'a genuine contradiction after the allowance was ignored');
    assert.equal(handler.pendingWrites.get('pwr').attempts, 1);

    handler.kill(true);
  });

  it('does not report a write on a status that raced its resend', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const { handler, sent } = recordingHandler();
    handler.writeSettle = 200;

    await handler.setPurifierActive(true);
    sent.length = 0;
    //stands for the 19s that passed before the device answered on hardware
    handler.pendingWrites.get('pwr').since = Date.now() - 1000;

    await handler.processUpdate(status({ pwr: '0' }));
    await waitFor(() => sent.length > 0, { what: 'the contradiction to be resent' });

    assert.equal(sent.length, 1, 'the contradiction was not resent');
    assert.ok(handler.pendingWrites.get('pwr').since > Date.now(), 'the resend reopened the horizon immediately');

    //the retry budget is spent, so a status counted as evidence here reports a
    //failure outright. this one was composed before the resend landed
    await handler.processUpdate(status({ pwr: '0' }));

    assert.deepEqual(logs.warn, [], 'a push that raced the resend was reported as a failed write');
    assert.equal(handler.pendingWrites.size, 1);

    //the next push, once the device has acted on it. a fixed delay is right
    //here: it only has to let the settling window pass
    await delay(220);
    await handler.processUpdate(status({ pwr: '1' }));

    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(logs.warn, []);

    handler.kill(true);
  });
});

describe('setHumidifierActive', () => {
  const recordingHandler = (config = {}) => {
    const handler = makeHandler(config);
    handler.humidifierService = makeService();
    /** @type {string[][]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args);
    };
    return { handler, sent };
  };

  it('turns the humidifier on, computing the threshold from the last reading', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler, sent } = recordingHandler();
    handler.obj = { func: 'PH', wl: 100, rhset: 50 };

    await handler.setHumidifierActive(true);

    assert.deepEqual(updated(handler.humidifierService, 'Active'), [['Active', 1]]);
    assert.deepEqual(updated(handler.humidifierService, 'CurrentHumidifierDehumidifierState'), [
      ['CurrentHumidifierDehumidifierState', 2],
    ]);
    assert.deepEqual(updated(handler.humidifierService, 'RelativeHumidityHumidifierThreshold'), [
      ['RelativeHumidityHumidifierThreshold', 50],
    ]);
    assert.deepEqual(
      sent.map((args) => args[args.length - 1]),
      ['func=PH']
    );

    handler.kill(true);
  });

  it('reports an empty tank as 0%, not the mapped threshold', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler } = recordingHandler();
    handler.obj = { func: 'PH', wl: 0, rhset: 50 };

    await handler.setHumidifierActive(true);

    assert.deepEqual(updated(handler.humidifierService, 'CurrentHumidifierDehumidifierState'), [
      ['CurrentHumidifierDehumidifierState', 0],
    ]);
    assert.deepEqual(updated(handler.humidifierService, 'RelativeHumidityHumidifierThreshold'), [
      ['RelativeHumidityHumidifierThreshold', 0],
    ]);

    handler.kill(true);
  });

  it('turns the humidifier off', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler, sent } = recordingHandler();
    handler.obj = { func: 'PH', wl: 100, rhset: 50 };

    await handler.setHumidifierActive(false);

    assert.deepEqual(updated(handler.humidifierService, 'Active'), [['Active', 0]]);
    assert.deepEqual(updated(handler.humidifierService, 'CurrentHumidifierDehumidifierState'), [
      ['CurrentHumidifierDehumidifierState', 0],
    ]);
    assert.deepEqual(updated(handler.humidifierService, 'RelativeHumidityHumidifierThreshold'), [
      ['RelativeHumidityHumidifierThreshold', 0],
    ]);
    assert.deepEqual(
      sent.map((args) => args[args.length - 1]),
      ['func=P']
    );

    handler.kill(true);
  });
});

describe('setHumidifierTargetState', () => {
  const recordingHandler = (config = {}) => {
    const handler = makeHandler(config);
    handler.humidifierService = makeService();
    /** @type {string[][]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args);
    };
    return { handler, sent };
  };

  it('maps a mid-range percentage onto the nearest rhset rung, tank full', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler, sent } = recordingHandler();
    handler.obj = { func: 'P', wl: 100 };

    await handler.setHumidifierTargetState(60);

    assert.deepEqual(updated(handler.humidifierService, 'Active'), [['Active', 1]]);
    assert.deepEqual(updated(handler.humidifierService, 'CurrentHumidifierDehumidifierState'), [
      ['CurrentHumidifierDehumidifierState', 2],
    ]);
    assert.deepEqual(updated(handler.humidifierService, 'WaterLevel'), [['WaterLevel', 100]]);
    assert.deepEqual(updated(handler.humidifierService, 'RelativeHumidityHumidifierThreshold'), [
      ['RelativeHumidityHumidifierThreshold', 75],
    ]);
    assert.deepEqual(
      sent.map((args) => args[args.length - 1]),
      ['func=PH', 'rhset=60']
    );

    handler.kill(true);
  });

  it('maps a low percentage onto the lowest rhset rung', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler, sent } = recordingHandler();
    handler.obj = { func: 'P', wl: 100 };

    await handler.setHumidifierTargetState(20);

    assert.deepEqual(updated(handler.humidifierService, 'RelativeHumidityHumidifierThreshold'), [
      ['RelativeHumidityHumidifierThreshold', 25],
    ]);
    assert.deepEqual(
      sent.map((args) => args[args.length - 1]),
      ['func=PH', 'rhset=40']
    );

    handler.kill(true);
  });

  it('maps a middling-low percentage onto the second rhset rung', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler, sent } = recordingHandler();
    handler.obj = { func: 'P', wl: 100 };

    await handler.setHumidifierTargetState(40);

    assert.deepEqual(updated(handler.humidifierService, 'RelativeHumidityHumidifierThreshold'), [
      ['RelativeHumidityHumidifierThreshold', 50],
    ]);
    assert.deepEqual(
      sent.map((args) => args[args.length - 1]),
      ['func=PH', 'rhset=50']
    );

    handler.kill(true);
  });

  it('maps the top of the range onto the highest rhset rung', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler, sent } = recordingHandler();
    handler.obj = { func: 'P', wl: 100 };

    await handler.setHumidifierTargetState(100);

    assert.deepEqual(updated(handler.humidifierService, 'RelativeHumidityHumidifierThreshold'), [
      ['RelativeHumidityHumidifierThreshold', 100],
    ]);
    assert.deepEqual(
      sent.map((args) => args[args.length - 1]),
      ['func=PH', 'rhset=70']
    );

    handler.kill(true);
  });

  it('turns the humidifier off at 0%, without touching WaterLevel', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler, sent } = recordingHandler();
    handler.obj = { func: 'PH', wl: 100 };

    await handler.setHumidifierTargetState(0);

    assert.deepEqual(updated(handler.humidifierService, 'Active'), [['Active', 0]]);
    assert.equal(updated(handler.humidifierService, 'WaterLevel').length, 0, 'an off request pushed a water level');
    assert.deepEqual(
      sent.map((args) => args[args.length - 1]),
      ['func=P', 'rhset=40']
    );

    handler.kill(true);
  });

  it('reports an empty tank rather than a full one', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const { handler } = recordingHandler();
    handler.obj = { func: 'PH', wl: 0 };

    await handler.setHumidifierTargetState(60);

    assert.deepEqual(updated(handler.humidifierService, 'WaterLevel'), [['WaterLevel', 0]]);

    handler.kill(true);
  });
});

describe('setLightOn', () => {
  it('turns the ring on at full cosmetic brightness', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };

    await handler.setLightOn(true);

    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I aqil=100', '-H 192.168.1.142 -P 5683 set uil=1']);
    assert.equal(handler.settingLightState, false);
  });

  it('turns the ring off', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };

    await handler.setLightOn(false);

    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I aqil=0', '-H 192.168.1.142 -P 5683 set uil=0']);
  });

  it('does nothing while a brightness change is already in flight', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };
    handler.settingBrightness = true;

    await handler.setLightOn(true);

    assert.deepEqual(sent, [], 'a light toggle raced a brightness drag instead of yielding to it');
  });
});

describe('setLightBrightness', () => {
  it('sets aqil to the requested level and turns the ring on', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };

    await handler.setLightBrightness(75);

    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I aqil=75', '-H 192.168.1.142 -P 5683 set uil=1']);
  });

  it('turns the ring off at 0', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };

    await handler.setLightBrightness(0);

    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I aqil=0', '-H 192.168.1.142 -P 5683 set uil=0']);
  });

  it('does nothing while the on/off state is already changing', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };
    handler.settingLightState = true;

    await handler.setLightBrightness(50);

    assert.deepEqual(sent, [], 'a brightness drag raced a light toggle instead of yielding to it');
  });
});

describe('light on the AC1715', () => {
  //the AC1715 display register D03-05 takes 100/0, not the '1'/'0' the legacy
  //uil key takes (ruaan-deysel/ha-philips-airpurifier)
  const recording = (t) => {
    const handler = makeHandler({ model: 'AC1715' });
    t.after(() => handler.kill(true));
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };
    return { handler, sent };
  };

  it('writes the display register as 100 and 0', async (t) => {
    t.after(silenceLogger);
    captureLogs();
    const { handler, sent } = recording(t);

    await handler.setLightOn(true);
    await handler.setLightOn(false);

    assert.deepEqual(sent, [
      '-H 192.168.1.142 -P 5683 set -I D03-04=100',
      '-H 192.168.1.142 -P 5683 set -I D03-05=100',
      '-H 192.168.1.142 -P 5683 set -I D03-04=0',
      '-H 192.168.1.142 -P 5683 set -I D03-05=0',
    ]);
  });

  it('switches the display on with any brightness above 0', async (t) => {
    t.after(silenceLogger);
    captureLogs();
    const { handler, sent } = recording(t);

    await handler.setLightBrightness(50);

    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set -I D03-04=50', '-H 192.168.1.142 -P 5683 set -I D03-05=100']);
  });

  it('reads the display register back as the generic on/off', (t) => {
    const { handler } = recording(t);

    handler.handleResponse({ 'D03-02': 'ON', 'D03-05': 100 });
    assert.equal(handler.obj.uil, 1);

    handler.handleResponse({ 'D03-02': 'ON', 'D03-05': 0 });
    assert.equal(handler.obj.uil, 0);
  });
});

describe('setPurifierRotationSpeed mode reset', () => {
  //every setPurifierRotationSpeed call above uses an AC0850-shaped config,
  //which has no mode register; this is the common case, a model that has one
  it('resets TargetAirPurifierState to AUTO on a model with a mode register', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.sendCMD = async () => {};

    await handler.setPurifierRotationSpeed(50);

    assert.deepEqual(updated(handler.purifierService, 'TargetAirPurifierState'), [['TargetAirPurifierState', 0]]);

    handler.kill(true);
  });
});

describe('resendInTurn ordering', () => {
  it('resends contradicted writes in the order queued when no power-on write is pending', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.writeSettle = 0;
    /** @type {string[]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args.join(' '));
    };

    await handler.setPurifierLockPhysicalControls(1);
    await handler.setPurifierRotationSpeed(50);
    sent.length = 0;

    //the device answers, still disagreeing about both, with no power write in play
    await handler.processUpdate(JSON.stringify({ pwr: '0', mode: 'M', cl: false, om: '1' }));
    await waitFor(() => sent.length >= 2, { what: 'both resends' });

    assert.deepEqual(sent, ['-H 192.168.1.142 -P 5683 set cl=true', '-H 192.168.1.142 -P 5683 set om=2']);

    handler.kill(true);
  });
});

describe('revertOptimisticUpdate', () => {
  it('reverts TargetAirPurifierState to the last known mode when a mode write is abandoned', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();

    //the last known reading: manual mode
    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'M', cl: false, om: '2' }));
    handler.purifierService = makeService();

    handler.sendCMD = async () => {
      throw new Error('device unreachable');
    };
    await handler.setPurifierTargetState(1);

    assert.deepEqual(updated(handler.purifierService, 'TargetAirPurifierState'), [
      //the optimistic push, made before the write failed
      ['TargetAirPurifierState', 1],
      //the revert, back to the last known reading (mode: 'M')
      ['TargetAirPurifierState', 0],
    ]);

    handler.kill(true);
  });

  it('reverts RotationSpeed to the last known speed when a speed write is abandoned', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '1' }));
    handler.purifierService = makeService();

    handler.sendCMD = async () => {
      throw new Error('device unreachable');
    };
    await handler.setPurifierRotationSpeed(100);

    //setPurifierRotationSpeed never pushes RotationSpeed itself; only the revert does
    assert.deepEqual(updated(handler.purifierService, 'RotationSpeed'), [['RotationSpeed', 100 / 3]]);

    handler.kill(true);
  });

  it('reverts the humidifier characteristics when a func write is abandoned', async (t) => {
    t.after(silenceLogger);
    captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.humidifierService = makeService();

    //the last known reading: not humidifying
    await handler.processUpdate(
      JSON.stringify({ pwr: '1', mode: 'P', cl: false, om: '2', func: 'P', rh: 40, wl: 100 })
    );
    handler.humidifierService = makeService();

    handler.sendCMD = async () => {
      throw new Error('device unreachable');
    };
    await handler.setHumidifierActive(true);

    assert.deepEqual(updated(handler.humidifierService, 'Active'), [
      //the optimistic push
      ['Active', 1],
      //the revert: the device never confirmed it started humidifying
      ['Active', 0],
    ]);

    handler.kill(true);
  });
});

describe('repeated spawn/stop failures', () => {
  it('stays quiet about a second failure of the same kind', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({ aioairctrlPath: SILENT_SHIM });
    handler.accessory.getService = () => null;
    handler.restartDelay = 5000;

    handler.longPoll();
    await waitFor(() => handler.airControl.pid !== undefined, { what: 'the shim to start' });

    //emit() runs the listener synchronously, so each failure is logged by now
    handler.airControl.emit('error', new Error('kill ESRCH'));
    assert.equal(logs.warn.length, 1);
    assert.equal(logs.error.length, 1);

    //a second failure of the same kind (another failed stop) stays quiet
    handler.airControl.emit('error', new Error('kill ESRCH again'));

    assert.equal(logs.warn.length, 1, 'a repeat of the same failure kind was logged again, expected silence');
    assert.equal(logs.error.length, 1, 'a repeat of the same failure kind was logged again, expected silence');

    handler.kill(true);
  });
});

describe('setter error handling', () => {
  it('logs, rather than throws, when the lock command fails to send', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.sendCMD = async () => {
      throw new Error('device unreachable');
    };

    await assert.doesNotReject(() => handler.setPurifierLockPhysicalControls(1));
    assert.ok(logs.warn.some((line) => line.includes('An error occured during changing lock state!')));

    handler.kill(true);
  });

  it('logs, rather than throws, when the humidifier target-state command fails to send', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.humidifierService = makeService();
    handler.obj = { func: 'P', wl: 100 };
    handler.sendCMD = async () => {
      throw new Error('device unreachable');
    };

    await assert.doesNotReject(() => handler.setHumidifierTargetState(60));
    assert.ok(logs.warn.some((line) => line.includes('An error occured during changing target humidifer state!')));

    handler.kill(true);
  });

  it('logs, rather than throws, when turning the light on fails to send', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.sendCMD = async () => {
      throw new Error('device unreachable');
    };

    await assert.doesNotReject(() => handler.setLightOn(true));
    assert.ok(logs.warn.some((line) => line.includes('An error occured during changing light state!')));
    assert.equal(handler.settingLightState, false, 'the in-flight flag was left set after the failure');
  });

  it('logs, rather than throws, when changing brightness fails to send', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.sendCMD = async () => {
      throw new Error('device unreachable');
    };

    await assert.doesNotReject(() => handler.setLightBrightness(50));
    assert.ok(logs.warn.some((line) => line.includes('An error occured during changing light brightness!')));
    assert.equal(handler.settingBrightness, false, 'the in-flight flag was left set after the failure');
  });

  it('logs when a resend itself fails to send', async (t) => {
    t.after(silenceLogger);
    const logs = captureLogs();

    const handler = makeHandler({});
    handler.purifierService = makeService();
    handler.writeSettle = 0;

    let calls = 0;
    handler.sendCMD = async () => {
      calls += 1;
      if (calls > 1) {
        throw new Error('device unreachable');
      }
    };

    await handler.setPurifierActive(true);
    await handler.processUpdate(JSON.stringify({ pwr: '0', mode: 'M', cl: false, om: '1' }));
    await waitFor(() => logs.error.some((line) => line.includes('device unreachable')), {
      what: 'the failed resend to be reported',
    });

    assert.ok(
      logs.error.some((line) => line.includes('device unreachable')),
      `a failed resend was never reported, got ${JSON.stringify(logs.error)}`
    );

    handler.kill(true);
  });
});

describe('requestRefresh', () => {
  it('does nothing without a running process to refresh', () => {
    const handler = makeHandler({});

    assert.doesNotThrow(() => handler.requestRefresh());
    assert.equal(handler.refreshing, false);
  });
});
