'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { generateConfig, validIP } = require('../src/utils/utils');

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

describe('validIP', () => {
  it('returns valid IPv4 addresses unchanged', () => {
    assert.equal(validIP('192.168.1.142'), '192.168.1.142');
    assert.equal(validIP('10.0.0.1'), '10.0.0.1');
    assert.equal(validIP('255.255.255.255'), '255.255.255.255');
  });

  it('returns undefined for invalid addresses', () => {
    assert.equal(validIP('256.1.1.1'), undefined);
    assert.equal(validIP('purifier.local'), undefined);
    assert.equal(validIP(''), undefined);
    assert.equal(validIP('192.168.1'), undefined);
  });
});
