'use strict';

//Dragging the fan speed slider sends every step it passes through, then the
//last one, and each write makes the purifier beep. On the AC0850 the lowest
//step is Sleep, so a drag detoured through Sleep on its way to Auto (issue
//#150). RotationSpeed writes therefore wait for the slider to settle, and only
//the last value goes out. These pin that, and that the wait never splits a
//scene's power-on from its speed, which these devices punish by dropping one
//of the two (issue #82).
//
//HomeKit sends the next slider value only once the previous onSet has
//resolved (seen on an AC0850 running 2.1.0-beta.1: every value of four drags
//became its own set, about a second apart). So the slider's setter resolves
//at once and its write waits on its own; `homekit` below models that.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const logger = require('../src/utils/logger');
const Handler = require('../src/accessories/accessories.handler');

const noop = () => {};
logger.configure({ info: noop, warn: noop, error: noop }, {});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HapStatusError extends Error {
  constructor(status) {
    super(`HAP Status Error: ${status}`);
    this.hapStatus = status;
  }
}
const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402 };

const fakeApi = {
  hap: {
    Service: {},
    Characteristic: new Proxy({}, { get: (target, prop) => prop }),
    HapStatusError,
    HAPStatus,
  },
  updatePlatformAccessories: () => {},
};

const COALESCE = 5;
const DEBOUNCE = 60;

//an AC0850 whose sends are recorded, with both windows shortened. Its slider
//is 25% Sleep, 50% and 75% Auto, 100% Turbo
const recording = ({ fail = false, ...config } = {}) => {
  const handler = new Handler(fakeApi, {
    displayName: 'Debounced Purifier',
    context: { config: { host: '192.168.1.142', port: 5683, debug: false, model: 'AC0850', ...config } },
  });
  handler.writeCoalesceWindow = COALESCE;
  handler.speedDebounceWindow = DEBOUNCE;

  /** @type {string[]} */
  const sent = [];
  handler.sendCMD = async (args) => {
    sent.push(args.slice(args.indexOf('set') + 1).join(' '));
    if (fail) {
      throw new Error('aioairctrl rejected the command');
    }
  };

  /** @type {Record<string, unknown>} */
  const shown = {};
  handler.purifierService = {
    updateCharacteristic: (name, value) => {
      shown[name] = value;
      return handler.purifierService;
    },
  };

  //the slider's setter resolves before its write goes out, so a test that
  //means "once it is written" waits for the write itself
  let lastWrite = Promise.resolve();
  const write = handler.writeRotationSpeed.bind(handler);
  handler.writeRotationSpeed = (value) => (lastWrite = write(value));
  const settled = async () => {
    while (handler.pendingSpeed) {
      await delay(1);
    }
    await lastWrite.catch(() => {});
    await delay(COALESCE * 2);
  };

  return { handler, sent, shown, settled };
};

//HomeKit as the AC0850 test showed it: the next value of a drag is sent only
//once the previous onSet has resolved, and HAP-nodejs then stores the value it
//was given as the characteristic's cached value
const homekit = (handler, shown) => {
  const onSet = async (value) => {
    await handler.setPurifierRotationSpeed(value);
    shown.RotationSpeed = value;
  };
  const drag = async (values) => {
    for (const value of values) {
      await onSet(value);
    }
  };
  return { onSet, drag };
};

const SLEEP = '-I D0310A=2 D0310C=17';
const AUTO = '-I D0310A=2 D0310C=0';
const TURBO = '-I D0310A=2 D0310C=18';
const POWER_ON = '-I D03102=1';
const ON = { D03102: 1, D0310A: 2, D0310C: 0 };
//the AC0850 reading Turbo, which its slider shows as 100%
const RUNNING = { D03102: 1, D0310A: 2, D0310C: 18, D0310D: 18 };

const communicationFailure = (err) =>
  err instanceof HapStatusError && err.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE;

