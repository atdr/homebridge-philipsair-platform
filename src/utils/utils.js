'use strict';

const logger = require('./logger');

const DEFAULT_FILTER_CHANGE_THRESHOLD = 10;

exports.generateConfig = (config) => {
  return {
    name: config.name || 'PhilipsAirPlatform',
    aioairctrlPath: exports.validBinaryPath(config.aioairctrlPath),
    debug: config.debug || false,
    cliDebug: config.cliDebug || false,
    warn: config.warn !== false,
    error: config.error !== false,
    extendedError: config.extendedError !== false,
    //only a missing setting defaults. anything written there, a null or a
    //false included, goes on to the device setup, which says what is wrong
    //with it rather than starting with no devices and no word why
    devices: config.devices === undefined ? [] : config.devices,
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

//null and an empty string are what some editors write for a number field that
//was cleared, so they mean unset just as a missing key does, and say nothing
exports.validPort = (port) => {
  if (port === undefined || port === null || (typeof port === 'string' && !port.trim())) {
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

//FilterLifeLevel percent at or below which a filter is reported as due for a
//change. Unset means the default; anything else that is not a number from 0 to
//100 (a null included, which the config UI never writes) warns and falls back
exports.validFilterChangeThreshold = (threshold) => {
  if (threshold === undefined) {
    return DEFAULT_FILTER_CHANGE_THRESHOLD;
  }

  const isNumeric = typeof threshold === 'number' || (typeof threshold === 'string' && threshold.trim() !== '');
  const number = isNumeric ? Number(threshold) : NaN;

  if (!Number.isInteger(number) || number < 0 || number > 100) {
    logger.warn(
      `Invalid filter change threshold '${threshold}' configured, using default ${DEFAULT_FILTER_CHANGE_THRESHOLD}% instead.`
    );
    return DEFAULT_FILTER_CHANGE_THRESHOLD;
  }

  return number;
};

//coerce a raw device field into the finite, in-range number HAP expects;
//homebridge 2's stricter validation warns on undefined/NaN/out-of-range values
exports.hapNumber = (value, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : 0;
};

//the device's air quality index, 1 (best) to 12 (worst), as a HomeKit
//AirQuality level: 1 Excellent, 2 Good, 3 Fair, 4 Inferior, 5 Poor, and 0 for
//unknown. Philips groups the index into four bands, 1-3, 4-6, 7-9 and 10-12,
//and HomeKit has five levels, so the bands keep their edges and the cleanest
//reading of the first one is Excellent. Dividing by three, as this once did,
//stopped the worst band at Inferior and left Poor out of reach (issue #176)
exports.airQualityLevel = (index) => {
  const number = Number(index);

  if (!Number.isFinite(number) || number < 1) {
    return 0;
  }

  if (number <= 1) {
    return 1;
  }

  if (number <= 3) {
    return 2;
  }

  if (number <= 6) {
    return 3;
  }

  return number <= 9 ? 4 : 5;
};
