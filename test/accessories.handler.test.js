'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

const logger = require('../src/utils/logger');
const Handler = require('../src/accessories/accessories.handler');

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const BROKEN_SHIM = fixture('fake-aioairctrl-broken');
const MISSING = fixture('definitely-not-installed-aioairctrl');

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

  //the device reports om as a number or a string depending on firmware, and
  //rotationSpeed compares stringified values, so both land on the same step
  it('reads the AC3829 speed from mode and om, whichever type om arrives as', () => {
    const handler = makeHandler({ model: 'AC3829' });

    handler.obj = { mode: 'M', om: 3 };
    assert.equal(handler.rotationSpeed(), 80);

    handler.obj = { mode: 'M', om: '3' };
    assert.equal(handler.rotationSpeed(), 80);

    handler.obj = { mode: 'S', om: 's' };
    assert.equal(handler.rotationSpeed(), 20);

    handler.obj = { mode: 'M', om: 't' };
    assert.equal(handler.rotationSpeed(), 100);
  });

  it('uses D-register speeds and set flags for AC0850', () => {
    const handler = makeHandler({ model: 'AC0850' });
    assert.equal(handler.speeds.length, 2);
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

  it('reports an auto/manual concept with or without a mode register', () => {
    //the AC0850 has no 'mode' register, but its modeMaps put Auto on D0310C
    assert.equal(makeHandler({ model: 'AC0850' }).supportsMode(), true);
    assert.equal(makeHandler({}).supportsMode(), true);

    const modeless = makeHandler({ model: 'AC0850' });
    modeless.modeMaps = undefined;
    assert.equal(modeless.supportsMode(), false);
  });

  it('reads AUTO before the device has reported its mode, as a mode register does', () => {
    const ac0850 = makeHandler({ model: 'AC0850' });
    const legacy = makeHandler({});

    //nothing heard yet: both paths have to agree on the default
    assert.equal(legacy.inAutoMode(), true);
    assert.equal(ac0850.inAutoMode(), true);

    ac0850.obj = { D0310A: 2, D0310C: 17 };
    assert.equal(ac0850.inAutoMode(), false);
    ac0850.obj = { D0310A: 2, D0310C: 0 };
    assert.equal(ac0850.inAutoMode(), true);
  });

  it('sends no lock command to a model without that register', async (t) => {
    const { handler, sent } = recording({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    await handler.setPurifierLockPhysicalControls(1);

    assert.deepEqual(sent, [], 'a command was sent for a register the model does not have');
    assert.equal(handler.pendingWrites.size, 0);
  });

  it('sends no mode command to a model with no mode at all', async (t) => {
    const { handler, sent } = recording({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.modeMaps = undefined;

    await handler.setPurifierTargetState(1);

    assert.deepEqual(sent, [], 'a mode command was sent for a model with no mode');
    assert.equal(handler.pendingWrites.size, 0);
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

describe('runCMD execFile failures', () => {
  //these go through execFile directly, unlike longPoll's spawn() path (covered
  //by the -broken shim's use in accessories.handler.lifecycle.test.js): a
  //`set` command hits this path, and no existing shim variant drove it
  it('reports a missing binary as unrunnable, the same as a spawn failure would', async () => {
    const handler = makeHandler({ aioairctrlPath: MISSING });

    await assert.rejects(() => handler.runCMD(['--help']), /not found/);
  });

  it('rejects with the raw error for a command that fails for no known reason', async () => {
    //an installed, executable binary (so not ENOENT/EACCES) that simply exits
    //non-zero: neither the unrunnable-binary case nor a timeout
    const handler = makeHandler({ aioairctrlPath: BROKEN_SHIM });

    await assert.rejects(
      () => handler.runCMD(['set', 'pwr=1']),
      (/** @type {Error} */ err) => {
        assert.ok(
          !/not found|could not be executed/.test(err.message),
          `got unrunnable-binary wording: ${err.message}`
        );
        return true;
      }
    );
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

//records what each write sends (the arguments after 'set') and the last value
//pushed to each purifier characteristic
const recordingWrites = (config) => {
  const handler = makeHandler(config);
  handler.api = {
    ...fakeApi,
    hap: {
      ...fakeApi.hap,
      Characteristic: {
        Active: 'Active',
        CurrentAirPurifierState: 'CurrentAirPurifierState',
        TargetAirPurifierState: 'TargetAirPurifierState',
        RotationSpeed: 'RotationSpeed',
      },
    },
  };
  /** @type {string[]} */
  const sent = [];
  handler.sendCMD = async (args) => {
    sent.push(args.slice(args.indexOf('set') + 1).join(' '));
  };
  /** @type {Record<string, unknown>} */
  const shown = {};
  handler.purifierService = {
    updateCharacteristic: (name, value) => {
      shown[name] = value;
      return handler.purifierService;
    },
  };
  return { handler, sent, shown };
};

describe('rotation speed 0', () => {
  const recording = recordingWrites;

  it('switches the purifier off, as HomeKit means by 0%', async (t) => {
    const { handler, sent } = recording({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    await handler.setPurifierRotationSpeed(0);

    assert.deepEqual(sent, ['-I D03102=0']);
  });

  it('shows the accessory inactive straight away', async (t) => {
    const { handler, shown } = recording({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    await handler.setPurifierRotationSpeed(0);

    //HAP only updates Active itself when the write came through Active's own
    //onSet; arriving via RotationSpeed, nothing else would
    assert.equal(shown.Active, 0);
    assert.equal(shown.CurrentAirPurifierState, 0);
  });

  //a scene captured while the slider read 0% (a legacy model in auto mode, for
  //one) stores RotationSpeed 0 beside Active 1, and HAP delivers the two in
  //no guaranteed order
  for (const order of ['power first', 'speed first']) {
    it(`lets a power-on in the same scene win (${order})`, async (t) => {
      const { handler, sent, shown } = recording({ model: 'AC0850' });
      t.after(() => handler.kill(true));

      const writes =
        order === 'power first'
          ? [handler.setPurifierActive(1), handler.setPurifierRotationSpeed(0)]
          : [handler.setPurifierRotationSpeed(0), handler.setPurifierActive(1)];
      await Promise.all(writes);

      assert.deepEqual(sent, ['-I D03102=1']);
      assert.notEqual(shown.Active, 0);
    });
  }
});

describe('mode and speed in one scene', () => {
  //a scene captured in Auto stores TargetAirPurifierState AUTO beside a
  //RotationSpeed, and HAP delivers the two as separate onSet calls in no
  //fixed order. On the AC0850 both write D0310A/D0310C, so one has to give way
  for (const order of ['mode first', 'speed first']) {
    it(`lets Auto win over a speed (${order})`, async (t) => {
      const { handler, sent, shown } = recordingWrites({ model: 'AC0850' });
      t.after(() => handler.kill(true));

      const writes =
        order === 'mode first'
          ? [handler.setPurifierTargetState(1), handler.setPurifierRotationSpeed(100)]
          : [handler.setPurifierRotationSpeed(100), handler.setPurifierTargetState(1)];
      await Promise.all(writes);

      assert.deepEqual(sent, ['-I D0310A=2 D0310C=0']);
      assert.equal(shown.TargetAirPurifierState, 1);
    });

    it(`lets a speed win over Manual (${order})`, async (t) => {
      const { handler, sent, shown } = recordingWrites({ model: 'AC0850' });
      t.after(() => handler.kill(true));

      const writes =
        order === 'mode first'
          ? [handler.setPurifierTargetState(0), handler.setPurifierRotationSpeed(100)]
          : [handler.setPurifierRotationSpeed(100), handler.setPurifierTargetState(0)];
      await Promise.all(writes);

      assert.deepEqual(sent, ['-I D0310A=2 D0310C=18']);
      assert.equal(shown.TargetAirPurifierState, 0);
    });
  }

  it('keeps the power-on of a scene that also sets Auto and a speed', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    await Promise.all([
      handler.setPurifierActive(1),
      handler.setPurifierTargetState(1),
      handler.setPurifierRotationSpeed(100),
    ]);

    assert.deepEqual(sent, ['-I D03102=1 D0310A=2 D0310C=0']);
  });

  it('applies the same rule to a model whose speeds carry the mode register', async (t) => {
    //AC3036 speeds are modes ('T' is Turbo), so Auto and Turbo both write 'mode'
    const { handler, sent } = recordingWrites({ model: 'AC3036' });
    t.after(() => handler.kill(true));

    await Promise.all([handler.setPurifierRotationSpeed(100), handler.setPurifierTargetState(1)]);
    assert.deepEqual(sent, ['mode=P']);

    sent.length = 0;
    await Promise.all([handler.setPurifierTargetState(0), handler.setPurifierRotationSpeed(100)]);
    assert.deepEqual(sent, ['mode=T']);
  });
});

describe('AC0850 slider around Auto', () => {
  //with #118, 0% means off, so Auto must never read 0%: a scene captured in
  //Auto would replay as off. The slider reads the last manual step instead
  const AUTO = { D03102: 1, D0310A: 2, D0310C: 0 };

  it('reads Sleep in Auto before any manual step is known', (t) => {
    const { handler } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    handler.obj = { ...AUTO };
    assert.equal(handler.rotationSpeed(), 50);
  });

  it('reads the last manual step the device reported', (t) => {
    const { handler } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    handler.obj = { ...AUTO, D0310C: 18 };
    assert.equal(handler.rotationSpeed(), 100);
    handler.obj = { ...AUTO };
    assert.equal(handler.rotationSpeed(), 100);
  });

  it('reads the last manual step it was set to, but not one dropped for Auto', async (t) => {
    const { handler } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.obj = { ...AUTO };

    await Promise.all([handler.setPurifierTargetState(1), handler.setPurifierRotationSpeed(100)]);
    assert.equal(handler.rotationSpeed(), 50, 'a speed that was never sent became the manual step');

    await handler.setPurifierRotationSpeed(100);
    assert.equal(handler.rotationSpeed(), 100);
  });

  it('shows the last manual step, not 0%, on switching to Auto', async (t) => {
    const { handler, shown } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.obj = { ...AUTO, D0310C: 18 };
    handler.rotationSpeed();

    await handler.setPurifierTargetState(1);

    assert.equal(shown.RotationSpeed, 100);
  });

  it('restores Sleep on switching to Manual before any manual step is known', async (t) => {
    const { handler, sent, shown } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.obj = { ...AUTO };

    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=17']);
    assert.equal(shown.RotationSpeed, 50);
  });

  it('restores the last manual step on switching to Manual', async (t) => {
    const { handler, sent, shown } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.obj = { ...AUTO, D0310C: 18 };
    handler.rotationSpeed();
    handler.obj = { ...AUTO };

    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=18']);
    assert.equal(shown.RotationSpeed, 100);
  });

  it('leaves the slider to a speed that replaced the Manual restore', async (t) => {
    const { handler, shown } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.obj = { ...AUTO };

    await Promise.all([handler.setPurifierTargetState(0), handler.setPurifierRotationSpeed(100)]);

    //HAP stores 100 itself once the speed's onSet returns; the restore must not show Sleep
    assert.notEqual(shown.RotationSpeed, 50);
  });
});

describe('AC3829 mode and slider', () => {
  //its speeds carry mode M (and S for sleep), so an Auto status matches none of
  //them: without modeMaps the slider would read 0%, which #118 turns into off
  it('reads a step, not 0%, in Auto', (t) => {
    const { handler } = recordingWrites({ model: 'AC3829' });
    t.after(() => handler.kill(true));

    handler.obj = { pwr: '1', mode: 'P', om: '1' };

    assert.equal(handler.inAutoMode(), true);
    assert.notEqual(handler.rotationSpeed(), 0);
  });

  it('reads Sleep as a manual step', (t) => {
    const { handler } = recordingWrites({ model: 'AC3829' });
    t.after(() => handler.kill(true));

    handler.obj = { pwr: '1', mode: 'S', om: 's' };

    assert.equal(handler.inAutoMode(), false);
    assert.equal(handler.rotationSpeed(), 20);
  });

  it('replays a scene captured in Sleep as Sleep', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC3829' });
    t.after(() => handler.kill(true));

    await Promise.all([handler.setPurifierTargetState(0), handler.setPurifierRotationSpeed(20)]);

    assert.deepEqual(sent, ['mode=S om=s']);
  });

  it('switches to Auto with mode P', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC3829' });
    t.after(() => handler.kill(true));

    await handler.setPurifierTargetState(1);

    assert.deepEqual(sent, ['mode=P']);
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