describe('fan speed slider debounce', () => {
  it('waits about 350ms by default', () => {
    const handler = new Handler(fakeApi, {
      displayName: 'Default Purifier',
      context: { config: { host: '192.168.1.142', port: 5683 } },
    });
    assert.equal(handler.speedDebounceWindow, 350);
  });

  it('sends a drag HomeKit delivers one value at a time as one command, with the last value', async (t) => {
    const { handler, sent, shown, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });
    const { drag } = homekit(handler, shown);

    await drag([25, 50, 75, 100]);
    await settled();

    assert.deepEqual(sent, [TURBO]);
    assert.equal(shown.RotationSpeed, 100);
  });

  it('sends the drag from issue #150, through Sleep to the Auto step, as Auto alone', async (t) => {
    const { handler, sent, shown, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await homekit(handler, shown).drag([25, 75]);
    await settled();

    assert.deepEqual(sent, [AUTO]);
  });

  it('lets the last value win even where an earlier one would outrank it', async (t) => {
    //Auto outranks a speed in a scene, but a drag down from the Auto step to
    //Sleep means Sleep
    const { handler, sent, shown, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await homekit(handler, shown).drag([75, 50, 25]);
    await settled();

    assert.deepEqual(sent, [SLEEP]);
    assert.equal(shown.TargetAirPurifierState, 0);
  });

  it('sends five repeats of one value as one command', async (t) => {
    const { handler, sent, shown, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await homekit(handler, shown).drag([50, 50, 50, 50, 50]);
    await settled();

    assert.deepEqual(sent, [AUTO]);
  });

  it('restarts the wait on every new value', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    for (const value of [25, 50, 75, 100, 25, 100]) {
      await handler.setPurifierRotationSpeed(value);
      await delay(DEBOUNCE / 2);
    }
    //the drag has lasted far longer than one window, and nothing has gone out
    assert.deepEqual(sent, []);

    await settled();
    assert.deepEqual(sent, [TURBO]);
  });

  it('resolves at once and sends a lone tap once the window has passed', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await handler.setPurifierRotationSpeed(100);
    assert.deepEqual(sent, []);
    await delay(DEBOUNCE / 2);
    assert.deepEqual(sent, []);

    await settled();
    assert.deepEqual(sent, [TURBO]);
  });

  it('shows the new value on the slider straight away', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    handler.setPurifierRotationSpeed(25);
    assert.equal(shown.RotationSpeed, 25);
  });

  it('keeps every other write on the short coalescing window', async (t) => {
    const { handler, sent } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON, D03102: 0 });

    await handler.setPurifierActive(1);
    await delay(COALESCE * 2);

    assert.deepEqual(sent, [POWER_ON]);
  });
});

