'use strict';

//Per-model command mappings. 'speeds' entries are matched in order against the
//device state to derive the HomeKit rotation speed; 'keyMaps' translate the
//generic keys to model-specific registers; 'valueMaps' translate values in
//both directions; 'extraSetFlags' are extra CLI flags for set commands;
//'unsupported' lists generic keys the model has no register for at all;
//'modeMaps' is the model's auto/manual concept, the one mechanism behind
//HomeKit's auto/manual selector on every model: its 'auto' entry holds the
//register values that mean Auto, which is never one of the 'speeds'. Manual
//restores the last of the 'speeds' the device was in, unless a 'manual' entry
//names registers of its own. An 'allergen' entry is a plain allergen mode,
//automatic too: it reads as Auto, and the allergicFunc option makes Auto
//send it instead of 'auto'.
//A model that ships two register dialects under one model ID, depending on
//its Wi-Fi firmware, names the one its plain fields are written in as
//'dialect' ('dashed': keys like D03-02 and word values; 'dashless': keys like
//D03102 and numbers), and carries the other as 'dialects', a map from dialect
//name to an ordinary entry that replaces the plain fields whole. The plain
//fields stay the default until a status shows the device speaks another.
//Models not listed here use the default 'om' based speeds and modes.

const DEFAULT_SPEEDS = [{ om: '1' }, { om: '2' }, { om: 't' }];
const DEFAULT_SLEEP_SPEEDS = [{ om: 's' }, ...DEFAULT_SPEEDS];

//the legacy 'mode' register: P is Auto, A the allergen mode, M manual. Manual
//keeps writing M rather than restoring a speed, because the default speeds
//write 'om' alone and nothing confirms that 'om' takes an unknown model out of
//Auto; sending 'mode=M' beside a speed is a write no tested model has had
const DEFAULT_MODE_MAPS = { auto: { mode: 'P' }, allergen: { mode: 'A' }, manual: { mode: 'M' } };

