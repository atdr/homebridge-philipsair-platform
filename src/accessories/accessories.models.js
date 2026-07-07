'use strict';

//Per-model command mappings. 'speeds' entries are matched in order against the
//device state to derive the HomeKit rotation speed; 'keyMaps' translate the
//generic keys to model-specific registers; 'valueMaps' translate values in
//both directions; 'extraSetFlags' are extra CLI flags for set commands.
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
  },
};

module.exports = (deviceConfig) => {
  const model = models[deviceConfig.model] || {};

  return {
    speeds: model.speeds || (deviceConfig.sleepSpeed ? DEFAULT_SLEEP_SPEEDS : DEFAULT_SPEEDS),
    keyMaps: model.keyMaps || {},
    valueMaps: model.valueMaps || {},
    extraSetFlags: model.extraSetFlags || [],
  };
};