describe('fan speed debounce in a scene', () => {
  //HomeKit delivers a scene's characteristics as separate onSet calls within
  //milliseconds of each other. These devices drop the second of two writes sent
  //a second apart (issue #82), so the power-on must go out with the speed, in
  //the same flush, and never on its own while the speed waits
  for (const order of ['power first', 'speed first']) {
    it(`sends a power-on and a speed together to a device that is off (${order})`, async (t) => {
      const { handler, sent, settled } = recording();
      t.after(() => handler.kill(true));
      handler.handleResponse({ ...ON, D03102: 0 });

      const writes =
        order === 'power first'
          ? [handler.setPurifierActive(1), handler.setPurifierRotationSpeed(25)]
          : [handler.setPurifierRotationSpeed(25), handler.setPurifierActive(1)];

      //well past the power-on's own window: it is held for the speed
      await delay(DEBOUNCE / 2);
      assert.deepEqual(sent, []);

      await Promise.all(writes);
      await settled();
      //one flush: the power write goes last, on its own (#117)
      assert.deepEqual(sent, [SLEEP, POWER_ON]);
    });
  }

  it('holds a power-on that arrives after the speed, past its own window', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON, D03102: 0 });

    handler.setPurifierRotationSpeed(100);
    await delay(COALESCE);
    const power = handler.setPurifierActive(1);
    await delay(COALESCE * 3);
    assert.deepEqual(sent, []);

    await power;
    await settled();
    assert.deepEqual(sent, [TURBO, POWER_ON]);
  });

  it('sends a scene to a device already on as one command', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(25)]);
    await settled();

    assert.deepEqual(sent, [SLEEP]);
  });

  it('lets a power-on win over a 0% in the same scene', async (t) => {
    const { handler, sent, shown, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON, D03102: 0 });

    await Promise.all([handler.setPurifierRotationSpeed(0), handler.setPurifierActive(1)]);
    await settled();

    assert.deepEqual(sent, [POWER_ON]);
    assert.notEqual(shown.Active, 0);
  });

  for (const order of ['mode first', 'speed first']) {
    it(`lets Auto win over a speed (${order})`, async (t) => {
      const { handler, sent, shown, settled } = recording();
      t.after(() => handler.kill(true));
      handler.handleResponse({ ...ON, D0310C: 18 });

      const writes =
        order === 'mode first'
          ? [handler.setPurifierTargetState(1), handler.setPurifierRotationSpeed(100)]
          : [handler.setPurifierRotationSpeed(100), handler.setPurifierTargetState(1)];
      await Promise.all(writes);
      await settled();

      assert.deepEqual(sent, [AUTO]);
      assert.equal(shown.TargetAirPurifierState, 1);
    });

    it(`lets a speed win over Manual (${order})`, async (t) => {
      const { handler, sent, shown, settled } = recording();
      t.after(() => handler.kill(true));
      handler.handleResponse({ ...ON });

      const writes =
        order === 'mode first'
          ? [handler.setPurifierTargetState(0), handler.setPurifierRotationSpeed(100)]
          : [handler.setPurifierRotationSpeed(100), handler.setPurifierTargetState(0)];
      await Promise.all(writes);
      await settled();

      assert.deepEqual(sent, [TURBO]);
      assert.equal(shown.TargetAirPurifierState, 0);
    });
  }

  it('rejects the power-on of a scene whose send fails, and snaps the slider back', async (t) => {
    const { handler, shown, settled } = recording({ fail: true });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING, D03102: 0 });

    const power = handler.setPurifierActive(1);
    await handler.setPurifierRotationSpeed(25);

    await assert.rejects(power, communicationFailure);
    await settled();
    //off reads as 0% on the AC0850
    assert.equal(shown.RotationSpeed, 0);
  });
});

describe('fan speed debounce on shutdown', () => {
  it('sends a speed still waiting when the handler is killed, rather than stranding it', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });
    handler.speedDebounceWindow = 60 * 1000;

    await handler.setPurifierRotationSpeed(100);
    handler.kill(true);
    await settled();

    assert.deepEqual(sent, [TURBO]);
  });
});

describe('the slider while a speed waits', () => {
  it('answers a read with the requested value, not the last reading', async (t) => {
    const { handler } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await handler.setPurifierRotationSpeed(25);
    assert.equal(handler.rotationSpeed(), 25);
  });

  it('keeps the requested value through a status that arrives while it waits', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await handler.setPurifierRotationSpeed(25);
    await handler.processUpdate(JSON.stringify(RUNNING));
    assert.equal(shown.RotationSpeed, 25);
  });
});

describe('a failed slider write', () => {
  //the setter has long since resolved, so there is no onSet left to reject:
  //the slider goes back to what the device last reported instead
  for (const [name, value] of [
    ['a speed', 25],
    ['an Auto step', 50],
    ['0%', 0],
  ]) {
    it(`snaps the slider back to the last reading when ${name} fails`, async (t) => {
      const { handler, shown, settled } = recording({ fail: true });
      t.after(() => handler.kill(true));
      handler.handleResponse({ ...RUNNING });

      await handler.setPurifierRotationSpeed(value);
      await settled();

      assert.equal(shown.RotationSpeed, 100);
      assert.notEqual(shown.Active, 0);
    });
  }

  it('leaves a newer request on the slider when an earlier 0% write fails', async (t) => {
    const { handler, shown, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    //the 0% goes out and fails only once a newer value is already waiting
    /** @type {(err: Error) => void} */
    let failSend = () => {};
    handler.sendCMD = () => new Promise((resolve, reject) => (failSend = reject));
    await handler.setPurifierRotationSpeed(0);
    await delay(DEBOUNCE + COALESCE * 2);
    await handler.setPurifierRotationSpeed(25);

    failSend(new Error('aioairctrl rejected the command'));
    await delay(COALESCE);
    assert.equal(shown.RotationSpeed, 25);

    handler.sendCMD = async () => {};
    await settled();
  });

  it('leaves a newer speed already sent on the slider when an earlier 0% write fails', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    //both writes go out; the 0% fails only after the newer speed is on its way
    /** @type {((err: Error) => void)[]} */
    const fails = [];
    handler.sendCMD = () => new Promise((resolve, reject) => fails.push(reject));
    await handler.setPurifierRotationSpeed(0);
    await delay(DEBOUNCE + COALESCE * 2);
    await handler.setPurifierRotationSpeed(25);
    await delay(DEBOUNCE + COALESCE * 2);
    assert.equal(fails.length, 2);

    fails[0](new Error('aioairctrl rejected the command'));
    await delay(COALESCE);
    assert.equal(shown.RotationSpeed, 25);

    fails[1](new Error('aioairctrl rejected the command'));
    await delay(COALESCE);
  });
});

