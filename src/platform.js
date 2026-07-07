'use strict';

const logger = require('./utils/logger');
const { name: PLUGIN_NAME, version } = require('../package.json');
const { generateConfig } = require('./utils/utils');

//Accessories
const { AccessoriesService, AccessoriesSetup, AccessoriesHandler } = require('./accessories');

const PLATFORM_NAME = 'PhilipsAirPlatform';

class PhilipsAirPlatform {
  constructor(log, config, api) {
    if (!api || !config) {
      return;
    }

    logger.configure(log, config);

    this.api = api;
    this.accessories = [];
    this.config = generateConfig(config);
    this.devices = new Map();

    this.api.on('didFinishLaunching', () => this.didFinishLaunching());
  }

  async didFinishLaunching() {
    //initialize devices
    AccessoriesSetup(this.devices, this.config.devices, this.api.hap.uuid.generate);

    //configure accessories
    this.configure();
  }

  configure() {
    //configure accessories
    for (const [uuid, device] of this.devices.entries()) {
      const cachedAccessory = this.accessories.find((curAcc) => curAcc.UUID === uuid);

      if (!cachedAccessory) {
        logger.info('Configuring new accessory...', device.name);

        const accessory = new this.api.platformAccessory(device.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      } else {
        logger.info('Configuring cached accessory...', device.name);
      }
    }

    //remove unused accessories
    this.accessories.forEach((accessory) => {
      const device = this.devices.get(accessory.UUID);

      try {
        if (!device) {
          this.removeAccessory(accessory);
        }
      } catch (err) {
        logger.info('It looks like the accessory has already been removed. Skip removing.');
        logger.debug(err);
      }
    });

    //setup new accessories
    this.accessories.forEach((accessory) => {
      const device = this.devices.get(accessory.UUID);

      if (device) {
        logger.info('Setup accessory...', device.name);
        this.setupAccessory(accessory, device);
      }
    });
  }

  setupAccessory(accessory, device) {
    accessory.on('identify', () => logger.info('Identify requested.', accessory.displayName));

    accessory
      .getService(this.api.hap.Service.AccessoryInformation)
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, device.manufacturer)
      .setCharacteristic(this.api.hap.Characteristic.Model, device.model)
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, device.serialNumber)
      .setCharacteristic(this.api.hap.Characteristic.FirmwareRevision, version);

    accessory.context.config = device;
    accessory.context.config.debug = this.config.debug;
    accessory.context.config.aioairctrlPath = this.config.aioairctrlPath;

    const handler = new AccessoriesHandler(this.api, accessory);

    this.api.on('shutdown', () => {
      handler.kill(true);
    });

    new AccessoriesService(this.api, accessory, handler);
  }

  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  removeAccessory(accessory) {
    logger.info('Removing accessory...', accessory.displayName);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);

    this.accessories = this.accessories.filter((cachedAccessory) => cachedAccessory.UUID !== accessory.UUID);
  }
}

module.exports = PhilipsAirPlatform;
