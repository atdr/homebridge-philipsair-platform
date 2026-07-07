'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const logger = require('../src/utils/logger');
const Handler = require('../src/accessories/accessories.handler');

const noop = () => {};
logger.configure({ info: noop, warn: noop, error: noop }, {});

const fakeApi = { hap: { Service: {}, Characteristic: {} } };

const makeHandler = (config) =>
  new Handler(fakeApi, {
    displayName: config.name || 'Test Purifier',
    context: {
      config: { host: '192.168.1.142', port: 5683, debug: false, ...config },
    },
  });

describe('speeds per model', () => {
  it('uses three speeds by default', () => {
    const handler = makeHandler({});
    assert.deepEqual(
      handler.speeds.map((s) => s.om),
      ['1', '2', 't']
    );
    assert.equal(handler.speedsMinStep(), 100 / 3);
  });

  it('adds sleep speed when configured', () => {
    const handler = makeHandler({ sleepSpeed: true });
    assert.deepEqual(
      handler.speeds.map((s) => s.om),
      ['s', '1', '2', 't']
    );
    assert.equal(handler.speedsMinStep(), 25);
  });

  it('uses mode-based speeds for AC3036', () => {
    const handler = makeHandler({ model: 'AC3036' });
    assert.equal(handler.speeds.length, 5);
    assert.deepEqual(handler.speeds[0], { mode: 'S' });
    assert.deepEqual(handler.speeds[2], { mode: 'M', om: 1 });
  });

  it('uses D-register speeds and set flags for AC0850', () => {
    const handler = makeHandler({ model: 'AC0850' });
    assert.equal(handler.speeds.length, 3);
    assert.deepEqual(handler.extraSetFlags, ['-I']);
    assert.equal(handler.keyMaps.pwr, 'D03102');
  });
});

describe('command construction', () => {
  it('builds the base command from host, port and debug', () => {
    const handler = makeHandler({ debug: true });
    assert.ok(handler.args.includes('-H'));
    assert.ok(handler.args.includes('192.168.1.142'));
    assert.ok(handler.args.includes('-P'));
    assert.ok(handler.args.includes(5683));
    assert.ok(handler.args.includes('-D'));
  });

  it('omits the debug flag when disabled', () => {
    const handler = makeHandler({});
    assert.ok(!handler.args.includes('-D'));
  });

  it('maps keys and values through the model maps', () => {
    const handler = makeHandler({ model: 'AC1715' });
    assert.equal(handler.handleCommand('pwr', 1), 'D03-02=ON');
    assert.equal(handler.handleCommand('mode', 'Auto General'), 'D03-12="Auto General"');
  });

  it('passes unmapped keys through unchanged', () => {
    const handler = makeHandler({});
    assert.equal(handler.handleCommand('pwr', 1), 'pwr=1');
  });
});

describe('handleResponse', () => {
  it('remaps device keys back to generic keys', () => {
    const handler = makeHandler({ model: 'AC0850' });
    handler.handleResponse({ D03102: 'ON', D03221: 4, other: 'kept' });

    assert.equal(handler.obj.pwr, 'ON');
    assert.equal(handler.obj.pm25, 4);
    assert.equal(handler.obj.other, 'kept');
    assert.ok(!('D03102' in handler.obj));
  });

  it('translates values through the model value maps', () => {
    const handler = makeHandler({ model: 'AC1715' });
    handler.handleResponse({ 'D03-02': 'ON' });
    assert.equal(handler.obj.pwr, 1);
  });
});

describe('rotationSpeed', () => {
  it('derives the HomeKit percentage from the matching speed entry', () => {
    const handler = makeHandler({});
    handler.obj = { om: '2' };
    assert.equal(handler.rotationSpeed(), 2 * (100 / 3));
  });

  it('matches composite speed entries', () => {
    const handler = makeHandler({ model: 'AC0850' });
    handler.obj = { D0310A: 2, D0310C: 18 };
    handler.handleResponse(handler.obj);
    assert.equal(handler.rotationSpeed(), 100);
  });
});
