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

//same as wire(), but returns the accessory and handler rather than just the
//purifier service, for optional-service tests that need to set handler.obj
//or pre-seed a cached accessory with a specific service before wiring runs
const wireAccessory = (config, key, accessory) => {
  accessory =
    accessory ||
    Object.assign(new hap.Accessory('Test Purifier', hap.uuid.generate(`service-test-${key}`)), {
      context: { config: { host: '192.168.1.142', port: 5683, debug: false, ...config } },
    });

  const handler = new Handler(fakeApi, accessory);
  handler.longPoll = noop;

  new Accessory(fakeApi, accessory, handler);

  return { accessory, handler };
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
    assert.equal(
      purifier.getCharacteristic(hap.Characteristic.TargetAirPurifierState).value,
      hap.Characteristic.TargetAirPurifierState.AUTO,
      'the characteristic was left holding a value outside its own validValues'
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

describe('accessories.service optional services', () => {
  describe('filter maintenance services', () => {
    for (const [flag, serviceName] of [
      ['preFilter', 'Pre Filter'],
      ['carbonFilter', 'Active carbon filter'],
      ['hepaFilter', 'HEPA filter'],
    ]) {
      it(`adds the ${serviceName} service and its FilterLifeLevel when ${flag} is on`, () => {
        const { accessory } = wireAccessory({ [flag]: true }, `${flag}-on`);

        const service = accessory.getService(serviceName);
        assert.ok(service, `${serviceName} service was not added`);
        assert.ok(service.testCharacteristic(hap.Characteristic.FilterLifeLevel));
      });

      it(`removes a cached ${serviceName} service when ${flag} is off`, () => {
        const accessory = Object.assign(new hap.Accessory('Cached', hap.uuid.generate(`service-test-${flag}-off`)), {
          context: { config: { host: '192.168.1.142', port: 5683 } },
        });
        accessory.addService(hap.Service.FilterMaintenance, serviceName, serviceName);

        wireAccessory({}, `${flag}-off`, accessory);

        assert.ok(!accessory.getService(serviceName));
      });
    }
  });

  describe('humidifier service', () => {
    it('adds the humidifier and its wick filter, pinning the mode and threshold props', () => {
      const { accessory } = wireAccessory({ humidifier: true }, 'humidifier-on');

      const humidifier = accessory.getService(hap.Service.HumidifierDehumidifier);
      assert.ok(humidifier, 'HumidifierDehumidifier service was not added');
      assert.ok(accessory.getService('Wick filter'), 'Wick filter service was not added');

      assert.deepEqual(
        humidifier.getCharacteristic(hap.Characteristic.CurrentHumidifierDehumidifierState).props.validValues,
        [
          hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
          hap.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING,
        ]
      );

      const targetState = humidifier.getCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState);
      assert.deepEqual(targetState.props.validValues, [
        hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
      ]);
      assert.equal(targetState.value, hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER);

      const threshold = humidifier.getCharacteristic(hap.Characteristic.RelativeHumidityHumidifierThreshold);
      assert.equal(threshold.props.minValue, 0);
      assert.equal(threshold.props.maxValue, 100);
      assert.equal(threshold.props.minStep, 25);
    });

    //the else branch only removes HumidifierDehumidifier itself; the 'Wick
    //filter' FilterMaintenance service it adds alongside is never cleaned up
    //here, so it is left behind on the accessory. That looks like an
    //oversight rather than intended behaviour, but fixing it is a production
    //code change out of scope for this coverage-only change - flagged
    //separately rather than folded in here.
    it('removes a cached humidifier service when humidifier is off', () => {
      const accessory = Object.assign(new hap.Accessory('Cached', hap.uuid.generate('service-test-humidifier-off')), {
        context: { config: { host: '192.168.1.142', port: 5683 } },
      });
      accessory.addService(hap.Service.HumidifierDehumidifier, 'Humidifier', 'Humidifier');

      wireAccessory({}, 'humidifier-off', accessory);

      assert.ok(!accessory.getService(hap.Service.HumidifierDehumidifier));
    });
  });

  describe('temperature sensor', () => {
    it('adds the temperature sensor and reports the polled reading', async () => {
      const { accessory, handler } = wireAccessory({ temperature: true }, 'temperature-on');
      handler.obj = { temp: 21.5 };

      const service = accessory.getService(hap.Service.TemperatureSensor);
      assert.ok(service, 'TemperatureSensor service was not added');
      assert.equal(await service.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest(), 21.5);
    });

    it('falls back to 0 when no reading has been polled yet', async () => {
      const { accessory, handler } = wireAccessory({ temperature: true }, 'temperature-default');
      handler.obj = {};

      const service = accessory.getService(hap.Service.TemperatureSensor);
      assert.equal(await service.getCharacteristic(hap.Characteristic.CurrentTemperature).handleGetRequest(), 0);
    });

    it('removes a cached temperature sensor when temperature is off', () => {
      const accessory = Object.assign(new hap.Accessory('Cached', hap.uuid.generate('service-test-temperature-off')), {
        context: { config: { host: '192.168.1.142', port: 5683 } },
      });
      accessory.addService(hap.Service.TemperatureSensor, 'Temperature Sensor', 'Temperature Sensor');

      wireAccessory({}, 'temperature-off', accessory);

      assert.ok(!accessory.getService(hap.Service.TemperatureSensor));
    });
  });

  describe('humidity sensor', () => {
    it('adds the humidity sensor and reports the polled reading', async () => {
      const { accessory, handler } = wireAccessory({ humidity: true }, 'humidity-on');
      handler.obj = { rh: 45 };

      const service = accessory.getService(hap.Service.HumiditySensor);
      assert.ok(service, 'HumiditySensor service was not added');
      assert.equal(await service.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity).handleGetRequest(), 45);
    });

    it('removes a cached humidity sensor when humidity is off', () => {
      const accessory = Object.assign(new hap.Accessory('Cached', hap.uuid.generate('service-test-humidity-off')), {
        context: { config: { host: '192.168.1.142', port: 5683 } },
      });
      accessory.addService(hap.Service.HumiditySensor, 'Humidity Sensor', 'Humidity Sensor');

      wireAccessory({}, 'humidity-off', accessory);

      assert.ok(!accessory.getService(hap.Service.HumiditySensor));
    });
  });

  describe('light service', () => {
    it('adds the light and brightness, on only while powered on with the ring lit', async () => {
      const { accessory, handler } = wireAccessory({ light: true }, 'light-on');

      const service = accessory.getService(hap.Service.Lightbulb);
      assert.ok(service, 'Lightbulb service was not added');
      assert.ok(service.testCharacteristic(hap.Characteristic.Brightness));

      const brightness = service.getCharacteristic(hap.Characteristic.Brightness);
      assert.equal(brightness.props.minValue, 0);
      assert.equal(brightness.props.maxValue, 100);
      assert.equal(brightness.props.minStep, 25);

      const on = service.getCharacteristic(hap.Characteristic.On);

      handler.obj = { pwr: '1', aqil: 50 };
      assert.equal(await on.handleGetRequest(), true);

      handler.obj = { pwr: '0', aqil: 50 };
      assert.equal(await on.handleGetRequest(), false);

      handler.obj = { pwr: '1', aqil: 0 };
      assert.equal(await on.handleGetRequest(), false);
    });

    it('reports brightness from the polled ring level, defaulting to 0', async () => {
      const { accessory, handler } = wireAccessory({ light: true }, 'light-brightness');
      const brightness = accessory.getService(hap.Service.Lightbulb).getCharacteristic(hap.Characteristic.Brightness);

      handler.obj = { aqil: 75 };
      assert.equal(await brightness.handleGetRequest(), 75);

      handler.obj = {};
      assert.equal(await brightness.handleGetRequest(), 0);
    });

    it('removes a cached light service when light is off', () => {
      const accessory = Object.assign(new hap.Accessory('Cached', hap.uuid.generate('service-test-light-off')), {
        context: { config: { host: '192.168.1.142', port: 5683 } },
      });
      accessory.addService(hap.Service.Lightbulb, 'Light', 'Light');

      wireAccessory({}, 'light-off', accessory);

      assert.ok(!accessory.getService(hap.Service.Lightbulb));
    });
  });
});
