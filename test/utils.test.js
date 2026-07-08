'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { generateConfig, validHost } = require('../src/utils/utils');

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
});
