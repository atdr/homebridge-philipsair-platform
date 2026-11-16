'use strict';

// Platform-level tests against real HAP objects (the same reasoning as
// accessories.service.test.js: the claims worth testing here are Homebridge's
// own orchestration contract - register/unregister, cached-accessory
// reconciliation, and the identify/shutdown wiring - so a stub accessory
// would assert nothing about that). The one piece Homebridge itself does not
// provide, a fake platform `api`, is built below.

const assert = require('node:assert/strict');
const path = require('node:path');
const { describe, it } = require('node:test');

const hap = require('@homebridge/hap-nodejs');

const logger = require('../src/utils/logger');
const AccessoriesHandler = require('../src/accessories/accessories.handler');
const PhilipsAirPlatform = require('../src/platform');

const noop = () => {};
const silentLog = { info: noop, warn: noop, error: noop };
logger.configure(silentLog, {});

// AccessoriesService's constructor ends by calling handler.longPoll(), which
// would otherwise spawn the real aioairctrl child process; platform-level
// tests care about wiring, not device polling, so this is stubbed for the
// whole file (accessories.service.test.js does the same per-instance).
AccessoriesHandler.prototype.longPoll = noop;

const fixture = (name) => path.join(__dirname, 'fixtures', name);
const HAPPY_SHIM = fixture('fake-aioairctrl');
const MISSING_SHIM = fixture('definitely-not-installed-aioairctrl');

// Homebridge's PlatformAccessory wraps hap-nodejs's Accessory and adds
// `context`; `configure()` constructs one via `new this.api.platformAccessory(...)`.
class FakePlatformAccessory extends hap.Accessory {
  constructor(displayName, uuid) {
    super(displayName, uuid);
    this.context = {};
  }
}

