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

  it('maps the AC0850 fan level onto four slider steps, and no other model', () => {
    //D0310D is the fan's actual level (issue #46); levels 2 and 3 only occur in Auto
    const { fanLevel, speeds } = modelConfig({ model: 'AC0850' });
    assert.equal(fanLevel.key, 'D0310D');
    assert.deepEqual(
      fanLevel.steps.map((step) => step.level),
      [1, 2, 3, 18]
    );
    assert.deepEqual(
      fanLevel.steps.map((step) => step.write),
      [speeds[0], 'auto', 'auto', speeds[1]]
    );

    for (const model of ['Air Purifier', 'AC1715', 'AC3036', 'AC3829']) {
      assert.equal(modelConfig({ model }).fanLevel, undefined, model);
    }
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

    //the AC0651 shares every register the AC0850 dump above reports, so the
    //two tie on it; the tie goes to the model listed first, the AC0850
    it('keeps an AC0850 dump on the AC0850 now that the AC0651 shares its registers', () => {
      assert.deepEqual(modelConfig.identifyModel(ac0850Status), { key: 'AC0850', certainty: 'fingerprint' });
    });

    //a status built from the registers homebridge-philips-airplus-cloud reads
    //on an AC0651/10 (values illustrative), with the D03102 power register
    //the AC0850 has: the pre-filter pair D0520D/D05207 is what sets it apart
    const ac0651Status = {
      D03102: 1,
      D0310C: 0,
      D0310D: 1,
      D03120: 1,
      D03221: 3,
      D0312C: 4,
      D05408: 4800,
      D0540E: 4100,
      D05207: 720,
      D0520D: 650,
    };

    it('fingerprints an AC0651 by its pre-filter registers, ahead of the AC0850', () => {
      assert.deepEqual(modelConfig.identifyModel(ac0651Status), { key: 'AC0651', certainty: 'fingerprint' });
    });

    it('takes an AC0651 at its word when it names itself', () => {
      assert.deepEqual(modelConfig.identifyModel({ ...selfIdentifying, D01S05: 'AC0651/10' }), {
        key: 'AC0651',
        certainty: 'reported',
      });
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

//Some models ship two register dialects under one model ID, depending on the
//Wi-Fi firmware: dashed registers ('D03-02') with word values, or dash-less
//ones ('D03102') with numbers. An entry can carry both; the plain fields are
//its default dialect, and a status shows which one a device actually speaks.
describe('register dialects', () => {
  //a real AC0850/31, untranslated, captured 2026-08-19 on firmware 0.1.3
  const dashlessStatus = {
    D01102: 5,
    D01S03: 'Bedroom',
    D01S05: 'AC0850/31',
    D01S12: '0.1.3',
    WifiVersion: 'AWS_Philips_AIR_Combo@86',
    D03102: 1,
    D0310A: 2,
    D0310C: 0,
    D03120: 1,
    D03221: 1,
    D0540E: 224,
    D05408: 4800,
  };

  //the dashed vocabulary ruaan-deysel/ha-philips-airpurifier reads from an
  //AC1715 and from AC0850 units on AWS_Philips_AIR firmware
  const dashedStatus = {
    'D01-05': 'AC0850/11',
    WifiVersion: 'AWS_Philips_AIR@62',
    'D03-02': 'ON',
    'D03-12': 'Sleep',
    'D03-32': 2,
    'D03-33': 4,
    'D05-14': 3100,
    'D05-08': 4800,
  };

  it('tells the dialect apart by the shape of the register keys', () => {
    assert.equal(modelConfig.detectDialect(dashlessStatus), 'dashless');
    assert.equal(modelConfig.detectDialect(dashedStatus), 'dashed');
    assert.equal(modelConfig.detectDialect({ 'D03-02': 'ON', 'D03-12': 'Speed 2', 'D03-33': 3 }), 'dashed');
  });

  it('names no dialect for a legacy status, a mixed one, or none at all', () => {
    assert.equal(modelConfig.detectDialect({ pwr: '1', om: '2', mode: 'M' }), undefined);
    assert.equal(modelConfig.detectDialect({ 'D03-02': 'ON', D03102: 1, pwr: '1' }), undefined);
    assert.equal(modelConfig.detectDialect({}), undefined);
  });

  it('keeps each model on its validated dialect until told otherwise', () => {
    assert.equal(modelConfig({ model: 'AC0850' }).dialect, 'dashless');
    assert.equal(modelConfig({ model: 'AC0850' }).keyMaps.pwr, 'D03102');
    assert.equal(modelConfig({ model: 'AC1715' }).dialect, 'dashed');
    assert.equal(modelConfig({ model: 'AC1715' }).keyMaps.pwr, 'D03-02');
    assert.deepEqual(modelConfig({ model: 'AC0850' }).dialects.sort(), ['dashed', 'dashless']);
  });

  it('falls back to the default for a dialect the model has no variant for', () => {
    assert.deepEqual(modelConfig({ model: 'AC0850', dialect: 'gen9' }), modelConfig({ model: 'AC0850' }));
  });

  it('leaves a plain entry exactly as it was, whatever dialect is asked for', () => {
    for (const model of ['AC3036', 'AC3829', 'Air Purifier']) {
      const plain = modelConfig({ model });

      assert.deepEqual(modelConfig({ model, dialect: 'dashed' }), plain);
      assert.deepEqual(modelConfig({ model, dialect: 'dashless' }), plain);
      assert.equal(plain.dialect, undefined);
      assert.deepEqual(plain.dialects, []);
    }
  });

  it('maps the dashed AC0850 to the words ruaan-deysel names, with Auto on the selector', () => {
    const model = modelConfig({ model: 'AC0850', dialect: 'dashed' });

    assert.equal(model.dialect, 'dashed');
    assert.deepEqual(model.speeds, [{ mode: 'Sleep' }, { mode: 'Turbo' }]);
    assert.deepEqual(model.modeMaps, { auto: { mode: 'Auto General' } });
    assert.deepEqual(model.autoWrite, { mode: 'Auto General' });
    assert.equal(model.keyMaps.pwr, 'D03-02');
    assert.equal(model.keyMaps.mode, 'D03-12');
    assert.equal(model.keyMaps.iaql, 'D03-32');
    assert.equal(model.keyMaps.pm25, 'D03-33');
    assert.equal(model.keyMaps.fltsts1, 'D05-14');
    assert.equal(model.keyMaps.flttotal1, 'D05-08');
    assert.equal(model.valueMaps.pwr.ON, 1);
    assert.equal(model.valueMaps.pwr[1], 'ON');
    assert.deepEqual(model.extraSetFlags, []);
    assert.deepEqual(model.unsupported, ['cl']);
  });

  it('maps the dash-less AC1715 to D0310C, with Auto on the selector', () => {
    const model = modelConfig({ model: 'AC1715', dialect: 'dashless' });

    assert.equal(model.dialect, 'dashless');
    assert.deepEqual(model.speeds, [{ D0310C: 17 }, { D0310C: 1 }, { D0310C: 2 }, { D0310C: 18 }]);
    assert.deepEqual(model.modeMaps, { auto: { D0310C: 0 } });
    assert.equal(model.keyMaps.pwr, 'D03102');
    assert.equal(model.keyMaps.iaql, 'D03120');
    assert.equal(model.keyMaps.pm25, 'D03221');
    assert.equal(model.keyMaps.fltsts0, 'D0520D');
    assert.equal(model.keyMaps.flttotal0, 'D05207');
    assert.equal(model.keyMaps.fltsts1, 'D0540E');
    assert.equal(model.keyMaps.flttotal1, 'D05408');
    assert.deepEqual(model.extraSetFlags, ['-I']);
    assert.deepEqual(model.unsupported, ['mode', 'cl']);
  });

  //a variant replaces the plain fields whole, fanLevel included: the dashed
  //AC0850 firmware has no D0310D, so its slider is its own two speeds while
  //the dash-less one keeps the four fan-level steps
  it('gives each variant its own slider, with no fan level it does not declare', () => {
    const dashless = modelConfig({ model: 'AC0850' });
    const dashed = modelConfig({ model: 'AC0850', dialect: 'dashed' });

    assert.equal(dashless.fanLevel?.key, 'D0310D');
    assert.equal(dashless.fanLevel?.steps.length, 4);
    assert.equal(dashed.fanLevel, undefined);
    assert.equal(dashed.speeds.length, 2);
    assert.equal(modelConfig({ model: 'AC1715', dialect: 'dashless' }).fanLevel, undefined);
  });

  //a variant filed under the wrong name would be applied to exactly the
  //devices it cannot read
  it('files every variant under the dialect its registers are written in', () => {
    for (const model of modelConfig.mappedModels) {
      for (const dialect of modelConfig({ model }).dialects) {
        const registers = Object.fromEntries(
          Object.values(modelConfig({ model, dialect }).keyMaps).map((register) => [register, 0])
        );

        assert.equal(modelConfig.detectDialect(registers), dialect, `${model} ${dialect}`);
      }
    }
  });

  it('reads the dashed model field too', () => {
    assert.deepEqual(modelConfig.identifyModel({ 'D01-05': 'AC0850/11', 'D03-02': 'ON' }), {
      key: 'AC0850',
      certainty: 'reported',
    });
  });

  it('reports the model as printed, its regional suffix, and the Wi-Fi firmware', () => {
    assert.deepEqual(modelConfig.deviceDetails(dashlessStatus), {
      model: 'AC0850/31',
      region: '31',
      wifiVersion: 'AWS_Philips_AIR_Combo@86',
    });
    assert.deepEqual(modelConfig.deviceDetails(dashedStatus), {
      model: 'AC0850/11',
      region: '11',
      wifiVersion: 'AWS_Philips_AIR@62',
    });
    assert.deepEqual(modelConfig.deviceDetails({ pwr: '1' }), {
      model: undefined,
      region: undefined,
      wifiVersion: undefined,
    });
  });
});

//from Micheledipaola/homebridge-philips-airplus (see THIRD_PARTY_NOTICES.md)
describe('AC0651', () => {
  const config = modelConfig({ model: 'AC0651/10' });

  it('steps Sleep, Medium, Turbo on D0310C, with Auto on the selector', () => {
    assert.deepEqual(config.speeds, [{ D0310C: 17 }, { D0310C: 1 }, { D0310C: 18 }]);
    assert.deepEqual(config.modeMaps, { auto: { D0310C: 0 } });
  });

  it('powers on D03102 and reads both filters, sent with -I', () => {
    assert.deepEqual(config.keyMaps, {
      pwr: 'D03102',
      iaql: 'D03120',
      pm25: 'D03221',
      fltsts0: 'D0520D',
      flttotal0: 'D05207',
      fltsts1: 'D0540E',
      flttotal1: 'D05408',
    });
    assert.deepEqual(config.extraSetFlags, ['-I']);
  });

  it('offers no mode register, child lock, or light', () => {
    assert.deepEqual(config.unsupported, ['mode', 'cl']);
    assert.equal(config.keyMaps.aqil, undefined);
    assert.equal(config.keyMaps.uil, undefined);
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

  it('maps no humidifier on the dash-less humidifiers, which have no on/off register', () => {
    for (const model of ['AC3420', 'AC3421', 'AC3737']) {
      const config = modelConfig({ model });

      assert.equal(config.keyMaps.rhset, undefined, model);
      assert.ok(config.unsupported.includes('func'), model);
      assert.equal(modelConfig.hasHumidifier(model), false, model);
    }
    for (const model of ['AC0850', 'AC3829', undefined]) {
      assert.equal(modelConfig.hasHumidifier(model), true, String(model));
    }
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
