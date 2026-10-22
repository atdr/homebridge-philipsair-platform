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
    assert.equal(handler.speeds.length, 4);
    assert.deepEqual(handler.speeds[0], { mode: 'S' });
    assert.deepEqual(handler.speeds[1], { mode: 'M', om: 1 });
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

  it('reads AUTO, whatever the status says, on a model with no auto/manual concept', () => {
    //no mapped model is modeless today, but a device with no Auto at all (a fan
    //heater, say) would be: its selector is pinned to AUTO, so it has to read so
    const modeless = makeHandler({ model: 'AC0850' });
    modeless.modeMaps = undefined;
    modeless.obj = { D0310A: 2, D0310C: 17 };

    assert.equal(modeless.inAutoMode(), true);
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
    //in Manual: in Auto the slider shows the last manual step instead
    handler.obj = { mode: 'M', om: '2' };
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

  //a scene captured while the slider read 0% (any model in Auto, before Auto
  //left the slider) stores RotationSpeed 0 beside Active 1, and HAP delivers the two in
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
    assert.deepEqual(sent, ['mode=AG']);

    sent.length = 0;
    await Promise.all([handler.setPurifierTargetState(0), handler.setPurifierRotationSpeed(100)]);
    assert.deepEqual(sent, ['mode=T']);
  });
});

describe('power-on to a device already on', () => {
  //a Home app scene almost always carries Active=1. An AC0850 that is already
  //on ignores the registers merged with that redundant power-on, so a scene
  //asking for Sleep left it in Auto, and the resend repeated the same command
  const ON = { D03102: 1, D0310A: 2, D0310C: 0 };

  it('sends a scene without the power-on to an AC0850 that reports on', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(25)]);

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=17']);
    assert.deepEqual([...handler.pendingWrites.keys()], ['D0310A', 'D0310C']);
  });

  it('still merges the power-on into a scene for an AC0850 that reports off', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON, D03102: 0 });

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(25)]);

    assert.deepEqual(sent, ['-I D03102=1 D0310A=2 D0310C=17']);
  });

  it('still merges the power-on into a scene before any status', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(25)]);

    assert.deepEqual(sent, ['-I D03102=1 D0310A=2 D0310C=17']);
  });

  it('sends nothing for a lone power-on to a device that reports on', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    const logs = capture();
    t.after(() => {
      logs.restore();
      handler.kill(true);
    });
    handler.handleResponse({ ...ON });

    await handler.setPurifierActive(1);

    assert.deepEqual(sent, []);
    assert.equal(handler.pendingWrites.size, 0);
    assert.deepEqual(logs.warn, []);
  });

  it('still sends a power-off to a device that reports on', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await handler.setPurifierActive(0);

    assert.deepEqual(sent, ['-I D03102=0']);
  });

  it('keeps the device on when a scene also carries 0%', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(0)]);

    assert.deepEqual(sent, []);
  });

  it('reads the power of every dialect, including one that reports it as a word', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC1715' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ 'D03-02': 'ON', 'D03-12': 'Auto General' });

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(100)]);

    assert.deepEqual(sent, ['D03-12=Turbo']);
  });

  //Copilot on #134: the device last reported on, but a power-off is pending.
  //Leaving the newer power-on out would let the off notification confirm the
  //older request, and the purifier would stay off against the latest one
  it('sends a power-on that follows a power-off still in flight', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    /** @type {() => void} */
    let finishOff = noop;
    const recorded = handler.sendCMD;
    handler.sendCMD = async (args) => {
      await recorded(args);
      if (args.includes('D03102=0')) {
        await new Promise((resolve) => (finishOff = () => resolve(undefined)));
      }
    };

    const off = handler.setPurifierActive(0);
    //past the coalescing window, so the off is sent and waits to finish
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(sent, ['-I D03102=0']);

    const on = handler.setPurifierActive(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    finishOff();
    await Promise.all([off, on]);

    assert.deepEqual(sent, ['-I D03102=0', '-I D03102=1']);
    assert.equal(Number(handler.pendingWrites.get('pwr')?.expected), 1);
  });

  it('sends a power-on that follows a power-off the device has not confirmed', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await handler.setPurifierActive(0);
    await handler.setPurifierActive(1);

    assert.deepEqual(sent, ['-I D03102=0', '-I D03102=1']);
    assert.equal(Number(handler.pendingWrites.get('pwr')?.expected), 1);
  });

  it('drops the power-on on the default dialect too', async (t) => {
    const { handler, sent } = recordingWrites({});
    t.after(() => handler.kill(true));
    handler.handleResponse({ pwr: '1', mode: 'M', om: '1' });

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(100)]);

    assert.deepEqual(sent, ['om=t']);
  });
});

