'use strict';

const logger = require('./logger');

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
  if (port === undefined) {
    return 5683;
  }

  const number = Number(port);

  if (Number.isInteger(number) && number >= 1 && number <= 65535) {
    return number;
  }

  logger.warn(`Invalid port '${port}' configured, using default port 5683 instead.`);
  return 5683;
};

//coerce a raw device field into the finite, in-range number HAP expects;
//homebridge 2's stricter validation warns on undefined/NaN/out-of-range values
exports.hapNumber = (value, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : 0;
};
