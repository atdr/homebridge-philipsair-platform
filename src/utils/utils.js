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

//IP address or hostname; resolution is left to the aioairctrl CLI
exports.validHost = (host) => {
  if (typeof host === 'string' && host.trim()) {
    return host.trim();
  }
};
