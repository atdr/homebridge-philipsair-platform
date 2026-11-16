'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const Config = require('../src/accessories/accessories.config');

describe('accessories.config', () => {
  it('applies defaults for a minimal device', () => {
    const device = Config({ name: 'Purifier', host: '192.168.1.142' });

    assert.deepEqual(device, {
      active: true,
      name: 'Purifier',
      manufacturer: 'Philips',
      model: 'Air Purifier',
      serialNumber: '000000',
      modelSet: false,
      serialNumberSet: false,
      host: '192.168.1.142',
      port: 5683,
      refreshInterval: 60,
      filterChangeThreshold: 10,
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

  //the shaped value cannot say whether it was typed or defaulted, and the
  //device's own model and serial number may fill in only the defaulted ones
  it('records whether the model and serial number were set or defaulted', () => {
    const typed = Config({ name: 'Purifier', host: '10.0.0.2', model: 'AC0850', serialNumber: '000000' });

    assert.equal(typed.modelSet, true);
    assert.equal(typed.serialNumberSet, true);
    //typing the placeholder text is still typing it
    assert.equal(Config({ name: 'P', host: '10.0.0.2', model: 'Air Purifier' }).modelSet, true);
    assert.equal(Config({ name: 'P', host: '10.0.0.2', model: '', serialNumber: '' }).modelSet, false);
  });

  //a device is opted out, not opted in: the config UI writes the key on every
  //device it saves, so the only config without one was written by hand
  it('skips a device only when it says so explicitly', () => {
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', active: false }).active, false);
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2' }).active, true);
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

  it('floors a refresh interval below the minimum, and keeps zero as disabled', () => {
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', refreshInterval: 5 }).refreshInterval, 15);
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', refreshInterval: 0 }).refreshInterval, 0);
  });

  it('keeps a filter change threshold and replaces an invalid one with the default', () => {
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', filterChangeThreshold: 25 }).filterChangeThreshold, 25);
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', filterChangeThreshold: 0 }).filterChangeThreshold, 0);
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', filterChangeThreshold: 150 }).filterChangeThreshold, 10);
    assert.equal(Config({ name: 'Purifier', host: '10.0.0.2', filterChangeThreshold: null }).filterChangeThreshold, 10);
  });

  it('keeps explicit values', () => {
    const device = Config({
      active: true,
      name: 'Bedroom',
      model: 'AC0850',
      host: '10.0.0.2',
      port: 3333,
      refreshInterval: 120,
      hepaFilter: true,
    });

    assert.equal(device.active, true);
    assert.equal(device.model, 'AC0850');
    assert.equal(device.port, 3333);
    assert.equal(device.refreshInterval, 120);
    assert.equal(device.hepaFilter, true);
  });
});
