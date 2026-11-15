'use strict';

const logger = require('../utils/logger');
const Config = require('./accessories.config');
const {
  resolveModel,
  hasOwnSpeeds,
  hasAllergenMode,
  hasHumidifier,
  optionKeys,
  neverReports,
} = require('./accessories.models');

//what the warning says about an option whose key the model never reports, in
//the order the warnings are logged. Only dash-less models qualify (see
//neverReports), which is why the temperature reason can name their registers
const DEAD_OPTIONS = {
  light: (model) => `The light option does nothing for the ${model}, which has no light this plugin can switch.`,
  temperature: (model) =>
    `The temperature option does nothing for the ${model}, ` +
    `whose dash-less registers carry no temperature this plugin can read yet (issue #186).`,
  humidity: (model) =>
    `The humidity option does nothing for the ${model}, which reports no humidity this plugin can read.`,
  preFilter: (model) =>
    `The pre-filter option does nothing for the ${model}, which reports no pre-filter status this plugin can read.`,
  hepaFilter: (model) =>
    `The HEPA filter option does nothing for the ${model}, which reports no HEPA filter status this plugin can read.`,
  carbonFilter: (model) =>
    `The carbon filter option does nothing for the ${model}, which reports no carbon filter status this plugin can read.`,
};

/**
 * Resolves which command set a device runs on, and says so in the log.
 *
 * The model field selects the speed and register maps, so a device quietly
 * running on the default mapping is a device whose controls may do nothing at
 * all. That has to be visible in the log rather than inferred from behaviour,
 * and where the model can be recovered from the device name it is better to
 * drive the device correctly and say why than to be right about the config.
 *
 * @param {{ name: string, model: string, sleepSpeed?: boolean, allergicFunc?: boolean, humidifier?: boolean,
 *   light?: boolean, temperature?: boolean, humidity?: boolean, preFilter?: boolean, hepaFilter?: boolean,
 *   carbonFilter?: boolean }} device
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

  if (device.allergicFunc && !hasAllergenMode(key)) {
    logger.warn(`The allergic mode option does nothing for the ${key}, which has no plain allergen mode.`, device.name);
  }

  if (device.humidifier && !hasHumidifier(key)) {
    logger.warn(
      `The humidifier option does nothing for the ${key}, which has no humidifier on/off this plugin can drive.`,
      device.name
    );
  }

  //the service is still built, so HomeKit shows a constant reading, 0°C for a
  //temperature, which reads as real unless the log says otherwise
  for (const [option, reason] of Object.entries(DEAD_OPTIONS)) {
    if (device[option] && neverReports(key, optionKeys[option])) {
      logger.warn(reason(key), device.name);
    }
  }

  if (key) {
    logger.info(`Using the ${key} command set.`, device.name);
  } else if (device.model === Config.DEFAULT_MODEL) {
    //`model` is never empty by the time it gets here: Config substitutes a
    //placeholder for HomeKit to display. Quoting that back at a user who left
    //the field alone reads as though they had typed it, in exactly the case
    //this message exists to help with
    logger.info(
      'No model is configured, using the default command set. ' +
        'If the controls do not work, set the model to the ID printed on your device.',
      device.name
    );
  } else {
    logger.info(
      `No dedicated mapping for model "${device.model}", using the default command set. ` +
        'If the controls do not work, set the model to the ID printed on your device.',
      device.name
    );
  }

  return key;
};

//what a devices entry that is not a device actually is, in words a user can
//match against their config.json
const describeEntry = (entry) => {
  if (entry === null) {
    return 'null';
  }

  if (entry === undefined) {
    return 'empty';
  }

  if (Array.isArray(entry)) {
    return 'a list';
  }

  return typeof entry === 'object' ? 'a single object' : `a ${typeof entry}`;
};

//not async on purpose. didFinishLaunching does not await this, so a throw from
//an async function would escape its try/catch as an unhandled rejection
const Setup = (deviceMap, devices, generateUUID) => {
  if (!Array.isArray(devices)) {
    logger.warn(
      `The devices setting should be a list of devices, but it is ${describeEntry(devices)}. ` +
        'No devices will be set up.'
    );
    return;
  }

  for (const [index, deviceConfig] of devices.entries()) {
    if (typeof deviceConfig !== 'object' || deviceConfig === null || Array.isArray(deviceConfig)) {
      logger.warn(
        `Entry ${index + 1} in devices is not a device (it is ${describeEntry(deviceConfig)}). ` +
          'This entry will be skipped.'
      );
      continue;
    }

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
