'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const logger = require('../src/utils/logger');
const Handler = require('../src/accessories/accessories.handler');

const noop = () => {};
logger.configure({ info: noop, warn: noop, error: noop }, {});

//accessories written back to Homebridge's cache, which is how a detected model
//survives a restart that is not a clean shutdown
const persisted = [];
const fakeApi = {
  hap: { Service: {}, Characteristic: {} },
  updatePlatformAccessories: (accessories) => persisted.push(...accessories),
};

// capture what one call logs, then put the silence back
const capture = () => {
  const info = [];
  const warn = [];

  logger.configure({ info: (message) => info.push(message), warn: (message) => warn.push(message), error: noop }, {});

  return { info, warn, restore: () => logger.configure({ info: noop, warn: noop, error: noop }, {}) };
};

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

describe('unrunnable binary reporting', () => {
  //ENOENT and EACCES reach the same code paths but have nothing in common:
  //one means install it, the other means it is already installed and the
  //Homebridge user may not run it. One message for both sends half the
  //readers after an install that is working fine.
  it('tells a user with no binary to install it', () => {
    const handler = makeHandler({});
    const message = handler.unrunnableBinaryError('ENOENT').message;

    assert.match(message, /not found/);
    assert.match(message, /pipx install aioairctrl/);
    assert.match(message, /aioairctrlPath/);
  });

  it('tells a user with an unexecutable binary about permissions, not installing', () => {
    const handler = makeHandler({ aioairctrlPath: '/home/pi/.local/bin/aioairctrl' });
    const message = handler.unrunnableBinaryError('EACCES').message;

    assert.match(message, /could not be executed/);
    assert.match(message, /ls -l \/home\/pi\/\.local\/bin\/aioairctrl/);
    assert.doesNotMatch(message, /pipx install/);
  });

  it('treats EPERM like EACCES', () => {
    const handler = makeHandler({});
    assert.match(handler.unrunnableBinaryError('EPERM').message, /could not be executed/);
  });

  it('names the binary it could not run', () => {
    const handler = makeHandler({ aioairctrlPath: '/opt/aioairctrl' });
    assert.match(handler.unrunnableBinaryError('ENOENT').message, /^\/opt\/aioairctrl not found/);
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

  it('builds the base arguments from host, port and cliDebug', () => {
    const handler = makeHandler({ cliDebug: true });
    assert.deepEqual(handler.args, ['-H', '192.168.1.142', '-P', '5683', '-D']);
  });

  it('omits the CLI debug flag when disabled', () => {
    const handler = makeHandler({});
    assert.ok(!handler.args.includes('-D'));
  });

  it("does not pass -D for the plugin's own debug option", () => {
    //the two were one switch until #63: aioairctrl's log is four times the
    //volume of the plugin's, and a user debugging a device is not debugging the CLI
    const handler = makeHandler({ debug: true });
    assert.ok(!handler.args.includes('-D'));
  });

  it('passes -D once when both debug options are on', () => {
    const handler = makeHandler({ debug: true, cliDebug: true });
    assert.deepEqual(handler.args, ['-H', '192.168.1.142', '-P', '5683', '-D']);
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

describe('captured stderr', () => {
  it('drops the CLI progress records that -D writes', () => {
    const handler = makeHandler({});

    handler.captureStderr('DEBUG:aioairctrl.coap.client:syncing\nINFO:aioairctrl.coap.client:connected\n');

    assert.equal(handler.reportableStderr(), '');
  });

  it('keeps records the CLI logs as a problem', () => {
    const handler = makeHandler({});

    handler.captureStderr('DEBUG:aioairctrl.coap.client:syncing\nERROR:aioairctrl.coap.client:sync failed\n');

    assert.equal(handler.reportableStderr(), 'ERROR:aioairctrl.coap.client:sync failed');
  });

  it('keeps a traceback written straight to stderr', () => {
    const handler = makeHandler({});

    handler.captureStderr('DEBUG:aioairctrl.coap.client:syncing\n');
    handler.captureStderr('Traceback (most recent call last):\n  File "cli.py", line 1\n');
    //no trailing newline: the line naming the exception arrives as the process dies
    handler.captureStderr("ModuleNotFoundError: No module named 'aioairctrl'");

    const reported = handler.reportableStderr();

    assert.ok(reported.startsWith('Traceback (most recent call last):'), reported);
    assert.ok(reported.endsWith("ModuleNotFoundError: No module named 'aioairctrl'"), reported);
  });

  it('judges a record split across two chunks by its whole line', () => {
    const handler = makeHandler({});

    handler.captureStderr('DEBUG:aioairctrl.coap.');
    handler.captureStderr('client:syncing\n');

    assert.equal(handler.reportableStderr(), '');
  });

  it('drops a progress record still waiting for its newline', () => {
    const handler = makeHandler({});

    handler.captureStderr('DEBUG:aioairctrl.coap.client:syncing');

    assert.equal(handler.reportableStderr(), '');
  });

  it('keeps output that is not a log record at all', () => {
    const handler = makeHandler({});

    handler.captureStderr('bash: aioairctrl: Permission denied\n');

    assert.equal(handler.reportableStderr(), 'bash: aioairctrl: Permission denied');
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

describe('model mapping check', () => {
  //a real AC0850/31 dump, from the register inventory on issue #46
  const ac0850Status = () => ({
    D01102: 5,
    D03102: 0,
    D0310A: 2,
    D0310C: 0,
    D03120: 1,
    D03221: 11,
    D05408: 4800,
    D0540E: 251,
  });

  it('reports a device whose registers belong to another model, once', () => {
    const handler = makeHandler({ name: 'Bedroom', model: 'Air Purifier' });
    const { warn, restore } = capture();

    handler.handleResponse(ac0850Status());
    handler.handleResponse(ac0850Status());
    restore();

    assert.equal(warn.length, 1);
    assert.ok(warn[0].includes('match the AC0850 mapping'));
    assert.ok(warn[0].includes('set to AC0850'));
    assert.equal(handler.accessory.context.detectedModel, 'AC0850');
    //without this the finding is only flushed on a clean shutdown
    assert.ok(persisted.includes(handler.accessory));
  });

  it('says nothing when the configured model reads the device', () => {
    const handler = makeHandler({ name: 'Bedroom', model: 'AC0850' });
    const { warn, restore } = capture();

    handler.handleResponse(ac0850Status());
    restore();

    assert.deepEqual(warn, []);
    assert.equal(handler.accessory.context.detectedModel, undefined);
  });

  it('waits for a status substantial enough to judge', () => {
    const handler = makeHandler({ name: 'Bedroom' });
    const { warn, restore } = capture();

    handler.handleResponse({ D03102: 0, D0310A: 2 });
    assert.deepEqual(warn, []);

    handler.handleResponse(ac0850Status());
    restore();

    assert.equal(warn.length, 1);
  });

  it('takes a device at its word when it names itself', () => {
    const handler = makeHandler({ name: 'Bedroom', model: 'AC1715' });
    const { warn, restore } = capture();

    //the model field a real AC0850/31 reports, alongside its owner-set name
    handler.handleResponse({ D01S03: 'Bedroom', D01S05: 'AC0850/31', D01102: 5, D03102: 1 });
    restore();

    assert.equal(warn.length, 1);
    assert.ok(warn[0].includes('reports itself as AC0850'));
    assert.equal(handler.accessory.context.detectedModel, 'AC0850');
  });

  it('asks for an issue when the registers match nothing it knows', () => {
    const handler = makeHandler({ name: 'Bedroom' });
    const { warn, restore } = capture();

    handler.handleResponse({ 'D09-01': 1, 'D09-02': 2, 'D09-03': 3 });
    restore();

    assert.equal(warn.length, 1);
    assert.ok(warn[0].includes('no model mapping in this plugin knows'));
  });

  it('adopts a model detected on an earlier run while the config names none', () => {
    const { info, restore } = capture();
    const handler = new Handler(fakeApi, {
      displayName: 'Bedroom',
      context: { config: { host: '192.168.1.142', port: 5683 }, detectedModel: 'AC0850' },
    });
    restore();

    assert.equal(handler.keyMaps.pwr, 'D03102');
    assert.ok(info.some((message) => message.includes('detected from this device')));
  });

  it('leaves a configured model alone, whatever was detected before', () => {
    const handler = new Handler(fakeApi, {
      displayName: 'Bedroom',
      context: { config: { host: '192.168.1.142', port: 5683, model: 'AC1715' }, detectedModel: 'AC0850' },
    });

    assert.equal(handler.keyMaps.pwr, 'D03-02');
  });
});
