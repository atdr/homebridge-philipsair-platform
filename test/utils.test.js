'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const logger = require('../src/utils/logger');
const { generateConfig, validHost, validPort, hapNumber } = require('../src/utils/utils');

//capture warnings so the silent-fallback behavior can be asserted
const warnings = [];
const noop = () => {};
logger.configure({ info: noop, warn: (message) => warnings.push(message), error: noop }, {});

describe('generateConfig', () => {
  it('applies defaults for an empty config', () => {
    assert.deepEqual(generateConfig({}), {
      name: 'PhilipsAirPlatform',
      aioairctrlPath: '',
      debug: false,
      warn: true,
      error: true,
      extendedError: true,
      devices: [],
    });
  });

  it('keeps explicit values', () => {
    const config = generateConfig({
      name: 'My Platform',
      debug: true,
      warn: false,
      error: false,
      extendedError: false,
      devices: [{ name: 'Purifier' }],
    });

    assert.equal(config.name, 'My Platform');
    assert.equal(config.debug, true);
    assert.equal(config.warn, false);
    assert.equal(config.error, false);
    assert.equal(config.extendedError, false);
    assert.deepEqual(config.devices, [{ name: 'Purifier' }]);
  });
});

describe('validHost', () => {
  it('accepts IP addresses and hostnames', () => {
    assert.equal(validHost('192.168.1.142'), '192.168.1.142');
    assert.equal(validHost('purifier.local'), 'purifier.local');
    assert.equal(validHost('my-purifier'), 'my-purifier');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(validHost(' purifier.local '), 'purifier.local');
  });

  it('returns undefined for empty or non-string values', () => {
    assert.equal(validHost(''), undefined);
    assert.equal(validHost('   '), undefined);
    assert.equal(validHost(undefined), undefined);
    assert.equal(validHost(42), undefined);
  });

  it('rejects values that would parse as CLI flags or extra arguments', () => {
    assert.equal(validHost('-D'), undefined);
    assert.equal(validHost('--help'), undefined);
    assert.equal(validHost('purifier.local -D'), undefined);
    assert.equal(validHost('purifier local'), undefined);
  });
});

describe('validPort', () => {
  it('accepts ports in the valid range', () => {
    assert.equal(validPort(1), 1);
    assert.equal(validPort(5683), 5683);
    assert.equal(validPort(65535), 65535);
  });

  it('falls back to the default port for invalid values', () => {
    assert.equal(validPort(undefined), 5683);
    assert.equal(validPort(0), 5683);
    assert.equal(validPort(-1), 5683);
    assert.equal(validPort(65536), 5683);
    assert.equal(validPort(80.5), 5683);
    assert.equal(validPort('5683 -D'), 5683);
  });

  it('warns when a configured port is invalid, but not when it is unset', () => {
    warnings.length = 0;

    validPort(undefined);
    assert.equal(warnings.length, 0);

    validPort(65536);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Invalid port '65536'/);
  });
});

describe('hapNumber', () => {
  it('passes finite in-range numbers through unchanged', () => {
    assert.equal(hapNumber(22.5, -270, 100), 22.5);
    assert.equal(hapNumber(0, 0, 100), 0);
    assert.equal(hapNumber(100, 0, 100), 100);
  });

  it('coerces numeric strings', () => {
    assert.equal(hapNumber('22', -270, 100), 22);
    assert.equal(hapNumber('35', 0, 1000), 35);
  });

  it('clamps values outside the range to the nearest bound', () => {
    assert.equal(hapNumber(1500, 0, 1000), 1000);
    assert.equal(hapNumber(-5, 0, 100), 0);
    assert.equal(hapNumber(150, 0, 100), 100);
  });

  it('allows negative values within a negative-capable range', () => {
    assert.equal(hapNumber(-5, -270, 100), -5);
  });

  it('falls back to 0 for non-finite values', () => {
    assert.equal(hapNumber(undefined, 0, 100), 0);
    assert.equal(hapNumber(null, 0, 100), 0);
    assert.equal(hapNumber(NaN, 0, 100), 0);
    assert.equal(hapNumber('not a number', 0, 100), 0);
    assert.equal(hapNumber(Infinity, 0, 100), 0);
  });
});
