'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

// hap-nodejs is available through the homebridge devDependency
// (homebridge 2.x ships it as the scoped @homebridge/hap-nodejs package)
const { uuid } = require('@homebridge/hap-nodejs');

const logger = require('../src/utils/logger');
const Setup = require('../src/accessories/accessories.setup');
const { deviceOptions, lackedOptions, mappedModels } = require('../src/accessories/accessories.models');

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

  //these purifiers serve one connection at a time, so two accessories on the
  //same device fight over it and both stall, with nothing in the log saying why
  it('skips a later device that shares a host and port with an earlier one, naming both', () => {
    const { warn, restore } = capture();

    Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', host: '10.0.1.16' },
        { active: true, name: 'Bedroom copy', host: ' 10.0.1.16 ', port: 5683 },
        { active: true, name: 'Study', host: 'Purifier.local' },
        { active: true, name: 'Study copy', host: 'purifier.LOCAL' },
      ],
      uuid.generate
    );
    restore();

    assert.deepEqual(
      [...deviceMap.values()].map((device) => device.name),
      ['Bedroom', 'Study']
    );
    assert.equal(warn.length, 2);
    assert.ok(
      warn[0].includes('Bedroom copy: This device has the same ip/host and port (10.0.1.16:5683) as "Bedroom"')
    );
    assert.ok(warn[0].includes('accepts one connection at a time, so this device will be skipped.'));
    assert.ok(
      warn[1].includes('Study copy: This device has the same ip/host and port (purifier.LOCAL:5683) as "Study"')
    );
  });

  //the map is the caller's, so a device it already holds counts as holding its
  //host just as one set up earlier in the same call does
  it('skips a device that shares a host with one already in the map', () => {
    Setup(deviceMap, [{ active: true, name: 'Bedroom', host: '10.0.1.16' }], uuid.generate);

    const { warn, restore } = capture();

    Setup(deviceMap, [{ active: true, name: 'Bedroom again', host: '10.0.1.16' }], uuid.generate);
    restore();

    assert.deepEqual(
      [...deviceMap.values()].map((device) => device.name),
      ['Bedroom']
    );
    assert.equal(warn.length, 1);
    assert.ok(
      warn[0].includes('Bedroom again: This device has the same ip/host and port (10.0.1.16:5683) as "Bedroom"')
    );
  });

  it('sets up two devices on the same host when their ports differ', () => {
    Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', host: '10.0.1.16' },
        { active: true, name: 'Study', host: '10.0.1.16', port: 5684 },
      ],
      uuid.generate
    );

    assert.equal(deviceMap.size, 2);
  });

  //an inactive device is not exposed, so it holds no connection to fight over
  it('does not count an inactive device as holding its host', () => {
    Setup(
      deviceMap,
      [
        { active: false, name: 'Old', host: '10.0.1.16' },
        { active: true, name: 'Bedroom', host: '10.0.1.16' },
      ],
      uuid.generate
    );

    assert.deepEqual(
      [...deviceMap.values()].map((device) => device.name),
      ['Bedroom']
    );
  });

  //a device quietly running on the default mapping is a device whose controls
  //may do nothing, so which command set is in force has to be in the log
  it('names the command set each device runs on', async () => {
    const { info, warn, restore } = capture();

    await Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', model: 'ac0850/11', host: '192.168.1.142' },
        { active: true, name: 'Study', model: 'AC0820', host: '192.168.1.143' },
      ],
      uuid.generate
    );
    restore();

    assert.equal([...deviceMap.values()].map((device) => device.modelKey).join(','), 'AC0850,');
    assert.ok(info.some((message) => message.includes('Bedroom: Using the AC0850 command set')));
    assert.ok(info.some((message) => message.includes('Study: No dedicated mapping for model "AC0820"')));
    assert.deepEqual(warn, []);
  });

  //the placeholder Config substitutes for an empty model field is not something
  //the user typed, so it must not be quoted back at them as though it were
  it('distinguishes an empty model field from a model it has no mapping for', async () => {
    const { info, restore } = capture();

    await Setup(deviceMap, [{ active: true, name: 'Bedroom', host: '192.168.1.142' }], uuid.generate);
    restore();

    assert.ok(info.some((message) => message.includes('Bedroom: No model is configured, using the default')));
    assert.ok(!info.some((message) => message.includes('Air Purifier')));
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

  it('says when the sleep speed option cannot do anything for the model', async () => {
    const { warn, restore } = capture();

    await Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', model: 'AC0850', host: '10.0.1.16', sleepSpeed: true },
        { active: true, name: 'Study', model: 'AC3829', host: '10.0.1.17', sleepSpeed: true },
        { active: true, name: 'Office', model: 'AC0820', host: '10.0.1.18', sleepSpeed: true },
      ],
      uuid.generate
    );
    restore();

    //the AC0820 runs the default speeds, where the option adds a sleep step
    assert.equal(warn.length, 2);
    assert.ok(warn[0].includes('Bedroom: The sleep speed option does nothing for the AC0850'));
    assert.ok(warn[1].includes('Study: The sleep speed option does nothing for the AC3829'));
  });

  it('says when the allergic mode option cannot do anything for the model', async () => {
    const { warn, restore } = capture();

    await Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', model: 'AC0850', host: '10.0.1.16', allergicFunc: true },
        { active: true, name: 'Study', host: '10.0.1.17', allergicFunc: true },
        { active: true, name: 'Lounge', model: 'AC3829', host: '10.0.1.18', allergicFunc: true },
      ],
      uuid.generate
    );
    restore();

    assert.equal(warn.length, 1);
    assert.ok(warn[0].includes('Bedroom: The allergic mode option does nothing for the AC0850'));
  });

  //the AC3420, AC3421 and AC3737 have a target humidity register but no
  //humidifier on/off this plugin can write, so no humidifier is offered
  it('says when the humidifier option cannot do anything for the model', async () => {
    const { warn, restore } = capture();

    await Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', model: 'AC3420', host: '10.0.1.16', humidifier: true },
        { active: true, name: 'Study', model: 'AC3737', host: '10.0.1.17', humidifier: true },
        { active: true, name: 'Lounge', model: 'AC3829', host: '10.0.1.18', humidifier: true },
        { active: true, name: 'Hall', model: 'AC3421', host: '10.0.1.19' },
      ],
      uuid.generate
    );
    restore();

    assert.equal(warn.length, 2);
    assert.ok(warn[0].includes('Bedroom: The humidifier option does nothing for the AC3420'));
    assert.ok(warn[1].includes('Study: The humidifier option does nothing for the AC3737'));
  });

  //a sensor, light or filter whose key the model can never report shows a
  //constant reading in HomeKit, 0°C for a temperature, so it has to be said
  const everyOption = {
    light: true,
    temperature: true,
    humidity: true,
    preFilter: true,
    hepaFilter: true,
    carbonFilter: true,
  };

  it('says when a sensor, light or filter option cannot do anything for the model', async () => {
    const { warn, restore } = capture();

    await Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', model: 'AC0950', host: '10.0.1.16', ...everyOption },
        { active: true, name: 'Study', model: 'AC0651', host: '10.0.1.17', humidity: true },
        { active: true, name: 'Hall', model: 'AC2210', host: '10.0.1.18', light: true, preFilter: true },
      ],
      uuid.generate
    );
    restore();

    assert.deepEqual(warn, [
      'Bedroom: The light option does nothing for the AC0950, which has no light this plugin can switch.',
      'Bedroom: The temperature option does nothing for the AC0950, ' +
        'whose dash-less registers carry no temperature this plugin can read yet (issue #186).',
      'Bedroom: The carbon filter option does nothing for the AC0950, ' +
        'which reports no carbon filter status this plugin can read.',
      'Study: The humidity option does nothing for the AC0651, which reports no humidity this plugin can read.',
    ]);
  });

  it('claims nothing about the options where the model data cannot prove them dead', async () => {
    const { warn, restore } = capture();

    await Setup(
      deviceMap,
      [
        { active: true, name: 'Bedroom', host: '10.0.1.16', ...everyOption },
        { active: true, name: 'Study', model: 'AC0820', host: '10.0.1.17', ...everyOption },
        { active: true, name: 'Lounge', model: 'AC3829', host: '10.0.1.18', ...everyOption },
        { active: true, name: 'Hall', model: 'AC0850', host: '10.0.1.19', ...everyOption },
        { active: true, name: 'Office', model: 'AC1715', host: '10.0.1.20', ...everyOption },
        { active: true, name: 'Den', model: 'AC0650', host: '10.0.1.21', ...everyOption },
      ],
      uuid.generate
    );
    restore();

    assert.deepEqual(warn, []);
  });

  it('keeps the existing option warnings ahead of the new ones', async () => {
    const { warn, restore } = capture();

    await Setup(
      deviceMap,
      [
        {
          active: true,
          name: 'Bedroom',
          model: 'AC3737',
          host: '10.0.1.16',
          sleepSpeed: true,
          allergicFunc: true,
          humidifier: true,
          temperature: true,
        },
      ],
      uuid.generate
    );
    restore();

    assert.deepEqual(warn, [
      'Bedroom: The sleep speed option does nothing for the AC3737, which brings its own speed table.',
      'Bedroom: The allergic mode option does nothing for the AC3737, which has no plain allergen mode.',
      'Bedroom: The humidifier option does nothing for the AC3737, which has no humidifier on/off this plugin can drive.',
      'Bedroom: The temperature option does nothing for the AC3737, ' +
        'whose dash-less registers carry no temperature this plugin can read yet (issue #186).',
    ]);
  });

  //the warnings read the capability table, so every option it lists for a
  //model has a warning, and nothing else does
  it('warns once for each option the capability table says the model lacks', () => {
    const allOn = Object.fromEntries(deviceOptions.map((option) => [option, true]));

    for (const [index, model] of mappedModels.entries()) {
      const { warn, restore } = capture();

      Setup(
        new Map(),
        [{ active: true, name: 'Purifier', model, host: `10.0.2.${index + 1}`, ...allOn }],
        uuid.generate
      );
      restore();

      assert.equal(warn.length, lackedOptions(model).length, model);
      assert.ok(
        warn.every((message) => message.includes(`for the ${model},`)),
        model
      );
    }
  });

  //Homebridge does not await didFinishLaunching, and nor does it await Setup,
  //so Setup has to finish (or throw) synchronously for the try/catch around it
  //to see a failure at all
  it('runs synchronously rather than returning a promise', () => {
    const result = Setup(deviceMap, [{ active: true, name: 'Purifier', host: '192.168.1.142' }], uuid.generate);

    assert.equal(result, undefined);
    assert.equal(deviceMap.size, 1);
  });

  //a hand edit that leaves a stray entry must not take the other devices with it
  it('skips an entry that is not a device, and still sets up the others', () => {
    const { warn, restore } = capture();

    Setup(
      deviceMap,
      [null, 'Purifier', 42, [{ name: 'Nested' }], { active: true, name: 'Bedroom', host: '10.0.1.16' }],
      uuid.generate
    );
    restore();

    assert.deepEqual(
      [...deviceMap.values()].map((device) => device.name),
      ['Bedroom']
    );
    assert.equal(warn.filter((message) => message.includes('is not a device')).length, 4);
    assert.ok(warn.some((message) => message.includes('Entry 1 in devices is not a device (it is null)')));
    assert.ok(warn.some((message) => message.includes('Entry 2 in devices is not a device (it is a string)')));
    assert.ok(warn.some((message) => message.includes('Entry 3 in devices is not a device (it is a number)')));
    assert.ok(warn.some((message) => message.includes('Entry 4 in devices is not a device (it is a list)')));
  });

  //the accessory's identity is derived from the name, and that only takes text:
  //a name written without quotes used to throw there and stop the whole setup
  it('skips a device whose name is not text, and still sets up the others', () => {
    const { warn, restore } = capture();

    Setup(
      deviceMap,
      [
        { active: true, name: 123, host: '10.0.1.16' },
        { active: true, name: true, host: '10.0.1.17' },
        { active: true, name: ['Bedroom'], host: '10.0.1.18' },
        { active: true, name: 'Study', host: '10.0.1.19' },
      ],
      uuid.generate
    );
    restore();

    assert.deepEqual(
      [...deviceMap.values()].map((device) => device.name),
      ['Study']
    );
    assert.equal(warn.length, 3);
    assert.ok(warn[0].includes('The name of entry 1 in devices is not text (it is a number)'));
    assert.ok(warn[0].includes('Put the name in quotes. This device will be skipped.'));
    assert.ok(warn[1].includes('The name of entry 2 in devices is not text (it is a boolean)'));
    assert.ok(warn[2].includes('The name of entry 3 in devices is not text (it is a list)'));
  });

  it('treats a devices value that is not a list as no devices, and says what it expected', () => {
    for (const devices of [{ a: 1 }, 'Purifier', 42, null, undefined]) {
      const { warn, restore } = capture();

      assert.doesNotThrow(() => Setup(deviceMap, devices, uuid.generate));
      restore();

      assert.equal(deviceMap.size, 0);
      assert.equal(warn.length, 1, `one warning for ${devices}`);
      assert.match(warn[0], /devices setting should be a list of devices/);
    }

    const { warn, restore } = capture();
    Setup(deviceMap, { a: 1 }, uuid.generate);
    restore();
    assert.match(warn[0], /but it is a single object\. No devices will be set up\./);
  });

  it('leaves a trace when a device is skipped for being inactive', async () => {
    const { info, restore } = capture();

    await Setup(deviceMap, [{ active: false, name: 'Bedroom', host: '10.0.1.16' }], uuid.generate);
    restore();

    assert.equal(deviceMap.size, 0);
    assert.ok(info.some((message) => message.includes('Bedroom: Not active in the config')));
  });
});