const makeFakeApi = () => {
  const listeners = {};
  const registered = [];
  const unregistered = [];

  return {
    on(event, cb) {
      (listeners[event] ??= []).push(cb);
    },
    emit(event, ...args) {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
    platformAccessory: FakePlatformAccessory,
    registerPlatformAccessories(_plugin, _platform, accessories) {
      registered.push(...accessories);
    },
    unregisterPlatformAccessories(_plugin, _platform, accessories) {
      unregistered.push(...accessories);
    },
    updatePlatformAccessories: noop,
    hap,
    registered,
    unregistered,
  };
};

const makeDevice = (overrides = {}) => ({
  name: 'Purifier',
  host: '192.168.1.142',
  port: 5683,
  manufacturer: 'Philips',
  model: 'AC0850',
  serialNumber: 'SN123',
  ...overrides,
});

describe('PhilipsAirPlatform', () => {
  describe('constructor', () => {
    it('constructs headlessly without api or config, wiring nothing', () => {
      const api = makeFakeApi();

      assert.doesNotThrow(() => new PhilipsAirPlatform(silentLog, undefined, api));
      assert.doesNotThrow(() => api.emit('didFinishLaunching'));

      assert.doesNotThrow(() => new PhilipsAirPlatform(silentLog, {}, undefined));
    });

    it('initialises state and subscribes to didFinishLaunching', () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(silentLog, { aioairctrlPath: HAPPY_SHIM }, api);

      assert.deepEqual(platform.accessories, []);
      assert.equal(platform.devices.size, 0);
      assert.equal(platform.api, api);

      let launched = false;
      platform.didFinishLaunching = async () => {
        launched = true;
      };
      api.emit('didFinishLaunching');

      assert.ok(launched);
    });
  });

  describe('configureAccessory', () => {
    it('stashes a restored cached accessory for later reconciliation', () => {
      const platform = new PhilipsAirPlatform(silentLog, {}, makeFakeApi());
      const cached = new FakePlatformAccessory('Cached', hap.uuid.generate('platform-test-cached'));

      platform.configureAccessory(cached);

      assert.deepEqual(platform.accessories, [cached]);
    });
  });

  describe('removeAccessory', () => {
    it('unregisters with Homebridge and drops it from the cache', () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(silentLog, {}, api);
      const accessory = new FakePlatformAccessory('Gone', hap.uuid.generate('platform-test-removed'));
      platform.accessories = [accessory];

      platform.removeAccessory(accessory);

      assert.deepEqual(platform.accessories, []);
      assert.deepEqual(api.unregistered, [accessory]);
    });
  });

  describe('configure', () => {
    it('registers a new accessory for a device with none cached', () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(silentLog, {}, api);
      const uuid = hap.uuid.generate('platform-test-new-device');
      platform.devices.set(uuid, makeDevice());

      platform.configure();

      assert.equal(platform.accessories.length, 1);
      assert.equal(platform.accessories[0].UUID, uuid);
      assert.deepEqual(api.registered, platform.accessories);
    });

    it('leaves an already-cached accessory alone rather than re-registering it', () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(silentLog, {}, api);
      const uuid = hap.uuid.generate('platform-test-cached-device');
      const device = makeDevice();
      platform.devices.set(uuid, device);
      platform.accessories = [new FakePlatformAccessory(device.name, uuid)];

      platform.configure();

      assert.deepEqual(api.registered, []);
      assert.equal(platform.accessories.length, 1);
    });

    it('removes a cached accessory whose device has disappeared from config', () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(silentLog, {}, api);
      const stale = new FakePlatformAccessory('Stale', hap.uuid.generate('platform-test-stale-device'));
      platform.accessories = [stale];

      platform.configure();

      assert.deepEqual(platform.accessories, []);
      assert.deepEqual(api.unregistered, [stale]);
    });

    it('tolerates an accessory that has already been removed', () => {
      const api = makeFakeApi();
      api.unregisterPlatformAccessories = () => {
        throw new Error('already removed');
      };
      const platform = new PhilipsAirPlatform(silentLog, {}, api);
      const stale = new FakePlatformAccessory('Stale', hap.uuid.generate('platform-test-already-removed'));
      platform.accessories = [stale];

      assert.doesNotThrow(() => platform.configure());
    });

    it('sets up an accessory whose device is present', () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(silentLog, {}, api);
      const uuid = hap.uuid.generate('platform-test-setup-device');
      const device = makeDevice();
      platform.devices.set(uuid, device);
      const accessory = new FakePlatformAccessory(device.name, uuid);
      platform.accessories = [accessory];

      platform.configure();

      assert.equal(accessory.context.config, device);
      assert.ok(accessory.getService(hap.Service.AirPurifier));
    });
  });

  describe('setupAccessory', () => {
    it('wires identify, accessory information, and the handler/service pair', () => {
      const platform = new PhilipsAirPlatform(
        silentLog,
        { aioairctrlPath: HAPPY_SHIM, debug: true, cliDebug: true },
        makeFakeApi()
      );
      const device = makeDevice();
      const accessory = new FakePlatformAccessory(device.name, hap.uuid.generate('platform-test-setup-accessory'));

      platform.setupAccessory(accessory, device);

      assert.equal(accessory.context.config, device);
      assert.equal(accessory.context.config.debug, true);
      assert.equal(accessory.context.config.cliDebug, true);
      assert.equal(accessory.context.config.aioairctrlPath, HAPPY_SHIM);

      const info = accessory.getService(hap.Service.AccessoryInformation);
      assert.equal(info.getCharacteristic(hap.Characteristic.Manufacturer).value, device.manufacturer);
      assert.equal(info.getCharacteristic(hap.Characteristic.Model).value, device.model);
      assert.equal(info.getCharacteristic(hap.Characteristic.SerialNumber).value, device.serialNumber);

      assert.ok(accessory.getService(hap.Service.AirPurifier));
    });

    it('kills the handler when Homebridge shuts down', () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(silentLog, { aioairctrlPath: HAPPY_SHIM }, api);
      const device = makeDevice();
      const accessory = new FakePlatformAccessory(device.name, hap.uuid.generate('platform-test-shutdown'));

      let killed = false;
      const originalKill = AccessoriesHandler.prototype.kill;
      AccessoriesHandler.prototype.kill = function (force) {
        killed = true;
        return originalKill.call(this, force);
      };

      try {
        platform.setupAccessory(accessory, device);
        api.emit('shutdown');
      } finally {
        AccessoriesHandler.prototype.kill = originalKill;
      }

      assert.ok(killed);
    });
  });

  describe('preflight', () => {
    it('reports a working install at info level', async () => {
      // the constructor itself calls logger.configure(log, config), so the
      // capturing config must be applied after construction, not before
      const platform = new PhilipsAirPlatform(silentLog, { aioairctrlPath: HAPPY_SHIM }, makeFakeApi());

      const info = [];
      logger.configure({ info: (m) => info.push(m), warn: noop, error: noop }, {});
      await platform.preflight();
      logger.configure(silentLog, {});

      assert.ok(info.some((m) => m.includes(HAPPY_SHIM)));
    });

    it('alerts, but does not throw, when the CLI cannot be found', async () => {
      const platform = new PhilipsAirPlatform(silentLog, { aioairctrlPath: MISSING_SHIM }, makeFakeApi());

      const alerts = [];
      logger.configure({ info: noop, warn: noop, error: (m) => alerts.push(m) }, {});
      await platform.preflight();
      logger.configure(silentLog, {});

      assert.ok(alerts.some((m) => m.includes('pipx install aioairctrl')));
    });
  });

  describe('didFinishLaunching', () => {
    it('runs preflight, populates devices, and configures accessories end to end', async () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(
        silentLog,
        { aioairctrlPath: HAPPY_SHIM, devices: [{ active: true, name: 'Purifier', host: '192.168.1.142' }] },
        api
      );

      await platform.didFinishLaunching();

      assert.equal(platform.devices.size, 1);
      assert.equal(platform.accessories.length, 1);
      assert.equal(api.registered.length, 1);
    });

    it('skips the preflight when no device is active, but still removes stale accessories', async () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(
        silentLog,
        { aioairctrlPath: MISSING_SHIM, devices: [{ active: false, name: 'Purifier', host: '192.168.1.142' }] },
        api
      );
      const stale = new FakePlatformAccessory('Old', hap.uuid.generate('old'));
      platform.configureAccessory(stale);

      const alerts = [];
      logger.configure({ info: noop, warn: noop, error: (m) => alerts.push(m) }, {});
      await platform.didFinishLaunching();
      logger.configure(silentLog, {});

      assert.deepEqual(alerts, []);
      assert.deepEqual(api.unregistered, [stale]);
    });

    //issue #174: before the capability table gated them, a sensor, light or
    //filter option built its service from the config flag alone, so a user who
    //had one on for a model that cannot report it has the dead service cached.
    //It has to come off the restored accessory, and only where the table says
    //the model lacks it
    it('takes the services a model lacks off a restored accessory, and keeps the rest', async () => {
      const allOn = {
        light: true,
        temperature: true,
        humidity: true,
        preFilter: true,
        hepaFilter: true,
        carbonFilter: true,
      };
      const devices = [
        { active: true, name: 'Bedroom', model: 'AC0950', host: '10.0.3.1', ...allOn },
        { active: true, name: 'Hall', model: 'AC2210', host: '10.0.3.2', ...allOn },
        { active: true, name: 'Study', host: '10.0.3.3', ...allOn },
      ];
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(silentLog, { aioairctrlPath: HAPPY_SHIM, devices }, api);

      //what the cache holds after a run on the previous release
      const restored = devices.map(({ name }) => {
        const accessory = new FakePlatformAccessory(name, hap.uuid.generate(name));
        accessory.context.config = { ...devices.find((device) => device.name === name) };
        accessory.addService(hap.Service.AirPurifier, name, 'purifier');
        accessory.addService(hap.Service.Lightbulb, 'Light', 'Light');
        accessory.addService(hap.Service.TemperatureSensor, 'Temperature Sensor', 'Temperature Sensor');
        accessory.addService(hap.Service.HumiditySensor, 'Humidity Sensor', 'Humidity Sensor');
        for (const filter of ['Pre Filter', 'HEPA filter', 'Active carbon filter']) {
          accessory.addService(hap.Service.FilterMaintenance, filter, filter);
        }
        platform.configureAccessory(accessory);
        return accessory;
      });

      await platform.didFinishLaunching();

      const services = (accessory) =>
        accessory.services
          .filter((service) => service.UUID !== hap.Service.AccessoryInformation.UUID)
          .map((service) => service.subtype || service.displayName)
          .sort();
      const [bedroom, hall, study] = restored;
      const everything = [
        'Active carbon filter',
        'Air Quality',
        'HEPA filter',
        'Humidity Sensor',
        'Light',
        'Pre Filter',
        'Temperature Sensor',
        'purifier',
      ];

      assert.deepEqual(api.registered, [], 'a restored accessory was registered again');
      assert.deepEqual(api.unregistered, [], 'a restored accessory was removed');
      assert.deepEqual(services(bedroom), ['Air Quality', 'HEPA filter', 'Humidity Sensor', 'Pre Filter', 'purifier']);
      assert.deepEqual(services(hall), [
        'Air Quality',
        'HEPA filter',
        'Humidity Sensor',
        'Light',
        'Pre Filter',
        'purifier',
      ]);
      assert.deepEqual(services(study), everything);
    });

    //the reported failure: a stray entry or an object where the list belongs
    //rejected inside Setup, out of reach of the try/catch, and took the bridge
    //down with an unhandled rejection
    it('sets up the valid devices when the devices list holds a stray entry', async () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(
        silentLog,
        { aioairctrlPath: HAPPY_SHIM, devices: [null, { active: true, name: 'Purifier', host: '192.168.1.142' }] },
        api
      );

      const warnings = [];
      logger.configure({ info: noop, warn: (m) => warnings.push(m), error: noop }, {});
      await assert.doesNotReject(platform.didFinishLaunching());
      logger.configure(silentLog, {});

      assert.equal(platform.devices.size, 1);
      assert.equal(api.registered.length, 1);
      assert.ok(warnings.some((m) => m.includes('Entry 1 in devices is not a device')));
    });

    it('treats a devices object as no devices rather than rejecting', async () => {
      const platform = new PhilipsAirPlatform(
        silentLog,
        { aioairctrlPath: HAPPY_SHIM, devices: { name: 'Purifier', host: '192.168.1.142' } },
        makeFakeApi()
      );

      const warnings = [];
      logger.configure({ info: noop, warn: (m) => warnings.push(m), error: noop }, {});
      await assert.doesNotReject(platform.didFinishLaunching());
      logger.configure(silentLog, {});

      assert.equal(platform.devices.size, 0);
      assert.ok(warnings.some((m) => m.includes('devices setting should be a list of devices')));
    });

    //a value someone wrote is not a missing setting: defaulting it to an empty
    //list on the way in would start the plugin with no devices and no word why
    for (const devices of [null, false, 0, '']) {
      it(`says so when devices is ${JSON.stringify(devices)} rather than a list`, async () => {
        const platform = new PhilipsAirPlatform(silentLog, { aioairctrlPath: HAPPY_SHIM, devices }, makeFakeApi());

        const warnings = [];
        logger.configure({ info: noop, warn: (m) => warnings.push(m), error: noop }, {});
        await assert.doesNotReject(platform.didFinishLaunching());
        logger.configure(silentLog, {});

        assert.equal(platform.devices.size, 0);
        assert.ok(warnings.some((m) => m.includes('devices setting should be a list of devices')));
      });
    }

    it('stays quiet when devices is not set at all', async () => {
      const platform = new PhilipsAirPlatform(silentLog, { aioairctrlPath: HAPPY_SHIM }, makeFakeApi());

      const warnings = [];
      logger.configure({ info: noop, warn: (m) => warnings.push(m), error: noop }, {});
      await assert.doesNotReject(platform.didFinishLaunching());
      logger.configure(silentLog, {});

      assert.equal(platform.devices.size, 0);
      assert.deepEqual(warnings, []);
    });

    //anything Setup can still throw has to reach the catch in didFinishLaunching
    it('catches a throw from inside the device setup', async () => {
      const api = makeFakeApi();
      const platform = new PhilipsAirPlatform(
        silentLog,
        { aioairctrlPath: HAPPY_SHIM, devices: [{ active: true, name: 'Purifier', host: '192.168.1.142' }] },
        api
      );
      api.hap = {
        ...hap,
        uuid: {
          ...hap.uuid,
          generate: () => {
            throw new Error('setup boom');
          },
        },
      };

      const errors = [];
      const rejections = [];
      const onRejection = (err) => rejections.push(err);
      process.on('unhandledRejection', onRejection);
      logger.configure({ info: noop, warn: noop, error: (m) => errors.push(String(m)) }, {});
      await assert.doesNotReject(platform.didFinishLaunching());
      await new Promise((resolve) => setImmediate(resolve));
      logger.configure(silentLog, {});
      process.off('unhandledRejection', onRejection);

      assert.deepEqual(rejections, []);
      assert.ok(errors.some((m) => m.includes('setup boom')));
    });

    it('logs a failure instead of leaving it as an unhandled rejection', async () => {
      const platform = new PhilipsAirPlatform(
        silentLog,
        { aioairctrlPath: HAPPY_SHIM, devices: [{ active: true, name: 'Purifier', host: '192.168.1.142' }] },
        makeFakeApi()
      );
      platform.preflight = async () => {
        throw new Error('boom');
      };

      const errors = [];
      logger.configure({ info: noop, warn: noop, error: (m) => errors.push(String(m)) }, {});
      await assert.doesNotReject(platform.didFinishLaunching());
      logger.configure(silentLog, {});

      assert.ok(errors.some((m) => m.includes('boom')));
    });
  });
});
