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

//IP address or hostname; resolution is left to the aioairctrl CLI, but
//values that could be parsed as CLI flags or extra arguments are rejected
exports.validHost = (host) => {
  if (typeof host !== 'string') {
    return;
  }

  const trimmed = host.trim();

  if (!trimmed || trimmed.startsWith('-') || /\s/.test(trimmed)) {
    return;
  }

  return trimmed;
};

exports.validPort = (port) => {
  const number = Number(port);

  if (Number.isInteger(number) && number >= 1 && number <= 65535) {
    return number;
  }

  return 5683;
};
