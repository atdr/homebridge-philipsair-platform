'use strict';

//A write that fails must reach HomeKit as a failure (issue #86). Every onSet
//setter used to catch, log and return normally, so HAP committed a write the
//device never took as a success, and the tile could strand. These pin that a
//genuine failure rejects with HAP's own status error, after the optimistic
//revert has been published, while a write that merely gave way to a newer one
//in the same scene still succeeds.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const logger = require('../src/utils/logger');
const Handler = require('../src/accessories/accessories.handler');

const noop = () => {};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
logger.configure({ info: noop, warn: noop, error: noop }, {});

//the shape hap-nodejs gives these: an Error carrying a HAPStatus code
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
    //characteristics resolve to their own names so updates can be asserted by name
    Characteristic: new Proxy({}, { get: (target, prop) => prop }),
    HapStatusError,
    HAPStatus,
  },
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

const updated = (service, characteristic) => service.updates.filter(([name]) => name === characteristic);

//a handler whose every send fails the way a refused `set` does: at once,
//well inside HAP's own write window
const failingHandler = (config = {}) => {
  const handler = new Handler(fakeApi, {
    displayName: 'Failing Purifier',
    context: { config: { host: '192.168.1.142', port: 5683, debug: false, ...config } },
  });
  handler.purifierService = makeService();
  handler.humidifierService = makeService();
  handler.writeCoalesceWindow = 5;
  handler.speedDebounceWindow = 5;
  /** @type {string[]} */
  const sent = [];
  handler.sendCMD = async (args) => {
    sent.push(args.slice(args.indexOf('set') + 1).join(' '));
    throw new Error("aioairctrl rejected the command: Cannot encode value 'P' as int");
  };
  return { handler, sent };
};

const communicationFailure = (err) =>
  err instanceof HapStatusError && err.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE;

