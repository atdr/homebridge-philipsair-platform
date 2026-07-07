'use strict';

exports.generateConfig = (config) => {
  return {
    name: config.name || 'PhilipsAirPlatform',
    aioairctrlPath: config.aioairctrlPath || '',
    debug: config.debug || false,
    warn: config.warn !== false,
    error: config.error !== false,
    extendedError: config.extendedError !== false,
    devices: config.devices || [],
  };
};

exports.validIP = (ip) => {
  if (
    /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(
      ip
    )
  ) {
    return ip;
  }
};
