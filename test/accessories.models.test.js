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

  it('uses mode-based speeds for AC3036, with Auto on the selector', () => {
    const model = modelConfig({ model: 'AC3036' });

    assert.deepEqual(model.speeds, [{ mode: 'S' }, { mode: 'M', om: 1 }, { mode: 'M', om: 2 }, { mode: 'T' }]);
    assert.deepEqual(model.modeMaps, { auto: { mode: 'AG' } });
  });

  it('maps keys and power values for AC1715, with Auto on the selector', () => {
    const model = modelConfig({ model: 'AC1715' });

    assert.deepEqual(model.speeds, [
      { mode: 'Sleep' },
      { mode: 'Gentle/Speed 1' },
      { mode: 'Speed 2' },
      { mode: 'Turbo' },
    ]);
    assert.deepEqual(model.modeMaps, { auto: { mode: 'Auto General' } });
    assert.equal(model.keyMaps.pwr, 'D03-02');
    assert.equal(model.valueMaps.pwr.ON, 1);
    assert.equal(model.valueMaps.pwr[0], 'OFF');
  });

  it('uses D-register speeds and the -I set flag for AC0850', () => {
    const model = modelConfig({ model: 'AC0850' });

    assert.deepEqual(model.speeds[1], { D0310A: 2, D0310C: 18 });
    assert.equal(model.keyMaps.pwr, 'D03102');
    assert.deepEqual(model.extraSetFlags, ['-I']);
  });

  it('puts AC0850 Auto on the speed registers', () => {
    assert.deepEqual(modelConfig({ model: 'AC0850' }).modeMaps, { auto: { D0310A: 2, D0310C: 0 } });
  });

  it('gives the default map Auto P, Manual M and the allergen mode A', () => {
    assert.deepEqual(modelConfig({}).modeMaps, { auto: { mode: 'P' }, allergen: { mode: 'A' }, manual: { mode: 'M' } });
  });

  it('makes Auto send A on the default map when the allergic option is on', () => {
    assert.deepEqual(modelConfig({ allergicFunc: true }).autoWrite, { mode: 'A' });
    assert.deepEqual(modelConfig({}).autoWrite, { mode: 'P' });
  });

  it('leaves modeMaps whole under the allergic option, so P still reads as Auto', () => {
    assert.deepEqual(modelConfig({ allergicFunc: true }).modeMaps, modelConfig({}).modeMaps);
  });

  it('ignores the allergic option on a model with no plain allergen mode', () => {
    for (const model of ['AC0850', 'AC1715', 'AC3036']) {
      assert.deepEqual(modelConfig({ model, allergicFunc: true }).modeMaps, modelConfig({ model }).modeMaps, model);
      assert.deepEqual(
        modelConfig({ model, allergicFunc: true }).autoWrite,
        modelConfig({ model }).modeMaps.auto,
        model
      );
      assert.equal(modelConfig.hasAllergenMode(model), false, model);
    }
    assert.equal(modelConfig.hasAllergenMode(undefined), true);
  });

  //one mechanism for every model: Auto is on the selector, never a slider step
  it('gives every mapped model an Auto that is not one of its speeds', () => {
    for (const model of [undefined, ...modelConfig.mappedModels]) {
      const { speeds, modeMaps } = modelConfig({ model });
      const auto = Object.entries(modeMaps.auto);

      assert.ok(auto.length > 0, `${model} declares no Auto`);
      for (const speed of speeds) {
        assert.ok(
          !auto.every(([key, value]) => String(speed[key]) === String(value)),
          `${model} has Auto as a speed: ${JSON.stringify(speed)}`
        );
      }
    }
  });

  it('uses a sleep position and four manual om speeds for AC3829', () => {
    const model = modelConfig({ model: 'AC3829' });

    assert.deepEqual(model.speeds, [
      { mode: 'S', om: 's' },
      { mode: 'M', om: '1' },
      { mode: 'M', om: '2' },
      { mode: 'M', om: '3' },
      { mode: 'M', om: 't' },
    ]);
    assert.deepEqual(model.keyMaps, {});
    assert.deepEqual(model.valueMaps, {});
  });

  it('ignores sleepSpeed for models with explicit speeds', () => {
    const model = modelConfig({ model: 'AC0850', sleepSpeed: true });
    assert.equal(model.speeds.length, 2);

    //the AC3829 table already has its sleep position, so the option adds none
    assert.equal(modelConfig({ model: 'AC3829', sleepSpeed: true }).speeds.length, 5);
    assert.equal(modelConfig.hasOwnSpeeds('AC3829'), true);
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
      assert.equal(modelConfig.resolveModel({ model: 'AC0820' }).key, undefined);
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

    //a real AC0850/31, untranslated, captured 2026-08-19 on firmware 0.1.3
    const selfIdentifying = {
      D01102: 5,
      D01S03: 'Bedroom',
      D01S04: 'Pluto',
      D01S05: 'AC0850/31',
      D01S12: '0.1.3',
      WifiVersion: 'AWS_Philips_AIR_Combo@86',
      StatusType: 'status',
      D03102: 1,
      D0310A: 2,
      D0310C: 0,
      D03120: 1,
      D03221: 1,
      D0540E: 224,
      D05408: 4800,
    };

    it('takes a device at its word when it names itself', () => {
      assert.deepEqual(modelConfig.identifyModel(selfIdentifying), { key: 'AC0850', certainty: 'reported' });
      assert.equal(modelConfig.identifyModel({ pwr: '1', om: '2', modelid: 'AC1715/10' }).key, 'AC1715');
      assert.equal(modelConfig.identifyModel({ pwr: '1', om: '2', type: 'AC3829' }).key, 'AC3829');
    });

    //D01S03 and D01S04 are whatever the owner typed into the Philips app, and
    //they sit in the same status as the model. Reading a model out of them
    //would identify a device by the name its owner happened to give it
    it('reads the model only from a field that carries a model', () => {
      assert.equal(modelConfig.identifyModel({ ...selfIdentifying, D01S03: 'AC1715' }).key, 'AC0850');
      assert.equal(modelConfig.identifyModel({ D01S03: 'AC1715', Runtime: 1, rssi: -42 }).key, undefined);
    });

    it('identifies nothing from a status that names no model this plugin maps', () => {
      assert.equal(modelConfig.identifyModel({ pwr: '1', om: '2', type: 'AC0820' }).key, undefined);
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

//The models imported from ruaan-deysel/ha-philips-airpurifier (see
//THIRD_PARTY_NOTICES.md), by wire dialect. Each spot check below pins one
//encoding a family depends on, so a slip in the shared data shows up here
describe('imported models', () => {
  const imported = {
    legacy: [
      'AC1214',
      'AC2729',
      'AC2889',
      'AC2936',
      'AC2939',
      'AC2958',
      'AC2959',
      'AC3033',
      'AC3039',
      'AC3055',
      'AC3059',
      'AC3259',
      'AC3836',
      'AC3854',
      'AC3858',
      'AC4236',
      'AC4550',
      'AC4558',
      'AC5659',
      'AC5660',
    ],
    dashed: ['AC0650'],
    dashless: [
      'AC0950',
      'AC0951',
      'AC2210',
      'AC2220',
      'AC2221',
      'AC3210',
      'AC3220',
      'AC3221',
      'AC3420',
      'AC3421',
      'AC3737',
      'AC4220',
      'AC4221',
      'AMF765',
    ],
  };

  it('maps every imported model', () => {
    for (const model of Object.values(imported).flat()) {
      assert.ok(modelConfig.mappedModels.includes(model), `${model} has no mapping`);
    }
  });

  it('leaves out the devices that are not purifiers', () => {
    for (const model of ['AMF870', 'CX3120', 'CX3550', 'CX5120', 'CX7550', 'HU1509', 'HU1510', 'HU4209', 'HU5710']) {
      assert.equal(modelConfig.mappedModels.includes(model), false, model);
    }
  });

  it('keeps the legacy models on the generic keys', () => {
    for (const model of imported.legacy) {
      const config = modelConfig({ model });

      assert.deepEqual(config.keyMaps, {}, model);
      assert.deepEqual(config.extraSetFlags, [], model);
    }
  });

  it('puts every dash-less model on its registers, sent with -I', () => {
    for (const model of imported.dashless) {
      const config = modelConfig({ model });

      assert.equal(config.keyMaps.pwr, 'D03102', model);
      assert.equal(config.keyMaps.cl, 'D03103', model);
      assert.deepEqual(config.extraSetFlags, ['-I'], model);
      assert.deepEqual(config.modeMaps.auto, model === 'AC3737' ? { D0310A: 2, D0310C: 0 } : { D0310C: 0 }, model);
    }
  });

  it('sends the dash-less child lock as 1/0 and reads it back as a boolean', () => {
    const { valueMaps } = modelConfig({ model: 'AC2221' });

    assert.equal(valueMaps.cl.true, 1);
    assert.equal(valueMaps.cl.false, 0);
    assert.equal(valueMaps.cl[1], true);
    assert.equal(valueMaps.cl[0], false);
  });

  it('gives the AC0650 the dashed power words and mode words', () => {
    const config = modelConfig({ model: 'AC0650' });

    assert.equal(config.keyMaps.pwr, 'D03-02');
    assert.equal(config.keyMaps.mode, 'D03-12');
    assert.equal(config.valueMaps.pwr[1], 'ON');
    assert.deepEqual(config.speeds, [{ mode: 'Sleep' }, { mode: 'Turbo' }]);
    assert.deepEqual(config.modeMaps, { auto: { mode: 'Auto General' } });
  });

  //homebridge-philips-airctrl, on an AC4220/12: D0310C 5 is already Turbo
  it('stops the AC4220 ladder at speed 5, after Sleep', () => {
    assert.deepEqual(
      modelConfig({ model: 'AC4220' }).speeds.map((speed) => speed.D0310C),
      [17, 1, 2, 3, 4, 5]
    );
    assert.deepEqual(
      modelConfig({ model: 'AC3210' }).speeds.map((speed) => speed.D0310C),
      [17, 1, 2, 3, 4, 5, 18]
    );
  });

  it('writes the AC3737 speeds as register pairs', () => {
    assert.deepEqual(modelConfig({ model: 'AC3737' }).speeds, [
      { D0310A: 2, D0310C: 17 },
      { D0310A: 2, D0310C: 1 },
      { D0310A: 2, D0310C: 2 },
      { D0310A: 3, D0310C: 18 },
    ]);
  });

  it('reads the AC4558 automatic modes from mode and om together', () => {
    const config = modelConfig({ model: 'AC4558' });

    assert.deepEqual(config.modeMaps, { auto: { mode: 'AG', om: 'a' }, allergen: { mode: 'A', om: 'a' } });
    assert.deepEqual(config.speeds, [{ om: 's' }, { om: '1' }, { om: '2' }, { om: 't' }]);
  });

  it('gives the plain allergen mode to the models that have one', () => {
    for (const model of ['AC1214', 'AC2729', 'AC2889', 'AC3259', 'AC4550', 'AC4558', 'AC5659', 'AC5660']) {
      assert.equal(modelConfig.hasAllergenMode(model), true, model);
    }
    for (const model of ['AC2936', 'AC3033', 'AC3854', 'AC4236', 'AC0650', 'AC0950', 'AC4220', 'AMF765']) {
      assert.equal(modelConfig.hasAllergenMode(model), false, model);
    }
  });

  it('collapses the regional variants of the AC385x to one mapping', () => {
    for (const typed of ['AC3854/50', 'AC3854/51', 'AC3858/83']) {
      assert.equal(modelConfig.resolveModel({ model: typed }).key, typed.slice(0, 6));
    }
  });
});
