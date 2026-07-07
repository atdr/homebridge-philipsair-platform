'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

// hap-nodejs is available through the homebridge devDependency
const { uuid } = require('hap-nodejs');

const { generateConfig, UUIDgenerate, validIP } = require('../src/utils/utils');

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

describe('UUIDgenerate', () => {
  it('matches hap-nodejs uuid.generate so accessories never re-pair', () => {
    for (const name of ['Livingroom Philips', 'Air Purifier', 'Bedroom', 'AC0850', 'ä unicode ✓']) {
      assert.equal(UUIDgenerate(name), uuid.generate(name));
    }
  });

  it('is deterministic', () => {
    assert.equal(UUIDgenerate('same input'), UUIDgenerate('same input'));
    assert.notEqual(UUIDgenerate('input a'), UUIDgenerate('input b'));
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
