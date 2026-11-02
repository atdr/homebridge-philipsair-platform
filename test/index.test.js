'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const registerPlugin = require('../index');
const { name: pluginName } = require('../package.json');

describe('plugin registration', () => {
  it('registers the current and legacy platform identifiers', () => {
    const registrations = [];
    const homebridge = {
      registerPlatform: (...args) => registrations.push(args),
    };

    registerPlugin(homebridge);

    assert.deepEqual(
      registrations.map(([name, platformName, , dynamic]) => [name, platformName, dynamic]),
      [
        [pluginName, 'PhilipsAirPlatform', true],
        [pluginName, 'philipsAir', true],
      ]
    );
    assert.equal(registrations[0][2], registrations[1][2]);
  });
});
