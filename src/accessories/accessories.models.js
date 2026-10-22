'use strict';

//Most entries here are data from ruaan-deysel's Apache-2.0 projects, modified:
//see THIRD_PARTY_NOTICES.md and the comment above the imported entries.

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
//send it instead of 'auto'. 'alsoAuto' lists further automatic states the
//device can be put in from its panel or the Philips app (a pollution or gas
//preset, say): read-only, they read as Auto but are never written, so they
//change neither what Auto sends nor what the selector offers.
//'fanLevel' is optional, for a model that reports the fan's actual level in a
//register of its own: 'key' names that register, and 'steps' are the slider's
//steps, slowest first, each a 'level' it reads and a 'write' it sends, either
//one of the 'speeds' (a manual step) or the word 'auto' (Auto, as the selector
//sends it). The slider then shows the level in every mode, and a write rounds
//to the nearest step rather than up.
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

//the AC0850's two manual steps, shared by its speeds and its fan level steps
const AC0850_SLEEP = Object.freeze({ D0310A: 2, D0310C: 17 });
const AC0850_TURBO = Object.freeze({ D0310A: 2, D0310C: 18 });

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
      //(MIT, models.yaml, AC1715/70 and AC1715/11; see THIRD_PARTY_NOTICES.md):
      //D0310C is mode and speed in one register, 0 Auto, 17 Sleep, 1 Medium,
      //2 Fast, 18 Turbo. Auto goes on the selector, leaving four slider steps
      //as in the dashed dialect. That data names D0310D as power, but
      //ruaan-deysel's gen3 vocabulary (const.py) and a tested AC0850 both
      //write power to D03102, with D0310D only following it (issue #46).
      //D0310A is not written: neither source sends it for this model. The
      //fan level, device information and filter reset properties have no
      //HomeKit surface here and are left out
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
    //auto/manual selector through modeMaps, and Manual restores Sleep or Turbo
    speeds: [AC0850_SLEEP, AC0850_TURBO],
    modeMaps: {
      auto: { D0310A: 2, D0310C: 0 },
    },
    //D0310D is the fan's actual level (issue #46): 0 off, 1 in Sleep, 18 in
    //Turbo, and in Auto 1, 2, 3 or 18 as the allergen index climbs. Levels 2
    //and 3 only occur in Auto, so writing them selects Auto. The slider is
    //25% Sleep, 50% and 75% Auto, 100% Turbo (0% is off), and rounding to the
    //nearest step keeps 1.3.1's 33/67/100% scenes on Sleep, Auto and Turbo
    fanLevel: {
      key: 'D0310D',
      steps: [
        { level: 1, write: AC0850_SLEEP },
        { level: 2, write: 'auto' },
        { level: 3, write: 'auto' },
        { level: 18, write: AC0850_TURBO },
      ],
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
  //From Micheledipaola/homebridge-philips-airplus (custom_components/
  //philips_airplus/models.yaml, MIT; see THIRD_PARTY_NOTICES.md). That data was
  //read from an AC0651/10 over the Philips cloud (MQTT), not over the local
  //CoAP link this plugin uses, and this project has not validated it.
  //
  //D0310C is mode and speed in one register, as on the AC0850: 0 = Auto,
  //1 = Medium, 17 = Sleep, 18 = Turbo, so the slider steps Sleep, Medium,
  //Turbo. Power is D03102, the dash-less power register (ruaan-deysel's
  //NEW2_POWER), not the D0310D the cloud plugin names: on the AC0850, D03102
  //is power and D0310D the fan's actual level. No source names a mode
  //register or a child lock, and the cloud plugin pins no light register for
  //this model.
  //
  //Listed ahead of the imported dash-less models on purpose: identifyModel
  //gives a tie to the first entry, and an AC0651 status scores the same on
  //their wider register set as on this one
  AC0651: {
    speeds: [{ D0310C: 17 }, { D0310C: 1 }, { D0310C: 18 }],
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
    unsupported: ['mode', 'cl'],
  },
};