describe('AC0850 slider around Auto', () => {
  //with #118, 0% means off, so Auto must never read 0%: a scene captured in
  //Auto would replay as off. Without the fan level (D0310D) to show, the
  //slider reads the last manual step instead: 25% Sleep, 100% Turbo
  const AUTO = { D03102: 1, D0310A: 2, D0310C: 0 };

  it('reads Sleep in Auto before any manual step is known', (t) => {
    const { handler } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    handler.obj = { ...AUTO };
    assert.equal(handler.rotationSpeed(), 25);
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
    assert.equal(handler.rotationSpeed(), 25, 'a speed that was never sent became the manual step');

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
    assert.equal(shown.RotationSpeed, 25);
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
    assert.notEqual(shown.RotationSpeed, 25);
  });
});

describe('AC0850 slider follows the fan level', () => {
  //D0310D is the fan's actual level (issue #46): 0 off, 1 in Sleep, 18 in
  //Turbo, and 1, 2, 3 or 18 in Auto. The slider shows it in every mode, and a
  //write rounds to the nearest of its four steps: 25% Sleep, 50% and 75% Auto,
  //100% Turbo. 0% is still off (#118)
  const SLEEP = { D03102: 1, D0310A: 2, D0310C: 17, D0310D: 1 };
  const AUTO = { D03102: 1, D0310A: 2, D0310C: 0 };
  const TURBO = { D03102: 1, D0310A: 2, D0310C: 18, D0310D: 18 };

  it('gives the slider four 25-point steps', () => {
    assert.equal(makeHandler({ model: 'AC0850' }).speedsMinStep(), 25);
  });

  /** @type {[Record<string, number>, number][]} */
  const reads = [
    [SLEEP, 25],
    [{ ...AUTO, D0310D: 1 }, 25],
    [{ ...AUTO, D0310D: 2 }, 50],
    [{ ...AUTO, D0310D: 3 }, 75],
    [{ ...AUTO, D0310D: 18 }, 100],
    [TURBO, 100],
    [{ ...AUTO, D0310D: 0 }, 0],
    [{ ...AUTO, D03102: 0, D0310D: 0 }, 0],
    [{ ...TURBO, D03102: 0 }, 0],
  ];

  for (const [status, expected] of reads) {
    it(`reads ${expected}% from ${JSON.stringify(status)}`, (t) => {
      const { handler } = recordingWrites({ model: 'AC0850' });
      t.after(() => handler.kill(true));

      handler.handleResponse({ ...status });
      assert.equal(handler.rotationSpeed(), expected);
    });
  }

  it('falls back to the last manual step for a level not in the list', (t) => {
    const { handler } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    handler.handleResponse({ ...TURBO });
    handler.rotationSpeed();
    handler.handleResponse({ ...AUTO, D0310D: 7 });
    assert.equal(handler.rotationSpeed(), 100);
  });

  it('keeps the last manual step a fan-level read came from', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    handler.handleResponse({ ...TURBO });
    handler.rotationSpeed();
    handler.handleResponse({ ...AUTO, D0310D: 2 });
    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=18']);
  });

  for (const [value, command, target] of [
    [25, '-I D0310A=2 D0310C=17', 0],
    [50, '-I D0310A=2 D0310C=0', 1],
    [75, '-I D0310A=2 D0310C=0', 1],
    [100, '-I D0310A=2 D0310C=18', 0],
    //1.3.1 scenes, saved on its 33/67/100% slider, round to the nearest step
    [100 / 3, '-I D0310A=2 D0310C=17', 0],
    [200 / 3, '-I D0310A=2 D0310C=0', 1],
    //a value no step produces still selects something, never off
    [5, '-I D0310A=2 D0310C=17', 0],
  ]) {
    it(`writes ${value}% as ${command}, the switch at ${target ? 'AUTO' : 'MANUAL'}`, async (t) => {
      const { handler, sent, shown } = recordingWrites({ model: 'AC0850' });
      t.after(() => handler.kill(true));
      handler.handleResponse({ ...SLEEP });

      await handler.setPurifierRotationSpeed(value);

      assert.deepEqual(sent, [command]);
      assert.equal(shown.TargetAirPurifierState, target);
    });
  }

  it('remembers a manual write as the step Manual restores', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    await handler.setPurifierRotationSpeed(100);
    await handler.setPurifierRotationSpeed(50);
    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=18', '-I D0310A=2 D0310C=0', '-I D0310A=2 D0310C=18']);
  });

  it('still switches off at 0%', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...SLEEP });

    await handler.setPurifierRotationSpeed(0);

    assert.deepEqual(sent, ['-I D03102=0']);
  });

  it('replays a scene of Auto at 25% as Auto', async (t) => {
    const { handler, sent, shown } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...TURBO });

    await Promise.all([handler.setPurifierTargetState(1), handler.setPurifierRotationSpeed(25)]);

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=0']);
    assert.equal(shown.TargetAirPurifierState, 1);
  });

  it('replays a scene of Manual at 100% as Turbo', async (t) => {
    const { handler, sent, shown } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...SLEEP });

    await Promise.all([handler.setPurifierTargetState(0), handler.setPurifierRotationSpeed(100)]);

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=18']);
    assert.equal(shown.TargetAirPurifierState, 0);
  });

  it('replays a scene of Manual at 50% as Auto, and puts the switch back to AUTO', async (t) => {
    const { handler, sent, shown } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...SLEEP });

    //HAP stores MANUAL itself once the switch's own onSet returns
    const manual = handler.setPurifierTargetState(0).then(() => {
      shown.TargetAirPurifierState = 0;
    });
    await Promise.all([manual, handler.setPurifierRotationSpeed(50)]);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=0']);
    assert.equal(shown.TargetAirPurifierState, 1);
  });

  it('sends Auto once when a scene sets it on the switch and at 75%', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...SLEEP });

    await Promise.all([
      handler.setPurifierActive(1),
      handler.setPurifierTargetState(1),
      handler.setPurifierRotationSpeed(75),
    ]);

    assert.deepEqual(sent, ['-I D0310A=2 D0310C=0']);
  });

  it('merges the power-on into an Auto step for a device that is off', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...AUTO, D03102: 0, D0310D: 0 });

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(200 / 3)]);

    assert.deepEqual(sent, ['-I D03102=1 D0310A=2 D0310C=0']);
  });

  it('leaves the other models rounding up to their own steps', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC1715' });
    t.after(() => handler.kill(true));

    await handler.setPurifierRotationSpeed(40);

    assert.deepEqual(sent, ['D03-12=Gentle/Speed 1']);
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

describe('Auto on the selector for every model', () => {
  //the AC0850 approach applied everywhere: Auto is written and read through
  //modeMaps, the slider keeps the manual steps, and Manual restores the last one
  const selector = (config) => {
    const recorded = recordingWrites(config);
    return { ...recorded, pending: () => [...recorded.handler.pendingWrites.keys()] };
  };

  it('writes AC1715 Auto as a word on D03-12, and reads it back', async (t) => {
    const { handler, sent, pending } = selector({ model: 'AC1715' });
    t.after(() => handler.kill(true));

    await handler.setPurifierTargetState(1);
    assert.deepEqual(sent, ['D03-12=Auto General']);
    //expectations are generic key space, which is what the status maps back into
    assert.deepEqual(pending(), ['mode']);

    handler.handleResponse({ 'D03-02': 'ON', 'D03-12': 'Auto General' });
    assert.equal(handler.inAutoMode(), true);
    assert.equal(handler.rotationSpeed(), 25);

    handler.handleResponse({ 'D03-02': 'ON', 'D03-12': 'Speed 2' });
    assert.equal(handler.inAutoMode(), false);
    assert.equal(handler.rotationSpeed(), 75);
  });

  it('restores the last AC1715 manual step on switching to Manual', async (t) => {
    const { handler, sent, shown } = selector({ model: 'AC1715' });
    t.after(() => handler.kill(true));
    handler.handleResponse({ 'D03-02': 'ON', 'D03-12': 'Speed 2' });
    handler.rotationSpeed();
    handler.handleResponse({ 'D03-02': 'ON', 'D03-12': 'Auto General' });

    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['D03-12=Speed 2']);
    assert.equal(shown.RotationSpeed, 75);
  });

  it('writes AC3036 Auto as AG and Manual as the last manual step', async (t) => {
    const { handler, sent } = selector({ model: 'AC3036' });
    t.after(() => handler.kill(true));

    await handler.setPurifierTargetState(1);
    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['mode=AG', 'mode=S']);

    handler.handleResponse({ pwr: '1', mode: 'AG', om: 'a' });
    assert.equal(handler.inAutoMode(), true);
    assert.equal(handler.rotationSpeed(), 25);
    handler.handleResponse({ pwr: '1', mode: 'M', om: '2' });
    assert.equal(handler.inAutoMode(), false);
    assert.equal(handler.rotationSpeed(), 75);
  });

  it('writes the default map Auto as P and Manual as M', async (t) => {
    const { handler, sent } = selector({});
    t.after(() => handler.kill(true));

    await handler.setPurifierTargetState(1);
    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['mode=P', 'mode=M']);
  });

  it('reads the default map in Auto as the last manual step, not the speed Auto chose', (t) => {
    const { handler } = selector({});
    t.after(() => handler.kill(true));

    //before any status the selector reads AUTO and the slider the first step
    assert.equal(handler.inAutoMode(), true);
    assert.equal(handler.rotationSpeed(), 100 / 3);

    handler.handleResponse({ pwr: '1', mode: 'M', om: '2' });
    assert.equal(handler.inAutoMode(), false);
    assert.equal(handler.rotationSpeed(), 200 / 3);

    handler.handleResponse({ pwr: '1', mode: 'P', om: 't' });
    assert.equal(handler.inAutoMode(), true);
    assert.equal(handler.rotationSpeed(), 200 / 3);
  });

  it('sends the allergen mode as Auto, never as Manual, when the option is on', async (t) => {
    const { handler, sent } = selector({ allergicFunc: true });
    t.after(() => handler.kill(true));

    await handler.setPurifierTargetState(1);
    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['mode=A', 'mode=M']);

    handler.handleResponse({ pwr: '1', mode: 'A', om: '1' });
    assert.equal(handler.inAutoMode(), true);
  });

  //the option only chooses which automatic mode Auto sends; both P and A are
  //automatic, and the Philips app can start either, so both read as Auto
  it('reads the allergen mode as Auto when the option is off', (t) => {
    const { handler } = selector({});
    t.after(() => handler.kill(true));

    handler.handleResponse({ pwr: '1', mode: 'A', om: '1' });
    assert.equal(handler.inAutoMode(), true);
  });

  it('reads general Auto as Auto, not Manual at 0%, when the option is on', (t) => {
    const { handler } = selector({ model: 'AC3829', allergicFunc: true });
    t.after(() => handler.kill(true));

    handler.handleResponse({ pwr: '1', mode: 'P', om: '1' });

    assert.equal(handler.inAutoMode(), true);
    assert.notEqual(handler.rotationSpeed(), 0);
  });

  //a status that omits the mode says nothing about Auto, so the speed it does
  //report still counts; only a confirmed Auto hides it
  it('reads the speed from a status that omits the mode', (t) => {
    const { handler } = selector({});
    t.after(() => handler.kill(true));

    assert.equal(handler.rotationSpeed(), 100 / 3, 'before any status: the first step');

    handler.handleResponse({ pwr: '1', om: '2' });
    assert.equal(handler.rotationSpeed(), 200 / 3);

    handler.handleResponse({ pwr: '1', mode: 'M', om: '2' });
    handler.handleResponse({ pwr: '1', om: 't' });
    assert.equal(handler.rotationSpeed(), 100);
  });

  it('ignores the allergic option on a model with no plain allergen mode', async (t) => {
    const { handler, sent } = selector({ model: 'AC3036', allergicFunc: true });
    t.after(() => handler.kill(true));

    await handler.setPurifierTargetState(1);
    await handler.setPurifierTargetState(0);

    assert.deepEqual(sent, ['mode=AG', 'mode=S']);
  });

  it('sends the AC3829 allergen mode as Auto when the option is on', async (t) => {
    const { handler, sent } = selector({ model: 'AC3829', allergicFunc: true });
    t.after(() => handler.kill(true));

    await handler.setPurifierTargetState(1);
    assert.deepEqual(sent, ['mode=A']);

    handler.handleResponse({ pwr: '1', mode: 'A', om: '1' });
    assert.equal(handler.inAutoMode(), true);
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

describe('dash-less child lock and light', () => {
  it('sends the child lock as 1/0 with -I and reads it back as locked', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC2221' });
    t.after(() => handler.kill(true));

    await handler.setPurifierLockPhysicalControls(1);
    await handler.setPurifierLockPhysicalControls(0);
    assert.deepEqual(sent, ['-I D03103=1', '-I D03103=0']);

    handler.handleResponse({ D03102: 1, D03103: 1 });
    assert.equal(handler.obj.cl, true);
    handler.handleResponse({ D03102: 1, D03103: 0 });
    assert.equal(handler.obj.cl, false);
  });

  //both light writes land on the one lamp register, so they must agree
  it('switches the lamp with both light writes agreeing, and reads it back', async (t) => {
    const { handler, sent } = recordingWrites({ model: 'AC4220' });
    t.after(() => handler.kill(true));

    await handler.setLightBrightness(50);
    await handler.setLightOn(false);
    assert.deepEqual(sent, ['-I D03135=1', '-I D03135=1', '-I D03135=0', '-I D03135=0']);

    handler.handleResponse({ D03102: 1, D03135: 2 });
    assert.equal(handler.obj.aqil, 100);
    handler.handleResponse({ D03102: 1, D03135: 0 });
    assert.equal(handler.obj.aqil, 0);
  });
});

//Every model's table, read back through the handler: each speed and each
//automatic mode is written with handleCommand, reported in the device's own
//dialect, and read back through handleResponse. A model whose Auto or a step
//does not survive the trip would show the wrong step or the wrong mode
//Copilot on PR #133: ha-philips-airpurifier gives these models automatic
//presets the selector never writes (pollution P and gas F with om a on the
//AC4550/AC4558, bacteria B on the AC2889, AC3259, AC5659, AC5660). A device
//left in one by the Philips app or the panel is still in an automatic mode,
//so it must read as Auto, not as Manual at 0% that a scene would replay as off
describe('automatic presets the selector does not write', () => {
  const presets = {
    AC4550: [
      { mode: 'P', om: 'a' },
      { mode: 'F', om: 'a' },
    ],
    AC4558: [
      { mode: 'P', om: 'a' },
      { mode: 'F', om: 'a' },
    ],
    AC2889: [{ mode: 'B', om: '2' }],
    AC3259: [{ mode: 'B', om: '1' }],
    AC5659: [{ mode: 'B', om: 's' }],
    AC5660: [{ mode: 'B', om: 't' }],
  };

  for (const [model, statuses] of Object.entries(presets)) {
    it(`reads the ${model} automatic presets as Auto, without writing or offering them`, () => {
      const handler = makeHandler({ model });
      const autoWrite = { ...handler.autoWrite };

      for (const preset of statuses) {
        //as the device reports it: strings, with power and a reading alongside
        handler.handleResponse({ pwr: '1', iaql: '2', ...preset });
        assert.equal(handler.inAutoMode(), true, `${model}: ${JSON.stringify(preset)} reads as Manual`);
        assert.equal(handler.rotationSpeed(), handler.speedsMinStep(), `${model}: the slider left the manual step`);
      }

      assert.deepEqual(handler.autoWrite, autoWrite, `${model}: Auto writes something else now`);
      for (const preset of statuses) {
        assert.ok(
          !Object.values(handler.modeMaps).some((state) => JSON.stringify(state) === JSON.stringify(preset)),
          `${model}: ${JSON.stringify(preset)} became a selectable mode`
        );
      }

      //and a manual step after it still reads as Manual
      handler.handleResponse({ pwr: '1', ...handler.speeds[1] });
      assert.equal(handler.inAutoMode(), false, `${model}: a manual step reads as Auto`);
    });
  }
});

describe('every mapped model round-trips its speeds and Auto', () => {
  const { mappedModels } = require('../src/accessories/accessories.models');

  //what the device reports after a write: the wire pair handleCommand built,
  //with a number where the dialect is numeric
  const reported = (handler, values) => {
    const status = {};
    for (const [key, value] of Object.entries({ pwr: 1, ...values })) {
      const [wireKey, wireValue] = handler.handleCommand(key, value).split('=');
      status[wireKey] = handler.extraSetFlags.includes('-I') ? Number(wireValue) : wireValue;
    }
    return status;
  };

  //the default map is left out: its speeds write om alone, and Manual is its
  //own mode=M, so a speed status there does not say Manual by itself
  for (const model of mappedModels) {
    it(`reads back what it writes (${model})`, () => {
      const handler = makeHandler({ model });

      handler.speeds.forEach((speed, index) => {
        const cmds = Object.entries(speed).map(([key, value]) => handler.handleCommand(key, value));
        assert.ok(
          !handler.extraSetFlags.includes('-I') || handler.intEncodable(cmds),
          `${model}: speed ${index + 1} is not integer encodable`
        );

        handler.handleResponse(reported(handler, speed));
        assert.equal(handler.inAutoMode(), false, `${model}: speed ${index + 1} reads as Auto`);
        //a fan level model shows a speed at the step that writes it, not at its own index
        const step = handler.fanLevel ? handler.fanLevel.steps.findIndex(({ write }) => write === speed) : index;
        assert.ok(step >= 0, `${model}: speed ${index + 1} has no fan level step`);
        assert.equal(handler.rotationSpeed(), (step + 1) * handler.speedsMinStep(), `${model}: speed ${index + 1}`);
      });

      for (const [name, state] of Object.entries(handler.modeMaps)) {
        if (name === 'manual') {
          continue;
        }

        handler.handleResponse(reported(handler, state));
        assert.equal(handler.inAutoMode(), true, `${model}: ${name} does not read as Auto`);
        //in Auto the slider keeps the last manual step: here the top one
        assert.equal(handler.rotationSpeed(), 100, `${model}: ${name} moved the slider`);
      }
    });
  }
});
