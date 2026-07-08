'use strict';

const { validHost, validPort } = require('../utils/utils');

const Config = (deviceConfig) => {
  return {
    active: deviceConfig.active || false,
    name: deviceConfig.name,
    manufacturer: deviceConfig.manufacturer || 'Philips',
    model: deviceConfig.model || 'Air Purifier',
    serialNumber: deviceConfig.serialNumber || '000000',
    host: validHost(deviceConfig.host),
    port: validPort(deviceConfig.port),
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

module.exports = Config;