//The entries below are imported from ruaan-deysel/ha-philips-airpurifier
//(custom_components/philips_airpurifier/device_models.py and const.py,
//Apache-2.0), cross-checked against ruaan-deysel/homebridge-philips-airctrl
//(src/device/models.ts and keys.ts), and modified to fit this plugin: see
//THIRD_PARTY_NOTICES.md. None is validated on hardware by this project.
//
//What changed on the way in: the power write each preset carries there is
//dropped, since power has its own HomeKit control here; Auto and the plain
//allergen mode go on modeMaps; Sleep and Turbo join the speeds as manual
//steps, slowest first; the other automatic presets (bacteria, gas,
//pollution) read as Auto through alsoAuto but are never written; the presets
//with no HomeKit surface (allergy sleep, medium off the ladder) are left out;
//and so is
//everything with no HomeKit surface here (beep, timers, preferred index,
//oscillation, Auto+ AI). A regional variant (/10, /50) shares its base ID.

//the legacy ladder of mode M with om 1, 2, 3 and t, after a slower first step
const manualOmSpeeds = (slowest) => [
  slowest,
  { mode: 'M', om: '1' },
  { mode: 'M', om: '2' },
  { mode: 'M', om: '3' },
  { mode: 'M', om: 't' },
];

//the AC303x ladder: sleep and turbo are modes of their own, written with om
const AC303X_SPEEDS = [
  { mode: 'S', om: 's' },
  { mode: 'M', om: '1' },
  { mode: 'M', om: '2' },
  { mode: 'T', om: 't' },
];

//Auto P with the allergen mode A, as on the default map
const P_AND_A_MODES = { auto: { mode: 'P' }, allergen: { mode: 'A' } };

//the bacteria preset B, automatic like P and A but with no place on the
//selector, which offers one Auto
const BACTERIA_AUTO = [{ mode: 'B' }];

//the AC4550/AC4558 pollution P and gas F presets, automatic like AG and A
const AC4558_ALSO_AUTO = [
  { mode: 'P', om: 'a' },
  { mode: 'F', om: 'a' },
];
const AG_MODES = { auto: { mode: 'AG' } };

//The dash-less dialect's registers (const.py NEW2_*). Temperature is left out:
//D03224 reports tenths of a degree, and a value map cannot scale a reading
const DASHLESS_KEYS = {
  pwr: 'D03102',
  cl: 'D03103',
  iaql: 'D03120',
  pm25: 'D03221',
  rh: 'D03125',
  fltsts0: 'D0520D',
  flttotal0: 'D05207',
  fltsts1: 'D0540E',
  flttotal1: 'D05408',
};

//D03103 takes 1/0 where the legacy cl takes a boolean
const DASHLESS_VALUES = {
  cl: { true: 1, false: 0, 1: true, 0: false },
};

//D0310C is mode and speed in one register here, as on the AC0850
const DASHLESS_AUTO = { auto: { D0310C: 0 } };

const dashless = (entry) => ({
  ...entry,
  keyMaps: { ...DASHLESS_KEYS, ...entry.keyMaps },
  valueMaps: { ...DASHLESS_VALUES, ...entry.valueMaps },
  extraSetFlags: ['-I'],
});

//The light on these is the lamp mode register D03135 (0 off, 1 on, 2 dim), not
//the D03105 backlight ruaan-deysel/ha-philips-airpurifier names:
//homebridge-philips-airctrl found D03105 read-only on an AC4220/12, writes
//acknowledged and discarded. Both light writes land on D03135, so the light is
//on or off: any brightness switches it on
const LAMP_LIGHT = {
  keyMaps: { aqil: 'D03135', uil: 'D03135' },
  valueMaps: {
    aqil: { 0: 0, 25: 1, 50: 1, 75: 1, 100: 1, 1: 100, 2: 100 },
    uil: { 1: 1, 0: 0 },
  },
};

//The dash-less humidifiers have a humidity target register (D03128, 40 to 70
//in steps of 10 like the legacy rhset) but no on/off this plugin can write or
//read: the legacy func P/PH has no dash-less counterpart. The humidifier
//service reads and writes func, so on these it could only publish Active 0 and
//a threshold of 0, and send a func=PH the device does not have. It is not
//offered (the humidifier option warns that it does nothing) until a
//target-only humidifier can be built and checked on hardware
const DASHLESS_HUMIDIFIER = { unsupported: ['func'] };

//ruaan-deysel/ha-philips-airpurifier's AC32xx ladder: speeds 1 to 5, with its
//Sleep and Turbo presets as the outer steps. Its medium preset (19) is left
//out, having no place on the ladder
const AC32XX_SPEEDS = [
  { D0310C: 17 },
  { D0310C: 1 },
  { D0310C: 2 },
  { D0310C: 3 },
  { D0310C: 4 },
  { D0310C: 5 },
  { D0310C: 18 },
];