const models = {
  AC3036: {
    //Auto is AG (ruaan-deysel/ha-philips-airpurifier), and P is not an AC303x
    //mode at all. It goes on the selector, leaving four slider steps: 25%
    //Sleep, 50% and 75% the manual speeds, 100% Turbo
    speeds: [{ mode: 'S' }, { mode: 'M', om: 1 }, { mode: 'M', om: 2 }, { mode: 'T' }],
    modeMaps: {
      auto: { mode: 'AG' },
    },
  },
  AC1715: {
    //D03-12 takes the mode as words. Auto goes on the selector, leaving four
    //slider steps: 25% Sleep, 50% and 75% the two speeds, 100% Turbo
    speeds: [{ mode: 'Sleep' }, { mode: 'Gentle/Speed 1' }, { mode: 'Speed 2' }, { mode: 'Turbo' }],
    modeMaps: {
      auto: { mode: 'Auto General' },
    },
    keyMaps: {
      pwr: 'D03-02',
      om: 'D03-13',
      speed: 'D03-13',
      mode: 'D03-12',
      cl: 'D03-03',
      aqil: 'D03-04',
      uil: 'D03-05',
      iaql: 'D03-32',
      pm25: 'D03-33',
      fltt1: 'D05-02',
      fltt2: 'D05-03',
      flttotal0: 'D05-07',
      flttotal1: 'D05-08',
      flttotal2: 'D05-09',
      fltsts0: 'D05-13',
      fltsts1: 'D05-14',
      fltsts2: 'D05-15',
    },
    valueMaps: {
      pwr: {
        OFF: 0,
        ON: 1,
        0: 'OFF',
        1: 'ON',
      },
      //the display register takes 100/0 where the legacy uil takes '1'/'0'
      //(ruaan-deysel/ha-philips-airpurifier). A reading of 100 comes back as 1;
      //the light's HomeKit state is read from aqil, not from this
      uil: {
        1: 100,
        0: 0,
        100: 1,
      },
    },
    dialect: 'dashed',
    dialects: {
      //Unvalidated: no dash-less AC1715 has been tested with this plugin.
      //Speeds and registers from Micheledipaola/homebridge-philips-airplus
      //(MIT, models.yaml, AC1715/70 and AC1715/11): D0310C is mode and speed
      //in one register, 0 Auto, 17 Sleep, 1 Medium, 2 Fast, 18 Turbo. Auto
      //goes on the selector, leaving four slider steps as in the dashed
      //dialect. That data names D0310D as power, but ruaan-deysel's gen3
      //vocabulary (const.py) and a tested AC0850 both write power to D03102,
      //with D0310D only following it. D0310A is not written: neither source
      //sends it for this model
      dashless: {
        speeds: [{ D0310C: 17 }, { D0310C: 1 }, { D0310C: 2 }, { D0310C: 18 }],
        modeMaps: {
          auto: { D0310C: 0 },
        },
        keyMaps: {
          pwr: 'D03102',
          iaql: 'D03120',
          pm25: 'D03221',
          fltsts0: 'D0520D',
          flttotal0: 'D05207',
          fltsts1: 'D0540E',
          flttotal1: 'D05408',
        },
        extraSetFlags: ['-I'],
        //no generic mode register (D0310C carries it) and no child lock in
        //either source, as on the AC0850
        unsupported: ['mode', 'cl'],
      },
    },
  },
  AC3829: {
    //speed ladder from ruaan-deysel/ha-philips-airpurifier (device_models.py):
    //sleep is its own mode, and the manual speeds are om 1, 2, 3 and turbo.
    //Its auto, allergen and manual modes match the generic P, A and M
    speeds: [
      { mode: 'S', om: 's' },
      { mode: 'M', om: '1' },
      { mode: 'M', om: '2' },
      { mode: 'M', om: '3' },
      { mode: 'M', om: 't' },
    ],
    //Auto is a mode, not one of the speeds above, so it goes on the selector:
    //in Auto the slider keeps the last manual step rather than reading 0%,
    //and Sleep reads as manual. Its allergen mode A is automatic too, so the
    //allergic option makes Auto send it
    modeMaps: {
      auto: { mode: 'P' },
      allergen: { mode: 'A' },
    },
  },
  AC0850: {
    //D0310C is mode and speed in one register: 0 = Auto, 17 = Sleep,
    //18 = Turbo, always written with D0310A = 2. Auto goes on HomeKit's
    //auto/manual selector through modeMaps rather than on the slider, which
    //keeps two steps: 50% Sleep, 100% Turbo (0% is off)
    speeds: [
      { D0310A: 2, D0310C: 17 },
      { D0310A: 2, D0310C: 18 },
    ],
    modeMaps: {
      auto: { D0310A: 2, D0310C: 0 },
    },
    keyMaps: {
      pwr: 'D03102',
      iaql: 'D03120',
      pm25: 'D03221',
      fltsts1: 'D0540E',
      flttotal1: 'D05408',
    },
    extraSetFlags: ['-I'],
    //this model reports no register for either: not in its status dumps, and
    //not among the registers mapped above when it was tested. So the plugin
    //never sends 'mode=...' / 'cl=...' and offers no child lock. Auto/manual
    //is still offered, through modeMaps, because Auto lives in D0310C.
    //Issue #46 carries the hardware experiment that can overturn this.
    unsupported: ['mode', 'cl'],
    dialect: 'dashless',
    dialects: {
      //Unvalidated: no dashed AC0850 has been tested with this plugin.
      //From ruaan-deysel/ha-philips-airpurifier (Apache-2.0, device_models.py
      //and const.py), whose gen2 AC0850 config covers units on
      //AWS_Philips_AIR firmware: power on D03-02 as ON/OFF, mode and speed as
      //words on D03-12 ('Auto General', 'Sleep', 'Turbo'), allergen index
      //D03-32, PM2.5 D03-33, and one filter, D05-14 out of D05-08 (it lists
      //the D05-13 pre-filter as unavailable). Auto goes on the selector,
      //leaving the same two slider steps as the dash-less dialect
      dashed: {
        speeds: [{ mode: 'Sleep' }, { mode: 'Turbo' }],
        modeMaps: {
          auto: { mode: 'Auto General' },
        },
        keyMaps: {
          pwr: 'D03-02',
          mode: 'D03-12',
          iaql: 'D03-32',
          pm25: 'D03-33',
          fltsts1: 'D05-14',
          flttotal1: 'D05-08',
        },
        valueMaps: {
          pwr: {
            OFF: 0,
            ON: 1,
            0: 'OFF',
            1: 'ON',
          },
        },
        //ruaan-deysel exposes no child lock for this family, and the
        //dash-less unit reports none either
        unsupported: ['cl'],
      },
    },
  },
};

//Philips prints the model on the device as 'AC0850/11'; the suffix after the
//slash is a regional variant and is never part of the mapping key. Users type
//what they can see, so case, spacing and that suffix all have to survive the
//trip from the label to the config field.
const normaliseModel = (value) =>
  String(value === undefined || value === null ? '' : value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\/.*$/, '');

//A model ID embedded in free text, e.g. a device named 'AC0850 bedroom'. Only
//an exact match against a mapped model counts: a near miss is a guess, and a
//guess here silently drives the device with the wrong registers.
const MODEL_IN_TEXT = /[A-Z]{2,3}\s?\d{3,4}(?:\/\d+)?/gi;

