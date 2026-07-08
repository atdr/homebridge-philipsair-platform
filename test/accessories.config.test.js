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

  it('accepts hostnames as host', () => {
    const device = Config({ name: 'Purifier', host: 'purifier.local' });
    assert.equal(device.host, 'purifier.local');
  });

  it('drops empty hosts', () => {
    const device = Config({ name: 'Purifier', host: ' ' });
    assert.equal(device.host, undefined);
  });

  it('replaces invalid ports with the default', () => {
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', port: 'not a port' }).port, 5683);
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', port: 65536 }).port, 5683);
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
