'use strict';

//Dragging the fan speed slider sends every step it passes through, then the
//last one, and each write makes the purifier beep. On the AC0850 the lowest
//step is Sleep, so a drag detoured through Sleep on its way to Auto (issue
//#150). RotationSpeed writes therefore wait for the slider to settle, and only
//the last value goes out. These pin that, and that the wait never splits a
//scene's power-on from its speed, which these devices punish by dropping one
//of the two (issue #82).

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
  return { handler, sent, shown };
};

const SLEEP = '-I D0310A=2 D0310C=17';
const AUTO = '-I D0310A=2 D0310C=0';
const TURBO = '-I D0310A=2 D0310C=18';
const POWER_ON = '-I D03102=1';
const ON = { D03102: 1, D0310A: 2, D0310C: 0 };

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

  it('sends a drag as one command, with the last value', async (t) => {
    const { handler, sent } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    //the drag from issue #150: through Sleep, ending on the Auto step
    const first = handler.setPurifierRotationSpeed(25);
    await delay(DEBOUNCE / 3);
    const last = handler.setPurifierRotationSpeed(75);
    await Promise.all([first, last]);

    assert.deepEqual(sent, [AUTO]);
  });

  it('lets the last value win even where an earlier one would outrank it', async (t) => {
    //Auto outranks a speed in a scene, but a drag down from the Auto step to
    //Sleep means Sleep
    const { handler, sent, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    const steps = [handler.setPurifierRotationSpeed(75)];
    await delay(DEBOUNCE / 3);
    steps.push(handler.setPurifierRotationSpeed(50));
    await delay(DEBOUNCE / 3);
    steps.push(handler.setPurifierRotationSpeed(25));
    await Promise.all(steps);

    assert.deepEqual(sent, [SLEEP]);
    assert.equal(shown.TargetAirPurifierState, 0);
  });

  it('restarts the wait on every new value', async (t) => {
    const { handler, sent } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    const steps = [];
    for (const value of [25, 50, 75, 100, 25, 100]) {
      steps.push(handler.setPurifierRotationSpeed(value));
      await delay(DEBOUNCE / 2);
    }
    //the drag has lasted far longer than one window, and nothing has gone out
    assert.deepEqual(sent, []);

    await Promise.all(steps);
    assert.deepEqual(sent, [TURBO]);
  });

  it('resolves the setters a newer value replaced, even when the final send fails', async (t) => {
    const { handler } = recording({ fail: true });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    const first = handler.setPurifierRotationSpeed(25);
    const second = handler.setPurifierRotationSpeed(50);
    const last = handler.setPurifierRotationSpeed(100);

    await first;
    await second;
    await assert.rejects(last, communicationFailure);
  });

  it('sends a lone tap once the window has passed, and not before', async (t) => {
    const { handler, sent } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    const tap = handler.setPurifierRotationSpeed(100);
    await delay(DEBOUNCE / 2);
    assert.deepEqual(sent, []);

    await tap;
    assert.deepEqual(sent, [TURBO]);
  });

  it('shows the new value on the slider straight away', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    const tap = handler.setPurifierRotationSpeed(25);
    assert.equal(shown.RotationSpeed, 25);

    await tap;
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
      const { handler, sent } = recording();
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
      //one flush: the power write goes last, on its own (#117)
      assert.deepEqual(sent, [SLEEP, POWER_ON]);
    });
  }

  it('holds a power-on that arrives after the speed, past its own window', async (t) => {
    const { handler, sent } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON, D03102: 0 });

    const speed = handler.setPurifierRotationSpeed(100);
    await delay(COALESCE);
    const power = handler.setPurifierActive(1);
    await delay(COALESCE * 3);
    assert.deepEqual(sent, []);

    await Promise.all([speed, power]);
    assert.deepEqual(sent, [TURBO, POWER_ON]);
  });

  it('sends a scene to a device already on as one command', async (t) => {
    const { handler, sent } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });

    await Promise.all([handler.setPurifierActive(1), handler.setPurifierRotationSpeed(25)]);

    assert.deepEqual(sent, [SLEEP]);
  });

  it('lets a power-on win over a 0% in the same scene', async (t) => {
    const { handler, sent, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON, D03102: 0 });

    await Promise.all([handler.setPurifierRotationSpeed(0), handler.setPurifierActive(1)]);

    assert.deepEqual(sent, [POWER_ON]);
    assert.notEqual(shown.Active, 0);
  });

  for (const order of ['mode first', 'speed first']) {
    it(`lets Auto win over a speed (${order})`, async (t) => {
      const { handler, sent, shown } = recording();
      t.after(() => handler.kill(true));
      handler.handleResponse({ ...ON, D0310C: 18 });

      const writes =
        order === 'mode first'
          ? [handler.setPurifierTargetState(1), handler.setPurifierRotationSpeed(100)]
          : [handler.setPurifierRotationSpeed(100), handler.setPurifierTargetState(1)];
      await Promise.all(writes);

      assert.deepEqual(sent, [AUTO]);
      assert.equal(shown.TargetAirPurifierState, 1);
    });

    it(`lets a speed win over Manual (${order})`, async (t) => {
      const { handler, sent, shown } = recording();
      t.after(() => handler.kill(true));
      handler.handleResponse({ ...ON });

      const writes =
        order === 'mode first'
          ? [handler.setPurifierTargetState(0), handler.setPurifierRotationSpeed(100)]
          : [handler.setPurifierRotationSpeed(100), handler.setPurifierTargetState(0)];
      await Promise.all(writes);

      assert.deepEqual(sent, [TURBO]);
      assert.equal(shown.TargetAirPurifierState, 0);
    });
  }

  it('rejects the final setter of a scene whose send fails', async (t) => {
    const { handler } = recording({ fail: true });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON, D03102: 0 });

    const power = handler.setPurifierActive(1);
    const speed = handler.setPurifierRotationSpeed(25);

    await assert.rejects(speed, communicationFailure);
    await assert.rejects(power, communicationFailure);
  });
});