const modelInText = (text) => {
  const matches = String(text === undefined || text === null ? '' : text).match(MODEL_IN_TEXT) || [];

  return matches.map(normaliseModel).find((candidate) => models[candidate]);
};

/**
 * Which mapping drives a device, and what that answer was derived from.
 *
 * `source` is 'model' when the model field named it, 'name' when only the
 * device name did (the commonest configuration mistake: the ID typed into the
 * Home app label with the model field left alone), and undefined when nothing
 * matched, which means the default mapping. `nameSuggests` is set when the name
 * points at a different mapped model than the model field does, i.e. one of the
 * two was edited and the other was not.
 *
 * @param {{ model?: unknown, name?: unknown }} [deviceConfig]
 */
const resolveModel = (deviceConfig = {}) => {
  const configured = normaliseModel(deviceConfig.model);
  const fromName = modelInText(deviceConfig.name);

  if (models[configured]) {
    return { key: configured, source: 'model', nameSuggests: fromName === configured ? undefined : fromName };
  }

  if (fromName) {
    return { key: fromName, source: 'name', nameSuggests: undefined };
  }

  return { key: undefined, source: undefined, nameSuggests: undefined };
};

//an unmapped model gets the default modes; a mapped one only what it declares
const modeMapsFor = (key) => (key && models[key] ? models[key].modeMaps : DEFAULT_MODE_MAPS);

//the entry a model uses in a dialect: one of its variants, or its plain
//fields for its own dialect and for any it has no variant for
const variantFor = (model, dialect) =>
  (dialect && dialect !== model.dialect && model.dialects && model.dialects[dialect]) || model;

const modelConfig = (deviceConfig) => {
  //modelKey is stamped on by accessories.setup.js, which resolves once and logs
  //what it found; resolving again covers a config object built directly
  const key = deviceConfig.modelKey || resolveModel(deviceConfig).key;
  const base = models[key] || {};
  const model = variantFor(base, deviceConfig.dialect);
  const modeMaps = key && models[key] ? model.modeMaps : DEFAULT_MODE_MAPS;

  return {
    speeds: model.speeds || (deviceConfig.sleepSpeed ? DEFAULT_SLEEP_SPEEDS : DEFAULT_SPEEDS),
    keyMaps: model.keyMaps || {},
    valueMaps: model.valueMaps || {},
    extraSetFlags: model.extraSetFlags || [],
    unsupported: model.unsupported || [],
    modeMaps,
    //what Auto on the selector sends. The allergic option picks the allergen
    //mode, on a model that has one (elsewhere accessories.setup.js warns that
    //it is ignored); modeMaps stays whole, so either automatic mode still
    //reads as Auto whichever one the Philips app or the panel started
    autoWrite: modeMaps && (deviceConfig.allergicFunc && modeMaps.allergen ? modeMaps.allergen : modeMaps.auto),
    //the dialect in force, and every one the model has a mapping for; both
    //empty for a model that ships only one
    dialect: model === base ? base.dialect : deviceConfig.dialect,
    dialects: base.dialect ? [base.dialect, ...Object.keys(base.dialects || {})] : [],
  };
};

//The generic vocabulary handleResponse translates every dialect into. A status
//carrying none of these and none of the configured model's own registers is a
//status the mapping in force cannot read at all.
const GENERIC_KEYS = new Set([
  'pwr',
  'om',
  'mode',
  'cl',
  'aqil',
  'uil',
  'func',
  'rhset',
  'wl',
  'iaql',
  'pm25',
  'rh',
  'temp',
  'wicksts',
  'fltsts0',
  'fltsts1',
  'fltsts2',
  'flttotal0',
  'flttotal1',
  'flttotal2',
]);

//both register dialects: 'D03-02' (AC1715 style) and 'D03102' (AC0850 style)
const REGISTER_KEY = /^D\d{2}-?\d{2,3}$/;

//each dialect on its own. Dash-less registers end in hex ('D0310C', 'D0540E');
//the D01S0x name and model fields are not registers and count for neither
const DIALECT_KEYS = {
  dashed: /^D\d{2}-\d{2,3}$/,
  dashless: /^D\d{2}[0-9A-F]{3}$/,
};

