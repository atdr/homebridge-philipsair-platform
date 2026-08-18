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
  it('runs aioairctrl from the PATH by default', () => {
    const handler = makeHandler({});
    assert.equal(handler.binary, 'aioairctrl');
  });

  it('honours a configured aioairctrl path', () => {
    const handler = makeHandler({ aioairctrlPath: '/home/pi/.local/bin/aioairctrl' });
    assert.equal(handler.binary, '/home/pi/.local/bin/aioairctrl');
  });

  it('builds the base arguments from host, port and debug', () => {
    const handler = makeHandler({ debug: true });
    assert.deepEqual(handler.args, ['-H', '192.168.1.142', '-P', '5683', '-D']);
  });

  it('omits the debug flag when disabled', () => {
    const handler = makeHandler({});
    assert.ok(!handler.args.includes('-D'));
  });

  it('maps keys and values through the model maps', () => {
    const handler = makeHandler({ model: 'AC1715' });
    assert.equal(handler.handleCommand('pwr', 1), 'D03-02=ON');
    assert.equal(handler.handleCommand('mode', 'Auto General'), 'D03-12=Auto General');
  });

  it('passes unmapped keys through unchanged', () => {
    const handler = makeHandler({});
    assert.equal(handler.handleCommand('pwr', 1), 'pwr=1');
  });
});

describe('unsupported controls', () => {
  const recording = (config) => {
    const handler = makeHandler(config);
    /** @type {string[][]} */
    const sent = [];
    handler.sendCMD = async (args) => {
      sent.push(args);
    };
    handler.purifierService = { updateCharacteristic: () => handler.purifierService };
    return { handler, sent };
  };

  it('reports which generic keys a model has no register for', () => {
    assert.equal(makeHandler({ model: 'AC0850' }).supports('mode'), false);
    assert.equal(makeHandler({ model: 'AC0850' }).supports('cl'), false);
    assert.equal(makeHandler({ model: 'AC0850' }).supports('pwr'), true);
    assert.equal(makeHandler({}).supports('mode'), true);
    assert.equal(makeHandler({}).supports('cl'), true);
  });

  it('sends no mode or lock command to a model without those registers', async () => {
    const { handler, sent } = recording({ model: 'AC0850' });

    await handler.setPurifierTargetState(1);
    await handler.setPurifierLockPhysicalControls(1);

    assert.deepEqual(sent, [], 'a command was sent for a register the model does not have');
    assert.equal(handler.pendingWrites.size, 0);

    handler.kill(true);
  });

  it('still sends both on a model that has them', async () => {
    const { handler, sent } = recording({});

    await handler.setPurifierTargetState(1);
    await handler.setPurifierLockPhysicalControls(1);

    assert.deepEqual(
      sent.map((args) => args[args.length - 1]),
      ['mode=P', 'cl=true']
    );

    handler.kill(true);
  });
});

describe('set argument construction', () => {
  it('keeps -I for a model whose registers need it', () => {
    const handler = makeHandler({ model: 'AC0850' });
    assert.deepEqual(handler.setArgs([handler.handleCommand('pwr', 1)]), [
      '-H',
      '192.168.1.142',
      '-P',
      '5683',
      'set',
      '-I',
      'D03102=1',
    ]);
  });

  it('drops -I when a value cannot be encoded as an integer', () => {
    const handler = makeHandler({ model: 'AC0850' });
    //aioairctrl prints "Cannot encode value 'P' as int" and drops the write
    assert.deepEqual(handler.setArgs([handler.handleCommand('mode', 'P')]), [
      '-H',
      '192.168.1.142',
      '-P',
      '5683',
      'set',
      'mode=P',
    ]);
  });

  it('keeps -I for booleans, which the CLI converts before encoding', () => {
    const handler = makeHandler({ model: 'AC0850' });
    assert.ok(handler.setArgs([handler.handleCommand('cl', false)]).includes('-I'));
  });

  it('keeps a flag a specific command asks for, without duplicating it', () => {
    assert.deepEqual(makeHandler({}).setArgs(['aqil=100'], ['-I']).slice(4), ['set', '-I', 'aqil=100']);
    assert.deepEqual(makeHandler({ model: 'AC0850' }).setArgs(['aqil=100'], ['-I']).slice(4), [
      'set',
      '-I',
      'aqil=100',
    ]);
  });

  it('leaves a command that never asked for -I without it', () => {
    assert.deepEqual(makeHandler({}).setArgs(['uil=1']).slice(4), ['set', 'uil=1']);
  });

  it('drops -I when any value in a composite command is not an integer', () => {
    const handler = makeHandler({ model: 'AC0850' });
    assert.ok(!handler.setArgs(['D0310A=2', 'mode=P']).includes('-I'));
    assert.ok(handler.setArgs(['D0310A=2', 'D0310C=17']).includes('-I'));
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

describe('deviceKnownOff', () => {
  it('is false until the device has said anything', () => {
    assert.equal(makeHandler({}).deviceKnownOff(), false);
  });

  it('follows the last reported power', () => {
    const handler = makeHandler({});

    handler.handleResponse({ pwr: '0' });
    assert.equal(handler.deviceKnownOff(), true);

    handler.handleResponse({ pwr: '1' });
    assert.equal(handler.deviceKnownOff(), false);
  });

  it('reads a model that reports power as a word', () => {
    const handler = makeHandler({ model: 'AC1715' });

    handler.handleResponse({ 'D03-02': 'OFF' });
    assert.equal(handler.deviceKnownOff(), true);
  });

  it('outlives the stream that reported it', () => {
    const handler = makeHandler({});

    handler.handleResponse({ pwr: '0' });
    //longPoll clears receivedData on every restart, and every off-state stall
    //is judged on a stream that has itself answered nothing
    handler.receivedData = false;

    assert.equal(handler.deviceKnownOff(), true);
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
