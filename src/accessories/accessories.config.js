'use strict';

const { validHost, validPort, validRefreshInterval } = require('../utils/utils');

//what HomeKit shows as the model when the field is empty. It is a placeholder,
//not a model ID, so anything that reads `model` to decide something has to be
//able to tell it apart from a value the user actually typed
const DEFAULT_MODEL = 'Air Purifier';

const Config = (deviceConfig) => {
  return {
    //enabled unless it says otherwise, the same idiom the platform log flags
    //use. The config UI writes this key on every device it saves, so the only
    //config that reaches here without one was written by hand, where a device
    //someone listed and never activated is far more likely an oversight than an
    //intent
    active: deviceConfig.active !== false,
    name: deviceConfig.name,
    manufacturer: deviceConfig.manufacturer || 'Philips',
    model: deviceConfig.model || DEFAULT_MODEL,
    serialNumber: deviceConfig.serialNumber || '000000',
    host: validHost(deviceConfig.host),
    port: validPort(deviceConfig.port),
    refreshInterval: validRefreshInterval(deviceConfig.refreshInterval),
    light: deviceConfig.light || false,
    temperature: deviceConfig.temperature || false,
    humidity: deviceConfig.humidity || false,
    humidifier: deviceConfig.humidifier || false,
    allergicFunc: deviceConfig.allergicFunc || false,
    sleepSpeed: deviceConfig.sleepSpeed || false,
    preFilter: deviceConfig.preFilter || false,
    carbonFilter: deviceConfig.carbonFilter || false,
    hepaFilter: deviceConfig.hepaFilter || false,
  };
};

Config.DEFAULT_MODEL = DEFAULT_MODEL;

module.exports = Config;