describe('a slider value already asked for', () => {
  //a slow drag repeats one value, and on the AC0850 50% and 75% are the same
  //Auto step. Seen on 2.1.0-beta.1: 50 five times in three seconds, each an
  //identical set, each a beep. A value whose command is already pending, or
  //was sent and not contradicted, is not sent again
  const AUTO_READING = { D03102: 1, D0310A: 2, D0310C: 0, D0310D: 2 };
  const SLEEP_READING = { D03102: 1, D0310A: 2, D0310C: 17, D0310D: 1 };

  const setAndSettle = async (handler, settled, value) => {
    await handler.setPurifierRotationSpeed(value);
    await settled();
  };

  it('is not sent again while the same command is still unconfirmed', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await setAndSettle(handler, settled, 50);
    await setAndSettle(handler, settled, 50);

    assert.deepEqual(sent, [AUTO]);
  });

  it('treats another value on the same step as the same request', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await setAndSettle(handler, settled, 50);
    await setAndSettle(handler, settled, 75);

    assert.deepEqual(sent, [AUTO]);
  });

  it('is not sent again once the device has confirmed it', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.writeSettle = 0;
    handler.handleResponse({ ...RUNNING });

    await setAndSettle(handler, settled, 50);
    await handler.processUpdate(JSON.stringify(AUTO_READING));
    assert.equal(handler.pendingWrites.size, 0);
    await setAndSettle(handler, settled, 50);

    assert.deepEqual(sent, [AUTO]);
  });

  it('is sent again once the device reports something else', async (t) => {
    //confirmed, then changed on the purifier's own panel
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.writeSettle = 0;
    handler.handleResponse({ ...RUNNING });

    await setAndSettle(handler, settled, 50);
    await handler.processUpdate(JSON.stringify(AUTO_READING));
    await handler.processUpdate(JSON.stringify(SLEEP_READING));
    await setAndSettle(handler, settled, 50);

    assert.deepEqual(sent, [AUTO, AUTO]);
  });

  it('is sent again after the first attempt failed', async (t) => {
    const { handler, sent, settled } = recording({ fail: true });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await setAndSettle(handler, settled, 25);
    await setAndSettle(handler, settled, 25);

    assert.deepEqual(sent, [SLEEP, SLEEP]);
  });

  it('is sent when the device is already there but the plugin never asked', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...AUTO_READING });

    await setAndSettle(handler, settled, 50);

    assert.deepEqual(sent, [AUTO]);
  });

  it('drops a waiting value when the newest matches the command already out', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await setAndSettle(handler, settled, 50);
    //Sleep waits, then the drag comes back to the Auto step already sent
    await handler.setPurifierRotationSpeed(25);
    await handler.setPurifierRotationSpeed(75);
    await settled();

    assert.deepEqual(sent, [AUTO]);
    assert.equal(handler.pendingSpeed, null);
  });

  it('drops a repeated 0% while the power-off is unconfirmed', async (t) => {
    const { handler, sent, settled } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await setAndSettle(handler, settled, 0);
    await setAndSettle(handler, settled, 0);

    assert.deepEqual(sent, ['-I D03102=0']);
  });
});
