'use strict';

const logger = require('./logger');

exports.generateConfig = (config) => {
  return {
    name: config.name || 'PhilipsAirPlatform',
    aioairctrlPath: exports.validBinaryPath(config.aioairctrlPath),
    debug: config.debug || false,
    cliDebug: config.cliDebug || false,
    warn: config.warn !== false,
    error: config.error !== false,
    extendedError: config.extendedError !== false,
    devices: config.devices || [],
  };
};

//the aioairctrl executable, either a bare command resolved from PATH or a full
//path. existence is not checked here — that is the startup preflight's job.
//
//only a leading '-' is rejected. every call site passes this as argv[0] of an
//execFile/spawn argument array with no shell, so it reaches the OS verbatim:
//spaces are safe, and rejecting them would break real installs on macOS
//('~/Library/Application Support/...') and Windows ('C:\\Program Files\\...').
//a leading '-' is still worth refusing, since no real path starts with one and
//argv[0] is the one position where it could be read as a flag.
//
//an empty result means 'fall back to the PATH lookup', the documented default
exports.validBinaryPath = (path) => {
  if (path === undefined || path === null || path === '') {
    return '';
  }

  if (typeof path !== 'string') {
    logger.warn(`Invalid aioairctrlPath '${path}' configured, resolving 'aioairctrl' from the PATH instead.`);
    return '';
  }

  const trimmed = path.trim();

  if (!trimmed) {
    return '';
  }

  if (trimmed.startsWith('-')) {
    logger.warn(`Invalid aioairctrlPath '${path}' configured, resolving 'aioairctrl' from the PATH instead.`);
    return '';
  }

  return trimmed;
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

//seconds between a reading and the plugin asking for another one. 0 switches
//the refresh off entirely; anything else is floored, because an interval below
//the time a device takes to answer a fresh subscription only wastes wake-ups
exports.validRefreshInterval = (interval) => {
  if (interval === undefined) {
    return 60;
  }

  const number = Number(interval);

  if (!Number.isFinite(number) || number < 0) {
    logger.warn(`Invalid refresh interval '${interval}' configured, using default interval 60s instead.`);
    return 60;
  }

  if (number === 0) {
    return 0;
  }

  return Math.max(Math.round(number), 15);
};

//coerce a raw device field into the finite, in-range number HAP expects;
//homebridge 2's stricter validation warns on undefined/NaN/out-of-range values
exports.hapNumber = (value, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : 0;
};
