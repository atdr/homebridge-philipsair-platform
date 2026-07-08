'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

// hap-nodejs is available through the homebridge devDependency
const { uuid } = require('hap-nodejs');

const logger = require('../src/utils/logger');
const Setup = require('../src/accessories/accessories.setup');

// silence the singleton logger for the whole test process
const noop = () => {};
logger.configure({ info: noop, warn: noop, error: noop }, {});

describe('accessories.setup', () => {
  let deviceMap;

  beforeEach(() => {
    deviceMap = new Map();
  });

  it('registers an active, valid device', async () => {
    await Setup(deviceMap, [{ active: true, name: 'Purifier', host: '192.168.1.142' }], uuid.generate);

    assert.equal(deviceMap.size, 1);
    const [device] = deviceMap.values();
    assert.equal(device.name, 'Purifier');
    assert.equal(device.host, '192.168.1.142');
  });

  it('keys devices by the historical name-derived UUID so accessories never re-pair', async () => {
    await Setup(deviceMap, [{ active: true, name: 'Livingroom Philips', host: '192.168.178.111' }], uuid.generate);

    //pinned output of the sha1-based algorithm used since v1.x
    assert.deepEqual([...deviceMap.keys()], ['e0ab97d2-b90f-4f4b-b921-fa2f9e719ce4']);
  });

  it('skips inactive devices', async () => {
    await Setup(deviceMap, [{ active: false, name: 'Purifier', host: '192.168.1.142' }], uuid.generate);
    assert.equal(deviceMap.size, 0);
  });

  it('skips devices without a name or host', async () => {
    await Setup(
      deviceMap,
      [
        { active: true, host: '192.168.1.142' },
        { active: true, name: 'No Host' },
      ],
      uuid.generate
    );
    assert.equal(deviceMap.size, 0);
  });

  it('deduplicates devices with the same name', async () => {
    await Setup(
      deviceMap,
      [
        { active: true, name: 'Purifier', host: '192.168.1.142' },
        { active: true, name: 'Purifier', host: '192.168.1.143' },
      ],
      uuid.generate
    );

    assert.equal(deviceMap.size, 1);
    const [device] = deviceMap.values();
    assert.equal(device.host, '192.168.1.142');
  });
});