//Status fields that carry the model itself. `D01S05` is observed: a full
//AC0850/31 dump reports `"D01S05":"AC0850/31"` alongside `D01S03` and `D01S04`,
//which hold user-settable names. `type` and `modelid` are the legacy-dialect
//candidates and remain unconfirmed; a field a device does not send is inert.
//
//This is an allowlist rather than a scan of every string value, and that is the
//point: `D01S03` is whatever the owner typed into the Philips app, so a device
//named 'AC1715' by its owner would otherwise be identified as one.
//`D01-05` is the dashed dialect's model field, as ruaan-deysel's
//ha-philips-airpurifier names it (const.py, NEW_MODEL_ID).
const MODEL_FIELDS = ['D01S05', 'D01-05', 'type', 'modelid'];

/**
 * Which model a device's own status says it is.
 *
 * Two signals, strongest first. A device that names itself settles the
 * question. Otherwise the registers are the fingerprint, which is what a model
 * reporting none of MODEL_FIELDS leaves to go on.
 *
 * @param {Record<string, unknown>} status
 * @returns {{ key: string | undefined, certainty: 'reported' | 'fingerprint' | undefined }}
 */
const identifyModel = (status) => {
  const entries = Object.entries(status || {});

  for (const field of MODEL_FIELDS) {
    const candidate = normaliseModel((status || {})[field]);

    if (models[candidate]) {
      return { key: candidate, certainty: 'reported' };
    }
  }

  const keys = entries.map(([key]) => key);
  let best;
  let bestScore = 0;

  for (const [key, model] of Object.entries(models)) {
    const score = Object.values(model.keyMaps || {}).filter((register) => keys.includes(register)).length;

    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }

  return { key: best, certainty: best ? 'fingerprint' : undefined };
};

/**
 * Whether a mapping can read anything at all out of a status: at least one key
 * is either one of that model's registers or already a generic key.
 *
 * @param {Record<string, unknown>} status
 * @param {Record<string, string>} keyMaps
 */
const readsStatus = (status, keyMaps) => {
  const mapped = new Set(Object.values(keyMaps || {}));

  return Object.keys(status || {}).some((key) => mapped.has(key) || GENERIC_KEYS.has(key));
};

const looksLikeRegisters = (status) => Object.keys(status || {}).some((key) => REGISTER_KEY.test(key));

/**
 * Which register dialect a status is written in: the one its register keys
 * all share. A status with no register keys, or with keys of both shapes,
 * names none, since neither is evidence against the mapping in force.
 *
 * @param {Record<string, unknown>} status
 * @returns {'dashed' | 'dashless' | undefined}
 */
const detectDialect = (status) => {
  const keys = Object.keys(status || {});
  const found = /** @type {('dashed' | 'dashless')[]} */ (Object.keys(DIALECT_KEYS)).filter((dialect) =>
    keys.some((key) => DIALECT_KEYS[dialect].test(key))
  );

  return found.length === 1 ? found[0] : undefined;
};

/**
 * What a device says about itself, for diagnostics only: the model as printed
 * on it, the regional suffix after the slash, and its Wi-Fi firmware. None of
 * it decides an accessory's identity or what the config means.
 *
 * @param {Record<string, unknown>} status
 */
const deviceDetails = (status) => {
  const field = MODEL_FIELDS.find((name) => typeof (status || {})[name] === 'string');
  const model = field ? String(status[field]).trim() : undefined;
  const suffix = model && model.match(/\/(.+)$/);
  const wifi = (status || {}).WifiVersion;

  return {
    model,
    region: suffix ? suffix[1] : undefined,
    wifiVersion: typeof wifi === 'string' ? wifi : undefined,
  };
};

//Every model listed here must also appear in the config.schema.json model
//typeahead suggestions (enforced by test/config.schema.test.js).
modelConfig.mappedModels = Object.keys(models);
modelConfig.normaliseModel = normaliseModel;
modelConfig.resolveModel = resolveModel;

//whether a model brings its own speed table, i.e. whether the sleepSpeed
//option can do anything for it
modelConfig.hasOwnSpeeds = (key) => Boolean(key && models[key] && models[key].speeds);

//whether a model has a plain allergen mode, i.e. whether the allergicFunc
//option can do anything for it
modelConfig.hasAllergenMode = (key) => Boolean((modeMapsFor(key) || {}).allergen);

//every field a model entry uses, for the drift guard in test/docs.test.js
modelConfig.modelFields = [
  ...new Set(
    Object.values(models).flatMap((model) =>
      [model, ...Object.values(model.dialects || {})].flatMap((entry) => Object.keys(entry))
    )
  ),
];

modelConfig.identifyModel = identifyModel;
modelConfig.readsStatus = readsStatus;
modelConfig.looksLikeRegisters = looksLikeRegisters;
modelConfig.detectDialect = detectDialect;
modelConfig.deviceDetails = deviceDetails;

module.exports = modelConfig;
