'use strict';

//Per-model command mappings. 'speeds' entries are matched in order against the
//device state to derive the HomeKit rotation speed; 'keyMaps' translate the
//generic keys to model-specific registers; 'valueMaps' translate values in
//both directions; 'extraSetFlags' are extra CLI flags for set commands;
//'unsupported' lists generic keys the model has no register for at all.
//Models not listed here use the default 'om' based speeds.

const DEFAULT_SPEEDS = [{ om: '1' }, { om: '2' }, { om: 't' }];
const DEFAULT_SLEEP_SPEEDS = [{ om: 's' }, ...DEFAULT_SPEEDS];

const models = {
  AC3036: {
    speeds: [{ mode: 'S' }, { mode: 'AG' }, { mode: 'M', om: 1 }, { mode: 'M', om: 2 }, { mode: 'T' }],
  },
  AC1715: {
    speeds: [
      { mode: 'Sleep' },
      { mode: 'Auto General' },
      { mode: 'Gentle/Speed 1' },
      { mode: 'Speed 2' },
      { mode: 'Turbo' },
    ],
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
    },
  },
  AC0850: {
    speeds: [
      { D0310A: 2, D0310C: 17 },
      { D0310A: 2, D0310C: 0 },
      { D0310A: 2, D0310C: 18 },
    ],
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
    //neither sends 'mode=...' / 'cl=...' nor offers the HomeKit controls that
    //would. The composite speeds may already be how this model expresses mode.
    //Issue #46 carries the hardware experiment that can overturn this.
    unsupported: ['mode', 'cl'],
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

const modelConfig = (deviceConfig) => {
  //modelKey is stamped on by accessories.setup.js, which resolves once and logs
  //what it found; resolving again covers a config object built directly
  const model = models[deviceConfig.modelKey || resolveModel(deviceConfig).key] || {};

  return {
    speeds: model.speeds || (deviceConfig.sleepSpeed ? DEFAULT_SLEEP_SPEEDS : DEFAULT_SPEEDS),
    keyMaps: model.keyMaps || {},
    valueMaps: model.valueMaps || {},
    extraSetFlags: model.extraSetFlags || [],
    unsupported: model.unsupported || [],
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

/**
 * Which model a device's own status says it is.
 *
 * Two signals, strongest first. A device that names itself settles the
 * question, and no field name is assumed for that: no dump from a
 * self-identifying model is recorded in this repo, so any string value that is
 * exactly a model this plugin maps counts, wherever it sits. Otherwise the
 * registers are the fingerprint, which is the only signal the AC0850 and AC1715
 * offer at all: their status dumps carry no name, type or model field of any
 * kind, only D-registers.
 *
 * @param {Record<string, unknown>} status
 * @returns {{ key: string | undefined, certainty: 'reported' | 'fingerprint' | undefined }}
 */
const identifyModel = (status) => {
  const entries = Object.entries(status || {});

  for (const [, value] of entries) {
    if (typeof value === 'string') {
      const candidate = normaliseModel(value);

      if (models[candidate]) {
        return { key: candidate, certainty: 'reported' };
      }
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

//Every model listed here must also appear in the config.schema.json model
//typeahead suggestions (enforced by test/config.schema.test.js).
modelConfig.mappedModels = Object.keys(models);
modelConfig.normaliseModel = normaliseModel;
modelConfig.resolveModel = resolveModel;

//whether a model brings its own speed table, i.e. whether the sleepSpeed
//option can do anything for it
modelConfig.hasOwnSpeeds = (key) => Boolean(key && models[key] && models[key].speeds);

modelConfig.identifyModel = identifyModel;
modelConfig.readsStatus = readsStatus;
modelConfig.looksLikeRegisters = looksLikeRegisters;

module.exports = modelConfig;
