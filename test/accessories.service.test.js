'use strict';

//Service wiring against real HAP objects, because the claims worth testing here
//are HAP's: which characteristics exist on the AirPurifier service and what
//values they will accept. A stub service would assert nothing about that.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

// hap-nodejs is available through the homebridge devDependency
const hap = require('@homebridge/hap-nodejs');

const logger = require('../src/utils/logger');
const Accessory = require('../src/accessories/accessories.service');
const Handler = require('../src/accessories/accessories.handler');

const noop = () => {};
logger.configure({ info: noop, warn: noop, error: noop }, {});

const fakeApi = { hap, updatePlatformAccessories: () => {} };

const wire = (config) => {
  //homebridge's PlatformAccessory carries a context; the bare HAP one does not
  const accessory = Object.assign(
    new hap.Accessory('Test Purifier', hap.uuid.generate(`service-test-${config.model || 'default'}`)),
    { context: { config: { host: '192.168.1.142', port: 5683, debug: false, ...config } } }
  );

  const handler = new Handler(fakeApi, accessory);
  //the constructor ends by starting the poll; nothing here needs a child process
  handler.longPoll = noop;

  new Accessory(fakeApi, accessory, handler);

  return accessory.getService(hap.Service.AirPurifier);
};

describe('accessories.service', () => {
  it('exposes the lock and both purifier modes on a model that has them', () => {
    const purifier = wire({});

    assert.ok(purifier.testCharacteristic(hap.Characteristic.LockPhysicalControls));
    assert.deepEqual(purifier.getCharacteristic(hap.Characteristic.TargetAirPurifierState).props.validValues, [
      hap.Characteristic.TargetAirPurifierState.MANUAL,
      hap.Characteristic.TargetAirPurifierState.AUTO,
    ]);
  });

  it('offers neither control on a model with no register for them', () => {
    const purifier = wire({ model: 'AC0850' });

    assert.ok(
      !purifier.testCharacteristic(hap.Characteristic.LockPhysicalControls),
      'a child lock was exposed for a model that has no child lock register'
    );
    assert.deepEqual(
      purifier.getCharacteristic(hap.Characteristic.TargetAirPurifierState).props.validValues,
      [hap.Characteristic.TargetAirPurifierState.AUTO],
      'the auto/manual switch was left switchable on a model with no mode register'
    );
  });

  it('takes the lock back off a cached accessory that still has one', () => {
    const accessory = Object.assign(new hap.Accessory('Cached Purifier', hap.uuid.generate('service-test-cached')), {
      context: { config: { host: '192.168.1.142', port: 5683, model: 'AC0850' } },
    });

    //as an accessory paired before the model was known to lack the register
    const purifier = accessory.addService(hap.Service.AirPurifier, 'Cached Purifier', 'purifier');
    purifier.addCharacteristic(hap.Characteristic.LockPhysicalControls);

    const handler = new Handler(fakeApi, accessory);
    handler.longPoll = noop;
    new Accessory(fakeApi, accessory, handler);

    assert.ok(!purifier.testCharacteristic(hap.Characteristic.LockPhysicalControls));
  });
});
