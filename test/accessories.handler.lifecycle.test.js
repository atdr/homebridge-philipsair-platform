'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const path = require('node:path');

const logger = require('../src/utils/logger');
const Handler = require('../src/accessories/accessories.handler');

const noop = () => {};
logger.configure({ info: noop, warn: noop, error: noop }, {});

const SHIM = path.join(__dirname, 'fixtures', 'fake-aioairctrl');

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
