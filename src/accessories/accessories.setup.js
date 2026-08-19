'use strict';

const logger = require('../utils/logger');
const Config = require('./accessories.config');
const { resolveModel, hasOwnSpeeds } = require('./accessories.models');

/**
 * Resolves which command set a device runs on, and says so in the log.
 *
 * The model field selects the speed and register maps, so a device quietly
 * running on the default mapping is a device whose controls may do nothing at
 * all. That has to be visible in the log rather than inferred from behaviour,
 * and where the model can be recovered from the device name it is better to
 * drive the device correctly and say why than to be right about the config.
 *
 * @param {{ name: string, model: string, sleepSpeed?: boolean }} device
 * @returns {string | undefined} the mapped model, or undefined for the default mapping
 */
const announceModel = (device) => {
  const { key, source, nameSuggests } = resolveModel(device);

  if (source === 'name') {
    logger.warn(
      `"${key}" in the device name looks like a model ID, and no model is configured. ` +
        `Using the ${key} command set. Move it to the model field to silence this.`,
      device.name
    );
  } else if (nameSuggests) {
    logger.warn(
      `The device name mentions ${nameSuggests}, but the model is set to ${key}. ` + `Using the ${key} command set.`,
      device.name
    );
  }

  if (device.sleepSpeed && hasOwnSpeeds(key)) {
    logger.warn(`The sleep speed option does nothing for the ${key}, which brings its own speed table.`, device.name);
  }

  if (key) {
    logger.info(`Using the ${key} command set.`, device.name);
  } else {
    logger.info(
      `No tested mapping for model "${device.model}", using the default command set. ` +
        'If the controls do not work, set the model to the ID printed on your device.',
      device.name
    );
  }

  return key;
};

const Setup = async (deviceMap, devices, generateUUID) => {
  for (const deviceConfig of devices) {
    let error = false;
    const device = Config(deviceConfig);

    if (!device.active) {
      //an accessory that disappeared from HomeKit because this got unticked
      //otherwise leaves no trace at all in the log
      logger.info('Not active in the config, so it will not be exposed to HomeKit.', device.name);
      error = true;
    } else if (!device.name) {
      logger.warn('One of the devices has no name configured. This device will be skipped.');
      error = true;
    } else if (!device.host) {
      if (deviceConfig.host) {
        logger.warn('The configured ip/host for this device is invalid. This device will be skipped.', device.name);
      } else {
        logger.warn('There is no ip/host configured for this device. This device will be skipped.', device.name);
      }
      error = true;
    }

    if (!error) {
      const uuid = generateUUID(device.name);

      if (deviceMap.has(uuid)) {
        logger.warn('Multiple devices are configured with this name. Duplicate devices will be skipped.', device.name);
      } else {
        logger.info('Initializing device...', device.name);
        device.modelKey = announceModel(device);
        deviceMap.set(uuid, device);
      }
    }
  }
};

module.exports = Setup;