describe('fan speed debounce on shutdown', () => {
  it('sends a speed still waiting when the handler is killed, rather than stranding it', async (t) => {
    const { handler, sent } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...ON });
    handler.speedDebounceWindow = 60 * 1000;

    const tap = handler.setPurifierRotationSpeed(100);
    handler.kill(true);
    await tap;

    assert.deepEqual(sent, [TURBO]);
  });
});

describe('the slider while a speed waits', () => {
  //the AC0850 reading Turbo, which its slider shows as 100%
  const RUNNING = { D03102: 1, D0310A: 2, D0310C: 18, D0310D: 18 };

  //what HAP-nodejs does with an onSet: once the handler resolves, it stores
  //the value it was given as the characteristic's cached value
  const committing = (handler, shown) => async (value) => {
    await handler.setPurifierRotationSpeed(value);
    shown.RotationSpeed = value;
  };

  it('answers a read with the requested value, not the last reading', async (t) => {
    const { handler } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    const tap = handler.setPurifierRotationSpeed(25);
    assert.equal(handler.rotationSpeed(), 25);

    await tap;
  });

  it('keeps the requested value through a status that arrives while it waits', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    const tap = handler.setPurifierRotationSpeed(25);
    await handler.processUpdate(JSON.stringify(RUNNING));
    assert.equal(shown.RotationSpeed, 25);

    await tap;
  });

  it('puts the latest value back once HAP has stored a replaced one', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });
    const onSet = committing(handler, shown);

    const first = onSet(25);
    await delay(DEBOUNCE / 3);
    const last = onSet(75);
    await first;
    await new Promise((resolve) => setImmediate(resolve));

    //the final write has not even been sent yet
    assert.equal(shown.RotationSpeed, 75);

    await last;
  });

  it('never puts back a value older than the latest request', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });
    const onSet = committing(handler, shown);

    //three in one tick: the first two are both replaced before HAP stores either
    const steps = [onSet(25), onSet(50), onSet(100)];
    await steps[0];
    await steps[1];
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(shown.RotationSpeed, 100);

    await steps[2];
  });

  it('puts the slider back to the last reading when a 0% write fails', async (t) => {
    const { handler, shown } = recording({ fail: true });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await assert.rejects(handler.setPurifierRotationSpeed(0), communicationFailure);

    assert.equal(shown.RotationSpeed, 100);
    assert.equal(shown.Active, 1);
  });

  it('puts the slider back to the last reading when a speed write fails', async (t) => {
    const { handler, shown } = recording({ fail: true });
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    await assert.rejects(handler.setPurifierRotationSpeed(25), communicationFailure);

    assert.equal(shown.RotationSpeed, 100);
  });

  it('leaves a newer request on the slider when an earlier 0% write fails', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    //the 0% goes out and fails only once a newer value is already waiting
    /** @type {(err: Error) => void} */
    let failSend = () => {};
    handler.sendCMD = () => new Promise((resolve, reject) => (failSend = reject));
    const off = handler.setPurifierRotationSpeed(0);
    await delay(DEBOUNCE + COALESCE * 2);
    const newer = handler.setPurifierRotationSpeed(25);

    failSend(new Error('aioairctrl rejected the command'));
    await assert.rejects(off, communicationFailure);
    assert.equal(shown.RotationSpeed, 25);

    handler.sendCMD = async () => {};
    await newer;
  });

  it('leaves a newer speed already sent on the slider when an earlier 0% write fails', async (t) => {
    const { handler, shown } = recording();
    t.after(() => handler.kill(true));
    handler.handleResponse({ ...RUNNING });

    //both writes go out; the 0% fails only after the newer speed is on its way
    /** @type {((err: Error) => void)[]} */
    const fails = [];
    handler.sendCMD = () => new Promise((resolve, reject) => fails.push(reject));
    const off = handler.setPurifierRotationSpeed(0);
    await delay(DEBOUNCE + COALESCE * 2);
    const newer = handler.setPurifierRotationSpeed(25);
    await delay(DEBOUNCE + COALESCE * 2);
    assert.equal(fails.length, 2);

    fails[0](new Error('aioairctrl rejected the command'));
    await assert.rejects(off, communicationFailure);
    assert.equal(shown.RotationSpeed, 25);

    fails[1](new Error('aioairctrl rejected the command'));
    await assert.rejects(newer, communicationFailure);
  });
});
