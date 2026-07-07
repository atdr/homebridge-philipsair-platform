'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const Config = require('../src/accessories/accessories.config');

describe('accessories.config', () => {
  it('applies defaults for a minimal device', () => {
    const device = Config({ name: 'Purifier', host: '192.168.1.142' });

    assert.deepEqual(device, {
      active: false,
      name: 'Purifier',
      manufacturer: 'Philips',
      model: 'Air Purifier',
      serialNumber: '000000',
      host: '192.168.1.142',
      port: 5683,
      light: false,
      temperature: false,
      humidity: false,
      humidifier: false,
      allergicFunc: false,
      sleepSpeed: false,
      preFilter: false,
      carbonFilter: false,
      hepaFilter: false,
    });
  });

  it('drops invalid host addresses', () => {
    const device = Config({ name: 'Purifier', host: 'not-an-ip' });
    assert.equal(device.host, undefined);
  });

  it('keeps explicit values', () => {
    const device = Config({
      active: true,
      name: 'Bedroom',
      model: 'AC0850',
      host: '10.0.0.2',
      port: 3333,
      hepaFilter: true,
    });

    assert.equal(device.active, true);
    assert.equal(device.model, 'AC0850');
    assert.equal(device.port, 3333);
    assert.equal(device.hepaFilter, true);
  });
});
