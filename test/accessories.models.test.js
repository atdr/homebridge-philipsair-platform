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

  describe('identifyModel', () => {
    //a real AC0850/31 dump, from the register inventory on issue #46
    const ac0850Status = {
      D01102: 5,
      D03102: 0,
      D0310A: 2,
      D0310C: 0,
      D0310D: 0,
      D03120: 1,
      D03221: 11,
      D0312A: 1,
      D0312C: 4,
      D05408: 4800,
      D0540E: 251,
    };

    it('fingerprints a model from the registers it reports', () => {
      assert.deepEqual(modelConfig.identifyModel(ac0850Status), { key: 'AC0850', certainty: 'fingerprint' });
      assert.deepEqual(modelConfig.identifyModel({ 'D03-02': 'ON', 'D03-13': 'Turbo', 'D03-32': 9 }), {
        key: 'AC1715',
        certainty: 'fingerprint',
      });
    });

    //no field name is assumed: no dump from a self-identifying model is
    //recorded here, so any value that is exactly a mapped model counts
    it('takes a device at its word when it names itself, wherever it says so', () => {
      assert.deepEqual(modelConfig.identifyModel({ pwr: '1', om: '2', type: 'AC3036' }), {
        key: 'AC3036',
        certainty: 'reported',
      });
      assert.equal(modelConfig.identifyModel({ pwr: '1', om: '2', modelid: 'AC1715/10' }).key, 'AC1715');
    });

    it('identifies nothing from a status that names no model this plugin maps', () => {
      //AC3829 self-identifies, but has no mapping to switch to
      assert.equal(modelConfig.identifyModel({ pwr: '1', om: '2', type: 'AC3829' }).key, undefined);
      assert.equal(modelConfig.identifyModel({ pwr: '1' }).key, undefined);
      assert.equal(modelConfig.identifyModel({}).key, undefined);
    });

    it('knows whether a mapping can read a status at all', () => {
      assert.equal(modelConfig.readsStatus(ac0850Status, {}), false);
      assert.equal(modelConfig.readsStatus(ac0850Status, modelConfig({ model: 'AC0850' }).keyMaps), true);
      assert.equal(modelConfig.readsStatus({ pwr: '1', om: '2' }, {}), true);

      assert.equal(modelConfig.looksLikeRegisters(ac0850Status), true);
      assert.equal(modelConfig.looksLikeRegisters({ 'D03-02': 'ON' }), true);
      assert.equal(modelConfig.looksLikeRegisters({ pwr: '1', om: '2' }), false);
    });
  });
});
