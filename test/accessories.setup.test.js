'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

// hap-nodejs is available through the homebridge devDependency
// (homebridge 2.x ships it as the scoped @homebridge/hap-nodejs package)
const { uuid } = require('@homebridge/hap-nodejs');

const logger = require('../src/utils/logger');
const Setup = require('../src/accessories/accessories.setup');

// silence the singleton logger for the whole test process
const noop = () => {};
logger.configure({ info: noop, warn: noop, error: noop }, {});

// capture what one Setup call logs, then put the silence back
const capture = () => {
  const info = [];
  const warn = [];

  logger.configure({ info: (message) => info.push(message), warn: (message) => warn.push(message), error: noop }, {});

  return { info, warn, restore: () => logger.configure({ info: noop, warn: noop, error: noop }, {}) };
};

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

  it('distinguishes missing hosts from configured-but-invalid hosts', async () => {
    const warnings = [];
    logger.configure({ info: noop, warn: (message) => warnings.push(message), error: noop }, {});

    await Setup(
      deviceMap,
      [
        { active: true, name: 'Invalid Host', host: '-D' },
        { active: true, name: 'No Host' },
      ],
      uuid.generate
    );

    logger.configure({ info: noop, warn: noop, error: noop }, {});

    assert.equal(deviceMap.size, 0);
    assert.ok(warnings.some((message) => message.includes('The configured ip/host for this device is invalid')));
    assert.ok(warnings.some((message) => message.includes('There is no ip/host configured for this device')));
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

  //a device quietly running on the default mapping is a device whose controls
  //may do nothing, so which command set is in force has to be in the log
  it('names the command set each device runs on', async () => {
    const { info, warn, restore } = capture();

    await Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', model: 'ac0850/11', host: '192.168.1.142' },
        { active: true, name: 'Study', model: 'AC2889', host: '192.168.1.143' },
      ],
      uuid.generate
    );
    restore();

    assert.equal([...deviceMap.values()].map((device) => device.modelKey).join(','), 'AC0850,');
    assert.ok(info.some((message) => message.includes('Bedroom: Using the AC0850 command set')));
    assert.ok(info.some((message) => message.includes('Study: No tested mapping for model "AC2889"')));
    assert.deepEqual(warn, []);
  });

  //the reported failure: 'I made sure it was named AC0850 in the plugin'
  it('adopts a model ID left in the device name and says where it came from', async () => {
    const { info, warn, restore } = capture();

    await Setup(deviceMap, [{ active: true, name: 'AC0850', host: '192.168.1.142' }], uuid.generate);
    restore();

    const [device] = deviceMap.values();

    assert.equal(device.modelKey, 'AC0850');
    assert.ok(warn.some((message) => message.includes('looks like a model ID')));
    assert.ok(warn.some((message) => message.includes('Move it to the model field')));
    assert.ok(info.some((message) => message.includes('Using the AC0850 command set')));
  });

  it('reports a device name that disagrees with the configured model, without acting on it', async () => {
    const { warn, restore } = capture();

    await Setup(
      deviceMap,
      [{ active: true, name: 'AC0850 bedroom', model: 'AC1715', host: '10.0.1.16' }],
      uuid.generate
    );
    restore();

    const [device] = deviceMap.values();

    assert.equal(device.modelKey, 'AC1715');
    assert.ok(warn.some((message) => message.includes('mentions AC0850, but the model is set to AC1715')));
  });
});
