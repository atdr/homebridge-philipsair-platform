'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const modelConfig = require('../src/accessories/accessories.models');

describe('accessories.models', () => {
  it('uses three om speeds and no maps by default', () => {
    const model = modelConfig({ model: 'Air Purifier' });

    assert.deepEqual(
      model.speeds.map((s) => s.om),
      ['1', '2', 't']
    );
    assert.deepEqual(model.keyMaps, {});
    assert.deepEqual(model.valueMaps, {});
    assert.deepEqual(model.extraSetFlags, []);
  });

  it('prepends the sleep speed when configured', () => {
    const model = modelConfig({ sleepSpeed: true });

    assert.deepEqual(
      model.speeds.map((s) => s.om),
      ['s', '1', '2', 't']
    );
  });

  it('uses mode-based speeds for AC3036', () => {
    const model = modelConfig({ model: 'AC3036' });

    assert.equal(model.speeds.length, 5);
    assert.deepEqual(model.speeds[0], { mode: 'S' });
    assert.deepEqual(model.speeds[2], { mode: 'M', om: 1 });
  });

  it('maps keys and power values for AC1715', () => {
    const model = modelConfig({ model: 'AC1715' });

    assert.equal(model.speeds.length, 5);
    assert.equal(model.keyMaps.pwr, 'D03-02');
    assert.equal(model.valueMaps.pwr.ON, 1);
    assert.equal(model.valueMaps.pwr[0], 'OFF');
  });

  it('uses D-register speeds and the -I set flag for AC0850', () => {
    const model = modelConfig({ model: 'AC0850' });

    assert.deepEqual(model.speeds[2], { D0310A: 2, D0310C: 18 });
    assert.equal(model.keyMaps.pwr, 'D03102');
    assert.deepEqual(model.extraSetFlags, ['-I']);
  });

  it('ignores sleepSpeed for models with explicit speeds', () => {
    const model = modelConfig({ model: 'AC0850', sleepSpeed: true });
    assert.equal(model.speeds.length, 3);
  });
});