//sleep, medium, turbo
const AC0950_SPEEDS = [{ D0310C: 17 }, { D0310C: 19 }, { D0310C: 18 }];

Object.assign(models, {
  //dashed dialect, the AC0850 AWS_Philips_AIR configuration
  //ruaan-deysel/ha-philips-airpurifier gives the AC0650: Sleep and Turbo only,
  //no light or child lock, and no pre-filter
  AC0650: {
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
  },

  //legacy dialect: the generic keys are the wire keys, so only the speeds and
  //modes are the model's own

  //ruaan-deysel/ha-philips-airpurifier marks it as needing mode cycling, a
  //flag nothing there acts on, so its modes are written directly here
  AC1214: {
    speeds: manualOmSpeeds({ mode: 'N' }),
    modeMaps: P_AND_A_MODES,
  },
  //a humidifier on the legacy func, rhset and wl
  AC2729: {
    speeds: manualOmSpeeds({ mode: 'S', om: 's' }),
    modeMaps: P_AND_A_MODES,
  },
  AC2889: {
    speeds: manualOmSpeeds({ mode: 'M', om: 's' }),
    modeMaps: P_AND_A_MODES,

    alsoAuto: BACTERIA_AUTO,
  },
  AC2936: {
    speeds: [{ mode: 'S' }, { mode: 'GT' }, { mode: 'T' }],
    modeMaps: AG_MODES,
  },
  AC2939: {
    speeds: [{ mode: 'S' }, { mode: 'GT' }, { mode: 'T' }],
    modeMaps: AG_MODES,
  },
  AC2958: {
    speeds: [{ mode: 'S' }, { mode: 'GT' }, { mode: 'T' }],
    modeMaps: AG_MODES,
  },
  AC2959: {
    speeds: [{ mode: 'S' }, { mode: 'GT' }, { mode: 'T' }],
    modeMaps: AG_MODES,
  },
  AC3033: {
    speeds: AC303X_SPEEDS,
    modeMaps: AG_MODES,
  },
  AC3039: {
    speeds: AC303X_SPEEDS,
    modeMaps: AG_MODES,
  },
  AC3055: {
    speeds: AC303X_SPEEDS,
    modeMaps: AG_MODES,
  },
  AC3059: {
    speeds: AC303X_SPEEDS,
    modeMaps: AG_MODES,
  },
  AC3259: {
    speeds: manualOmSpeeds({ mode: 'M', om: 's' }),
    modeMaps: P_AND_A_MODES,

    alsoAuto: BACTERIA_AUTO,
  },
  //Auto is written, and read, with om 1 beside mode AG
  AC3836: {
    speeds: [
      { mode: 'S', om: 's' },
      { mode: 'T', om: 't' },
    ],
    modeMaps: {
      auto: { mode: 'AG', om: '1' },
    },
  },
  //the /25, /50 and /51 variants differ only in an allergy sleep preset and a
  //child lock switch there, neither of which changes what is sent here
  AC3854: {
    speeds: AC303X_SPEEDS,
    modeMaps: AG_MODES,
  },
  AC3858: {
    speeds: AC303X_SPEEDS,
    modeMaps: AG_MODES,
  },
  AC4236: {
    speeds: AC303X_SPEEDS,
    modeMaps: AG_MODES,
  },
  //the automatic modes write om a beside the mode, and the manual speeds om
  //alone, so om tells Auto from a speed
  AC4550: {
    speeds: [{ om: 's' }, { om: '1' }, { om: '2' }, { om: 't' }],
    modeMaps: {
      auto: { mode: 'AG', om: 'a' },
      allergen: { mode: 'A', om: 'a' },
    },

    alsoAuto: AC4558_ALSO_AUTO,
  },
  AC4558: {
    speeds: [{ om: 's' }, { om: '1' }, { om: '2' }, { om: 't' }],
    modeMaps: {
      auto: { mode: 'AG', om: 'a' },
      allergen: { mode: 'A', om: 'a' },
    },

    alsoAuto: AC4558_ALSO_AUTO,
  },
  //ruaan-deysel/ha-philips-airpurifier names P "pollution" here and lists no
  //Auto, but it is the same automatic P the AC2889 and AC3259 call Auto
  AC5659: {
    speeds: manualOmSpeeds({ mode: 'M', om: 's' }),
    modeMaps: P_AND_A_MODES,

    alsoAuto: BACTERIA_AUTO,
  },
  AC5660: {
    speeds: manualOmSpeeds({ mode: 'M', om: 's' }),
    modeMaps: P_AND_A_MODES,

    alsoAuto: BACTERIA_AUTO,
  },

  //dash-less dialect, numeric values sent with -I. ruaan-deysel's
  //ha-philips-airpurifier offers no light on the AC0950 and AC0951
  AC0950: dashless({
    speeds: AC0950_SPEEDS,
    modeMaps: DASHLESS_AUTO,
  }),
  AC0951: dashless({
    speeds: AC0950_SPEEDS,
    modeMaps: DASHLESS_AUTO,
  }),
  AC2210: dashless({
    speeds: AC32XX_SPEEDS,
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
  }),
  AC2220: dashless({
    speeds: AC32XX_SPEEDS,
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
  }),
  AC2221: dashless({
    speeds: AC32XX_SPEEDS,
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
  }),
  AC3210: dashless({
    speeds: AC32XX_SPEEDS,
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
  }),
  AC3220: dashless({
    speeds: AC32XX_SPEEDS,
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
  }),
  AC3221: dashless({
    speeds: AC32XX_SPEEDS,
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
  }),
  //humidifiers, but with no humidifier control here (see DASHLESS_HUMIDIFIER)
  AC3420: dashless({
    speeds: AC0950_SPEEDS,
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
    ...DASHLESS_HUMIDIFIER,
  }),
  AC3421: dashless({
    speeds: AC0950_SPEEDS,
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
    ...DASHLESS_HUMIDIFIER,
  }),
  //a humidifier whose steps are D0310A/D0310C pairs, turbo on D0310A 3. Its
  //only light register is D03105, read-only on this dialect (see LAMP_LIGHT),
  //so it has no light here
  AC3737: dashless({
    speeds: [
      { D0310A: 2, D0310C: 17 },
      { D0310A: 2, D0310C: 1 },
      { D0310A: 2, D0310C: 2 },
      { D0310A: 3, D0310C: 18 },
    ],
    modeMaps: {
      auto: { D0310A: 2, D0310C: 0 },
    },
    ...DASHLESS_HUMIDIFIER,
  }),
  //homebridge-philips-airctrl, on an AC4220/12: D0310C 5 already runs at
  //Turbo, and Turbo (18) and medium (19) only repeat speeds 5 and 3. So the
  //ladder stops at 5 here, where ruaan-deysel/ha-philips-airpurifier adds
  //Turbo above it as on the AC32xx
  AC4220: dashless({
    speeds: AC32XX_SPEEDS.slice(0, -1),
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
  }),
  AC4221: dashless({
    speeds: AC32XX_SPEEDS.slice(0, -1),
    modeMaps: DASHLESS_AUTO,
    ...LAMP_LIGHT,
  }),
  //a purifier and fan, speeds 1 to 10 between Sleep and Turbo. Its backlight
  //D0312D takes 0/100 (both projects agree), so both light writes land there
  //and the light is on or off. Oscillation has no HomeKit surface here
  AMF765: dashless({
    speeds: [
      { D0310C: 17 },
      { D0310C: 1 },
      { D0310C: 2 },
      { D0310C: 3 },
      { D0310C: 4 },
      { D0310C: 5 },
      { D0310C: 6 },
      { D0310C: 7 },
      { D0310C: 8 },
      { D0310C: 9 },
      { D0310C: 10 },
      { D0310C: 18 },
    ],
    modeMaps: DASHLESS_AUTO,
    keyMaps: { aqil: 'D0312D', uil: 'D0312D' },
    valueMaps: {
      aqil: { 0: 0, 25: 100, 50: 100, 75: 100, 100: 100 },
      uil: { 1: 100, 0: 0 },
    },
  }),
});

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
    alsoAuto: model.alsoAuto || [],
    fanLevel: model.fanLevel,
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

//whether a model has a humidifier on/off the plugin can drive, i.e. whether
//the humidifier option can do anything for it
modelConfig.hasHumidifier = (key) => !(key && models[key] && (models[key].unsupported || []).includes('func'));

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
