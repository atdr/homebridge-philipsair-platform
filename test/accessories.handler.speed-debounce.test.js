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
