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

  describe('normaliseModel', () => {
    //the label on the device reads 'AC0850/11', and that is what users type
    it('accepts what is printed on the device, in any case', () => {
      for (const typed of ['AC0850', 'ac0850', ' AC0850 ', 'AC0850/11', 'ac0850/31', 'AC 0850']) {
        assert.equal(modelConfig.normaliseModel(typed), 'AC0850', `did not normalise ${JSON.stringify(typed)}`);
      }
    });

    it('leaves anything that is not a model ID alone', () => {
      assert.equal(modelConfig.normaliseModel('Air Purifier'), 'AIRPURIFIER');
      assert.equal(modelConfig.normaliseModel(undefined), '');
      assert.equal(modelConfig.normaliseModel(null), '');
    });
  });

  describe('resolveModel', () => {
    it('resolves the model field, suffix and all', () => {
      assert.deepEqual(modelConfig.resolveModel({ model: 'ac0850/11', name: 'Bedroom' }), {
        key: 'AC0850',
        source: 'model',
        nameSuggests: undefined,
      });
    });

    //the reported failure: the ID typed into the Home app label, model untouched
    it('recovers a model ID left in the device name', () => {
      assert.deepEqual(modelConfig.resolveModel({ model: 'Air Purifier', name: 'AC0850' }), {
        key: 'AC0850',
        source: 'name',
        nameSuggests: undefined,
      });

      assert.equal(modelConfig.resolveModel({ name: 'AC0850 bedroom' }).key, 'AC0850');
    });

    it('reports a name that disagrees with a configured model rather than acting on it', () => {
      const resolved = modelConfig.resolveModel({ model: 'AC1715', name: 'AC0850 bedroom' });

      assert.equal(resolved.key, 'AC1715');
      assert.equal(resolved.nameSuggests, 'AC0850');
    });

    it('never guesses at a model it does not map', () => {
      assert.equal(modelConfig.resolveModel({ model: 'AC3O36', name: 'Study' }).key, undefined);
      assert.equal(modelConfig.resolveModel({ model: 'AC2889' }).key, undefined);
      assert.equal(modelConfig.resolveModel({ name: 'Purifier 2' }).key, undefined);
      assert.equal(modelConfig.resolveModel({}).key, undefined);
    });

    it('drives the device with the recovered mapping, not the default one', () => {
      assert.equal(modelConfig({ name: 'AC0850' }).keyMaps.pwr, 'D03102');
      assert.equal(modelConfig({ model: 'ac0850/31' }).keyMaps.pwr, 'D03102');
      //a stamped modelKey wins, since setup resolved and reported it already
      assert.equal(modelConfig({ model: 'nonsense', modelKey: 'AC1715' }).keyMaps.pwr, 'D03-02');
    });
  });
});