describe('a failed write is reported to HomeKit', () => {
  /** @type {[string, (handler: Handler) => Promise<void>, Record<string, unknown>?][]} */
  const setters = [
    ['setPurifierActive', (handler) => handler.setPurifierActive(1)],
    ['setPurifierTargetState (Auto)', (handler) => handler.setPurifierTargetState(1)],
    ['setPurifierTargetState (Manual)', (handler) => handler.setPurifierTargetState(0)],
    ['setPurifierLockPhysicalControls', (handler) => handler.setPurifierLockPhysicalControls(1)],
    ['setHumidifierActive', (handler) => handler.setHumidifierActive(1)],
    ['setHumidifierTargetState', (handler) => handler.setHumidifierTargetState(50)],
    ['setLightOn', (handler) => handler.setLightOn(1)],
    ['setLightBrightness', (handler) => handler.setLightBrightness(50)],
  ];

  for (const [name, set, config] of setters) {
    it(`${name} rejects with SERVICE_COMMUNICATION_FAILURE`, async (t) => {
      const { handler } = failingHandler(config);
      t.after(() => handler.kill(true));

      await assert.rejects(set(handler), communicationFailure);
    });
  }

  //the slider is the exception: its onSet resolves before the write goes out,
  //because HomeKit sends the next value of a drag only once it has (#150), so
  //a failure snaps the slider back instead (test/accessories.handler.speed-debounce.test.js)
  /** @type {[string, number, Record<string, unknown>?][]} */
  const slider = [
    ['a speed', 100],
    ['0%', 0],
    ['a fan level Auto step', 50, { model: 'AC0850' }],
  ];

  for (const [name, value, config] of slider) {
    it(`setPurifierRotationSpeed (${name}) resolves, and its failed write is handled`, async (t) => {
      const { handler, sent } = failingHandler(config);
      t.after(() => handler.kill(true));

      await handler.setPurifierRotationSpeed(value);
      //the write fails after the setter has resolved; an unhandled rejection
      //here would fail this file
      await delay(50);

      assert.equal(sent.length, 1);
    });
  }

  it('publishes the revert before the rejection reaches HomeKit', async (t) => {
    const { handler } = failingHandler();
    t.after(() => handler.kill(true));
    await handler.processUpdate(JSON.stringify({ pwr: '0', mode: 'M', om: '1' }));
    handler.purifierService = makeService();

    let shownWhenRejected;
    await assert.rejects(
      handler.setPurifierActive(1).catch((err) => {
        shownWhenRejected = [...handler.purifierService.updates];
        throw err;
      }),
      communicationFailure
    );

    //the optimistic push, then the revert to the last reading, both already
    //out by the time HAP learns the write failed
    assert.deepEqual(shownWhenRejected, [
      ['CurrentAirPurifierState', 2],
      ['Active', 0],
      ['CurrentAirPurifierState', 0],
    ]);
  });

  it('logs the failure once when a setter fails through another setter', async (t) => {
    const warn = [];
    logger.configure({ info: noop, warn: (message) => warn.push(message), error: noop }, {});
    t.after(() => logger.configure({ info: noop, warn: noop, error: noop }, {}));

    const { handler } = failingHandler({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    //50% on the AC0850 is an Auto step, sent through setPurifierTargetState
    await handler.setPurifierRotationSpeed(50);
    await delay(50);

    assert.equal(warn.length, 1, warn.join('\n'));
  });

  it('clears the light guard after a failure, so the next light write is not dropped', async (t) => {
    const { handler, sent } = failingHandler();
    t.after(() => handler.kill(true));

    await assert.rejects(handler.setLightOn(1), communicationFailure);
    await assert.rejects(handler.setLightBrightness(50), communicationFailure);

    assert.equal(sent.length, 2, 'the brightness write was swallowed by a guard the failed toggle left set');
  });
});

describe('a write that gave way is not a failure', () => {
  //RotationSpeed 0 yields to a real power write in the same scene. The power
  //write fails; the 0% was never sent, so it has nothing to report
  it('leaves the yielded write resolving when the write that won fails', async (t) => {
    const { handler, sent } = failingHandler({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    const [active, speed] = await Promise.allSettled([
      handler.setPurifierActive(1),
      handler.setPurifierRotationSpeed(0),
    ]);

    assert.deepEqual(sent, ['-I D03102=1']);
    assert.equal(active.status, 'rejected');
    assert.equal(speed.status, 'fulfilled');
  });

  it('resolves a write that yielded to a write that went out', async (t) => {
    const { handler } = failingHandler({ model: 'AC0850' });
    t.after(() => handler.kill(true));
    handler.sendCMD = async () => {};

    //Manual's restore gives way to the speed sent with it
    const results = await Promise.allSettled([
      handler.setPurifierTargetState(0),
      handler.setPurifierRotationSpeed(100),
    ]);

    assert.deepEqual(
      results.map((result) => result.status),
      ['fulfilled', 'fulfilled']
    );
  });

  //Auto on the switch and an Auto step on the slider in one scene are the
  //same write, sent once. If that one send fails, both asked for it
  it('fails the switch half of an identical write sent once', async (t) => {
    const { handler, sent } = failingHandler({ model: 'AC0850' });
    t.after(() => handler.kill(true));

    //the slider half resolved at once (#150); the switch is still told
    const results = await Promise.allSettled([handler.setPurifierTargetState(1), handler.setPurifierRotationSpeed(50)]);

    assert.equal(sent.length, 1);
    assert.deepEqual(
      results.map((result) => result.status),
      ['rejected', 'fulfilled']
    );
  });
});

describe('internal callers of a setter', () => {
  //an empty water tank makes processUpdate send Auto itself. A failure there
  //has no HomeKit write to report to, and must not cut the update short
  it('finishes the status update when the empty tank write fails', async (t) => {
    const { handler } = failingHandler({});
    t.after(() => handler.kill(true));

    await handler.processUpdate(JSON.stringify({ pwr: '1', mode: 'M', om: '1', func: 'PH', wl: 0, rh: 40 }));

    assert.deepEqual(updated(handler.humidifierService, 'Active').at(-1), ['Active', 0]);
    assert.deepEqual(updated(handler.humidifierService, 'CurrentHumidifierDehumidifierState').at(-1), [
      'CurrentHumidifierDehumidifierState',
      0,
    ]);
  });
});
