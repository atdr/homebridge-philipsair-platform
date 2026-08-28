'use strict';

const { execFile, spawn } = require('child_process');

const logger = require('../utils/logger');
const { hapNumber } = require('../utils/utils');
const { DEFAULT_BINARY } = require('../utils/preflight');
const modelConfig = require('./accessories.models');
const { resolveModel, identifyModel, readsStatus, looksLikeRegisters } = modelConfig;

//status lines are small JSON objects; anything beyond this is a misbehaving
//device or CLI streaming data without newlines
const MAX_STDOUT_BUFFER = 1024 * 1024;

//the observe stream is torn down and respawned once the device has been silent
//for this long. this is an *idle* timer, reset by every status line, and it is
//a *fault* detector, not a poll: the refresh below is what keeps an idle device
//fresh, so this only has to be longer than a refresh cycle can legitimately take
const STALL_TIMEOUT = 300 * 1000;

//the same timer while the device reports itself switched off, when silence is
//normal rather than a fault: an AC0850 held on a single uninterrupted
//subscription answered nothing for 25 minutes and then resumed on its own, so
//no constant makes the short timeout right for this case and restarting the
//stream demonstrably does not elicit an answer. This is only a backstop against
//a subscription that died without anyone noticing, which is why it is far
//longer than the measured silence rather than tuned to it
const OFF_STALL_TIMEOUT = 30 * 60 * 1000;

//how long after a reading the plugin asks for another one, by re-subscribing.
//not derived from any device measurement: it is what v1.1.0's fixed 60s process
//lifetime did accidentally, on every model, for years. a device that pushes on
//its own faster than this never triggers it
const REFRESH_INTERVAL = 60 * 1000;

//how fast the estimate of what re-subscribing costs follows the last refresh,
//as the weight given to a new reading. deliberately asymmetric: a refresh that
//cost more than expected is evidence, while one answered cheaply may be luck,
//and #71 established that on this hardware the expensive mistake is being too
//eager. So the estimate rises quickly and falls slowly, settling above the mean
//rather than on it, which errs toward leaving a working stream alone
const REFRESH_COST_RISE = 0.5;
const REFRESH_COST_FALL = 0.125;

//how long a `set` is given before it is killed. aioairctrl opens a session
//before sending its fire-and-forget packet, and that handshake has no timeout
//of its own: against a host that never answers it waits indefinitely, measured
//here as no output and no exit at 180s and again at 900s. Without a cap the
//promise never settles, the onSet never returns, and the Python child is
//stranded for the life of the Homebridge run (issue #77). Generous next to a
//`set` that works, which answers in well under a second even from a purifier
//that had been silent for the best part of an hour
const SET_TIMEOUT = 30 * 1000;

//delay before respawning a stream that ended
const RESTART_DELAY = 5 * 1000;

//longer delay when the binary could not be executed at all, since retrying
//quickly cannot fix a missing or unrunnable command
const SPAWN_ERROR_RESTART_DELAY = 30 * 1000;

//how much of a failing process's stderr is kept so that it can be reported.
//aioairctrl's tracebacks are what tell a user their Python install is broken
const MAX_STDERR_CAPTURE = 4 * 1024;

//Python logging's default record format, 'LEVEL:logger.name:message'. with
//'cliDebug' enabled the plugin passes -D and aioairctrl writes its whole debug
//log to stderr, so the stream carries progress as well as faults: 'syncing' is
//not a diagnosis and must never be reported as one. records at WARNING and
//above are kept, since those are the CLI reporting a problem in its own words,
//and those arrive without -D
const CLI_PROGRESS_LINE = /^(DEBUG|INFO):[^\s:]*:/;

//consecutive polls returning nothing before the plugin escalates from a debug
//line to a warning. a single dropped stream is normal; a run of them is not
const FAILURE_ESCALATION_THRESHOLD = 3;

//how long a write stays pending, over and above two refresh cycles: one for the
//device to answer the write, one for it to answer the resend. a write still
//unconfirmed when this expires is only reported if the device actually answered
//and disagreed; silence means this model answers more slowly than the refresh
//cycle assumes, which is a freshness problem rather than a lost command
const VERIFY_WINDOW_MARGIN = 180 * 1000;

//floor for the same, so switching the refresh off does not switch verification
//off with it
const VERIFY_WINDOW_MIN = 300 * 1000;

//resends of a write the device answered and did not apply, before the user is
//told. one lost packet is unremarkable; two in a row is worth a warning
const MAX_WRITE_RETRIES = 1;

//how long after a command goes out before the device's answers start counting
//as answers to it. A `set` is one unacknowledged packet, and a status push
//already being composed when it lands still carries the old value, so it is
//evidence about neither the write nor the resend. Measured on an AC0850: a
//resend at 02:19:31 was contradicted by a push a second later and confirmed by
//the next one in the same second, which on the last attempt is the difference
//between silence and a warning telling the user to go and check their network
//(issue #77). Small next to every other horizon here, and the device pushes
//every 6 to 40 seconds, so it costs at most one skipped push
const WRITE_SETTLE = 3 * 1000;

/**
 * A write waiting for the device to confirm it. `since` is the transmission
 * horizon, `recordedAt` the moment the user asked for it: the first decides
 * which statuses count as evidence, the second anchors both deadlines.
 *
 * @typedef {{ expected: unknown, args: string[], attempts: number, since: number,
 *   recordedAt: number, knownOff: boolean, window: number, blindResent: boolean }} PendingWrite
 */

class Handler {
  constructor(api, accessory) {
    this.api = api;
    this.accessory = accessory;

    this.shutdown = false;
    this.airControl = null;
    this.processTimeout = null;
    this.restartTimeout = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    //the tail of the last stderr chunk, which may stop mid-line
    this.stderrPartial = '';
    this.receivedData = false;
    this.stalled = false;
    //whether the stall that ended the stream was the long off-state backstop,
    //which is a teardown the plugin chose rather than a fault to report
    this.stalledWhileOff = false;
    this.spawnFailed = false;
    this.refreshing = false;
    this.pollFailures = 0;
    //which kind of failure ('spawn' | 'stop' | 'exit' | 'stall') has already been
    //warned about, so a retry loop stays quiet without hiding a *different* failure
    /** @type {'spawn' | 'stop' | 'exit' | 'stall' | null} */
    this.loggedFailureKind = null;
    //the same brake for unparseable output, which arrives per line rather than
    //per process and so has its own latch
    this.loggedParseFailure = false;
    //writes waiting for the device to confirm them, keyed by the generic status
    //key each one sets. see recordWrite
    /** @type {Map<string, PendingWrite>} */
    this.pendingWrites = new Map();
    this.verifyTimeout = null;
    this.refreshTimeout = null;
    //when the last refresh killed the stream, so the reading that answers the
    //replacement subscription can be priced. null once that price is known
    /** @type {number | null} */
    this.refreshKilledAt = null;
    //what the refresh has learned re-subscribing to this device costs, in ms.
    //null until a refresh has been priced, when the configured interval stands
    //in: it is what the plugin waits having measured nothing. see adaptRefresh
    /** @type {number | null} */
    this.refreshCost = null;
    //when the stream last produced a line, which outlives the stream that
    //produced it: the stall deadline is measured from a *reading*, and every
    //stall after a teardown is judged on a stream that has answered nothing yet
    /** @type {number | null} */
    this.lastReadingAt = null;
    //when the stall detector last tore the stream down. a stall that has been
    //acted on is spent, so the next deadline runs from here rather than from a
    //reading that may now be hours old. see stallDelay
    /** @type {number | null} */
    this.lastStallAt = null;
    //whether an unapplied write has already been warned about, so an automation
    //that keeps failing reports once rather than on every cycle
    this.loggedWriteFailure = false;
    this.obj = {};

    //instance fields rather than bare constants so tests can shorten the waits
    this.stallTimeout = STALL_TIMEOUT;
    this.offStallTimeout = OFF_STALL_TIMEOUT;
    this.restartDelay = RESTART_DELAY;
    this.spawnErrorRestartDelay = SPAWN_ERROR_RESTART_DELAY;
    this.maxWriteRetries = MAX_WRITE_RETRIES;

    const configuredInterval = this.accessory.context.config.refreshInterval;
    this.refreshInterval = (configuredInterval === undefined ? REFRESH_INTERVAL / 1000 : configuredInterval) * 1000;

    //a write is answered by the same stream everything else is: one refresh
    //cycle for the device to report it, another for the resend, plus margin
    this.verifyWindow = Math.max(2 * this.refreshInterval + VERIFY_WINDOW_MARGIN, VERIFY_WINDOW_MIN);

    const config = this.accessory.context.config;

    //modelKey is stamped on by accessories.setup.js, which resolves it once and
    //reports what it found; resolving again covers a config built directly
    this.modelKey = config.modelKey || resolveModel(config).key;
    this.mappingChecked = false;

    //a model this device identified itself as on an earlier run, adopted only
    //where nothing in the config names one. It cannot be applied mid-stream:
    //`unsupported` decides which HomeKit services accessories.service.js
    //builds, and that happens once, immediately after this constructor
    if (!this.modelKey && this.accessory.context.detectedModel) {
      this.modelKey = this.accessory.context.detectedModel;
      config.modelKey = this.modelKey;
      //not "no model is configured": this branch is also taken when a model is
      //configured that no mapping covers, and accessories.setup.js has already
      //reported which of the two it was
      logger.info(
        `Using the ${this.modelKey} command set instead of the default, ` +
          "detected from this device's own status on an earlier run.",
        this.accessory.displayName
      );
    }

    const { speeds, keyMaps, valueMaps, extraSetFlags, unsupported } = modelConfig(config);
    this.speeds = speeds;
    this.keyMaps = keyMaps;
    this.valueMaps = valueMaps;
    this.extraSetFlags = extraSetFlags;
    this.unsupported = new Set(unsupported);

    //how long a `set` is given before it is killed. an instance field for the
    //same reason the verification windows are: so a test can shorten it
    this.sendTimeout = SET_TIMEOUT;

    //how long the device is given to process a command before its answers count
    //as answers to it. an instance field for the same reason
    this.writeSettle = WRITE_SETTLE;

    //tail of the queue that keeps `set` commands from overlapping. see sendCMD
    /** @type {Promise<void>} */
    this.writeQueue = Promise.resolve();

    this.binary = this.accessory.context.config.aioairctrlPath || DEFAULT_BINARY;
    this.args = [
      '-H',
      this.accessory.context.config.host,
      '-P',
      String(this.accessory.context.config.port),
      this.accessory.context.config.cliDebug ? '-D' : '',
    ].filter((cmd) => cmd);
  }

  /**
   * Why the binary could not be executed, in the user's terms. ENOENT and
   * EACCES arrive through the same code paths but have nothing in common:
   * one means install it, the other means it is already there and the
   * Homebridge user may not run it. Reporting both as "not found" sends half
   * the readers after an install that is working.
   *
   * @param {string} [code] the errno from the failed spawn
   * @returns {Error}
   */
  unrunnableBinaryError(code) {
    if (code === 'EACCES' || code === 'EPERM') {
      return new Error(
        `${this.binary} exists but could not be executed. Check its ownership and permissions ` +
          `('ls -l ${this.binary}'), and that the Homebridge user may run it (see README Troubleshooting).`
      );
    }

    return new Error(
      `${this.binary} not found. Install it with 'pipx install aioairctrl' and make sure the Homebridge user can run it, or set 'aioairctrlPath' in the platform config to its full path (see README).`
    );
  }

  /**
   * A device that did not answer the session handshake a `set` needs, in the
   * user's terms. Named separately from unrunnableBinaryError because the two
   * send readers in opposite directions: one is the install, the other is
   * everything between Homebridge and the purifier.
   *
   * @returns {Error}
   */
  unreachableDeviceError() {
    const { host, port } = this.accessory.context.config;

    return new Error(
      `${this.binary} got no answer from ${host}:${port} within ${this.sendTimeout / 1000}s and was stopped. ` +
        `The device may be powered off at the mains, on another network, or at a different address (see README Troubleshooting).`
    );
  }

  /**
   * Runs one `set`. Everything goes through sendCMD rather than here, so that
   * no two of these are ever in flight at once.
   *
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  runCMD(args) {
    //logged as it goes out rather than as it is queued, so the log still says
    //what was on the wire and when
    logger.debug(`CMD: ${this.binary} ${args.join(' ')}`, this.accessory.displayName);

    return new Promise((resolve, reject) => {
      execFile(this.binary, args, { timeout: this.sendTimeout }, (err, stdout, stderr) => {
        if (err) {
          const code = /** @type {NodeJS.ErrnoException} */ (err).code;
          const unrunnable = code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';

          if (unrunnable) {
            return reject(this.unrunnableBinaryError(code));
          }

          //a command killed on the timeout above is a device that cannot be
          //reached, not an install that cannot run. execFile's own message for
          //it names only the command line, which reads like the latter
          if (/** @type {{ killed?: boolean }} */ (err).killed) {
            return reject(this.unreachableDeviceError());
          }

          return reject(err);
        }

        logger.debug(stderr, this.accessory.displayName);

        //a `set` the CLI refuses is not a non-zero exit: aioairctrl prints its
        //complaint on *stdout* ("Cannot encode value 'P' as int"), drops the
        //write and still exits 0. a successful `set` prints nothing at all, so
        //anything here is the command being rejected rather than sent
        const rejection = args.includes('set') ? stdout.toString().trim() : '';

        if (rejection) {
          return reject(new Error(`${this.binary} rejected the command: ${rejection}`));
        }

        resolve();
      });
    });
  }

  /**
   * Sends a command, never at the same time as another one.
   *
   * These purifiers serve **one connection at a time**, and the plugin already
   * holds one for status-observe, so a second `set` running alongside a first
   * is contention rather than throughput. Issue #77 measured it: at a device
   * that had been silent for around 40 minutes, two `set` processes fired in
   * the same second lost the wake-up 3 times in 4, while the same commands sent
   * one after another were answered within a second, twice out of twice. The
   * one concurrent pair that did land went to a device that was already awake.
   *
   * Nothing changes on the wire. The same commands with the same flags are sent
   * in the same order, just spaced, which is why this is safe on models nobody
   * here can test.
   *
   * The cosmetic light writes queue with the rest. One connection at a time is
   * a property of the device, not of how much the write matters, and a
   * brightness drag currently races dozens of processes at it. The cost is that
   * a long drag can hold up a command issued behind it.
   *
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  sendCMD(args) {
    const run = () => this.runCMD(args);
    //`then(run, run)` rather than a chained catch: one command failing must not
    //stop the next from being attempted, and must not leave a rejection sitting
    //unhandled on the tail
    const queued = this.writeQueue.then(run, run);

    this.writeQueue = queued.catch(() => {});

    return queued;
  }

  /**
   * Builds a `set` invocation. `-I` asks aioairctrl to encode every value in
   * the command as an integer, so it is dropped when any value is not one:
   * applying it to `mode=P` makes the CLI reject the whole command, and a model
   * that needs `-I` for its registers (`extraSetFlags`) can still have keys
   * whose values are words.
   *
   * @param {string[]} cmds `key=value` elements from handleCommand
   * @param {string[]} [extraFlags] flags this specific command asks for
   * @returns {string[]}
   */
  setArgs(cmds, extraFlags = []) {
    //aioairctrl converts 'true'/'false' to booleans before int(), so those
    //survive -I as 1/0; anything else has to look like a whole number
    const intEncodable = cmds.every((cmd) => {
      const value = cmd.slice(cmd.indexOf('=') + 1);
      return value === 'true' || value === 'false' || /^\s*[+-]?\d+\s*$/.test(value);
    });

    const flags = [...new Set([...this.extraSetFlags, ...extraFlags])].filter((flag) => flag !== '-I' || intEncodable);

    return [...this.args, 'set', ...flags, ...cmds];
  }

  /**
   * Checks the mapping in force against what the device actually reports, once
   * per start, on the first status substantial enough to judge.
   *
   * A wrong model is invisible from the plugin's side: the commands are
   * transmitted, the device discards the ones it has no register for, and
   * nothing errors. The device's own status is the one piece of evidence that
   * settles it, and it arrives on the stream anyway. A separate probe is not an
   * option, since these purifiers serve one connection at a time.
   *
   * What is found is recorded on the accessory context rather than acted on
   * here, and picked up by the constructor on the next start. See there for why.
   *
   * @param {Record<string, unknown>} status
   */
  checkModelMapping(status) {
    if (this.mappingChecked) {
      return;
    }

    //devices report only what they have, so a short push is not evidence
    if (Object.keys(status).length < 3) {
      return;
    }

    this.mappingChecked = true;

    const { key, certainty } = identifyModel(status);
    const readable = readsStatus(status, this.keyMaps);

    if (key && key !== this.modelKey) {
      //a partial register overlap is not evidence against a mapping that is
      //demonstrably reading this device; a device naming itself is
      if (certainty === 'fingerprint' && readable) {
        return;
      }

      this.accessory.context.detectedModel = key;
      //accessory.context is otherwise only written out when Homebridge shuts
      //down cleanly, so a power cut or an OOM kill between here and then loses
      //the finding and the next start repeats this run rather than adopting it
      this.api.updatePlatformAccessories([this.accessory]);

      logger.warn(
        (certainty === 'reported'
          ? `This device reports itself as ${key}, which is not the model configured for it. `
          : `This device reports registers this model mapping does not know (${Object.keys(status)
              .slice(0, 4)
              .join(', ')}), and they match the ${key} mapping. `) +
          `Its controls will not work until the model is set to ${key} in the plugin config. ` +
          `Until then the ${key} command set will be used from the next restart.`,
        this.accessory.displayName
      );

      return;
    }

    if (!readable && looksLikeRegisters(status)) {
      logger.warn(
        `This device reports registers no model mapping in this plugin knows (${Object.keys(status)
          .slice(0, 4)
          .join(', ')}), so its controls will not work. ` +
          'Please open an issue with a debug log so the model can be added.',
        this.accessory.displayName
      );
    }
  }

  handleResponse(json) {
    this.checkModelMapping(json);

    this.obj = json;

    Object.entries(this.keyMaps).forEach(([key, mappedKey]) => {
      this.obj[key] = this.valueMaps[key] ? this.valueMaps[key][this.obj[mappedKey]] : this.obj[mappedKey];
      delete this.obj[mappedKey];
    });

    logger.debug(this.obj, this.accessory.displayName);
  }

  /**
   * Whether this model has a register for a generic key at all. A key it does
   * not have cannot be written (the command is transmitted and ignored, or
   * refused outright) and never appears in a status, so a HomeKit control bound
   * to it would report a state the device never has. See accessories.models.js.
   *
   * @param {string} key
   */
  supports(key) {
    return !this.unsupported.has(key);
  }

  handleCommand(key, value) {
    value = this.valueMaps[key] ? this.valueMaps[key][value] : value;
    key = this.keyMaps[key] || key;
    logger.debug(`${key}=${value}`, this.accessory.displayName);

    return `${key}=${value}`;
  }

  /**
   * The HomeKit threshold for the humidity target the device reports. The
   * conditions guarding it differ between the status push and the setters, but
   * this ladder is identical everywhere it is used, so it lives in one place.
   */
  humidityThreshold() {
    return { 40: 25, 50: 50, 60: 75, 70: 100 }[this.obj.rhset] || 0;
  }

  speedsMinStep() {
    return 100 / this.speeds.length;
  }

  rotationSpeed() {
    let speedConfigIndex = this.speeds.findIndex((speedConfig) => {
      return Object.entries(speedConfig).every(([cmd, value]) => {
        return (this.obj[cmd] ?? '').toString() == value.toString();
      });
    });
    let speedIndex = speedConfigIndex + 1;
    logger.debug(`#rotationSpeed: ${speedIndex * this.speedsMinStep()}`, this.accessory.displayName);
    return speedIndex * this.speedsMinStep();
  }

  //Air Purifier
  async setPurifierActive(state) {
    try {
      const stateNumber = state ? 1 : 0;

      const args = this.setArgs([this.handleCommand('pwr', stateNumber)]);

      this.purifierService.updateCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState, stateNumber * 2);

      logger.info(`Purifier Active: ${state}`, this.accessory.displayName);
      await this.sendTracked(args, { pwr: stateNumber });
    } catch (err) {
      logger.warn('An error occured during changing purifier state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  async setPurifierTargetState(state) {
    if (!this.supports('mode')) {
      logger.debug(`This model has no mode register, ignoring purifier mode ${state}`, this.accessory.displayName);
      return;
    }

    try {
      const values = {
        mode: state ? 'P' : this.accessory.context.config.allergicFunc ? 'A' : 'M',
      };

      if (state != 0) {
        this.purifierService
          .updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, 0)
          .updateCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, state);
      }

      const args = this.setArgs([this.handleCommand('mode', values.mode)]);

      logger.info(`Purifier Mode: ${state}`, this.accessory.displayName);

      await this.sendTracked(args, { mode: values.mode });
    } catch (err) {
      logger.warn('An error occured during changing target purifier state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  async setPurifierLockPhysicalControls(state) {
    if (!this.supports('cl')) {
      logger.debug(`This model has no child lock register, ignoring lock ${state}`, this.accessory.displayName);
      return;
    }

    try {
      const values = {
        cl: state == 1,
      };

      const args = this.setArgs([this.handleCommand('cl', values.cl)]);

      logger.info(`Lock: ${state}`, this.accessory.displayName);

      await this.sendTracked(args, { cl: values.cl });
    } catch (err) {
      logger.warn('An error occured during changing lock state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  async setPurifierRotationSpeed(value) {
    try {
      const speed = Math.ceil(value / this.speedsMinStep());

      if (speed > 0) {
        //MANUAL is not a value this characteristic accepts on a model with no
        //mode register: accessories.service.js constrains it to AUTO there
        if (this.supports('mode')) {
          this.purifierService.updateCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, 0);
        }

        logger.info(`Purifier Rotation Speed: value: ${value}`, this.accessory.displayName);

        let cmds = [];
        Object.entries(this.speeds[speed - 1]).forEach(([cmd, value]) => {
          cmds.push(`${this.handleCommand(cmd, value)}`);
        });
        const args = this.setArgs(cmds);

        logger.info(`Purifier Rotation Speed: cmds: ${cmds.join(' ')}`, this.accessory.displayName);

        await this.sendTracked(args, this.speeds[speed - 1]);
      }
    } catch (err) {
      logger.warn('An error occured during changing purifier rotation speed!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  //Humidifier
  async setHumidifierActive(state) {
    try {
      const values = {
        func: state ? 'PH' : 'P',
      };

      let water_level = 100;

      if (this.obj.func == 'PH' && this.obj.wl == 0) {
        water_level = 0;
      }

      let speed_humidity = 0;
      let state_ph = 0;

      if (this.obj.func == 'PH' && water_level == 100) {
        state_ph = 1;

        speed_humidity = this.humidityThreshold();
      }

      this.humidifierService.updateCharacteristic(this.api.hap.Characteristic.TargetHumidifierDehumidifierState, 1);

      if (state) {
        this.humidifierService
          .updateCharacteristic(this.api.hap.Characteristic.Active, 1)
          .updateCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState, state_ph * 2)
          .updateCharacteristic(this.api.hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity);
      } else {
        this.humidifierService
          .updateCharacteristic(this.api.hap.Characteristic.Active, 0)
          .updateCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState, 0)
          .updateCharacteristic(this.api.hap.Characteristic.RelativeHumidityHumidifierThreshold, 0);
      }

      const args = this.setArgs([this.handleCommand('func', values.func)]);

      logger.info(`Humidifier Active: ${state}`, this.accessory.displayName);

      await this.sendTracked(args, { func: values.func });
    } catch (err) {
      logger.warn('An error occured during changing humidifier state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  /*setHumidifierCurrentState(state) {
    return new Promise((resolve, reject) => {});
  }*/

  async setHumidifierTargetState(state) {
    try {
      const speed = state;

      const values = {
        func: state ? 'PH' : 'P',
        rhset: 40,
      };

      let speed_humidity = 0;

      if (speed > 0 && speed <= 25) {
        values.rhset = 40;
        speed_humidity = 25;
      } else if (speed > 25 && speed <= 50) {
        values.rhset = 50;
        speed_humidity = 50;
      } else if (speed > 50 && speed <= 75) {
        values.rhset = 60;
        speed_humidity = 75;
      } else if (speed > 75 && speed <= 100) {
        values.rhset = 70;
        speed_humidity = 100;
      }

      let water_level = 100;

      if (this.obj.func == 'PH' && this.obj.wl == 0) {
        water_level = 0;
      }

      this.humidifierService.updateCharacteristic(this.api.hap.Characteristic.TargetHumidifierDehumidifierState, 1);

      if (speed_humidity > 0) {
        this.humidifierService
          .updateCharacteristic(this.api.hap.Characteristic.Active, 1)
          .updateCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState, 2)
          .updateCharacteristic(this.api.hap.Characteristic.WaterLevel, water_level)
          .updateCharacteristic(this.api.hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity);
      } else {
        this.humidifierService.updateCharacteristic(this.api.hap.Characteristic.Active, 0);
      }

      const args1 = this.setArgs([this.handleCommand('func', values.func)]);
      const args2 = this.setArgs([this.handleCommand('rhset', values.rhset)], ['-I']);

      logger.info(`Humidifier State: ${state}`, this.accessory.displayName);

      await this.sendTracked(args1, { func: values.func });
      await this.sendTracked(args2, { rhset: values.rhset });
    } catch (err) {
      logger.warn('An error occured during changing target humidifer state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  /*setHumidifierThreshold(value) {
    return new Promise((resolve, reject) => {});
  }*/

  //Light
  async setLightOn(state) {
    if (this.settingBrightness) {
      return;
    }

    this.settingLightState = true;

    try {
      const values = {
        aqil: state ? 100 : 0,
        uil: state ? '1' : '0',
      };

      //Light
      const args1 = this.setArgs([this.handleCommand('aqil', values.aqil)], ['-I']);
      const args2 = this.setArgs([this.handleCommand('uil', values.uil)]);

      logger.info(`Light state: ${state}`, this.accessory.displayName);

      //the light writes are deliberately not verified: they are cosmetic, and a
      //slider dragged across its range would otherwise elicit a re-subscribe per
      //step. see recordWrite
      await this.sendCMD(args1);
      await this.sendCMD(args2);
    } catch (err) {
      logger.warn('An error occured during changing light state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }

    this.settingLightState = false;
  }

  async setLightBrightness(value) {
    if (this.settingLightState) {
      return;
    }

    this.settingBrightness = true;

    try {
      const values = {
        aqil: value,
        uil: value ? '1' : '0',
      };

      //Light
      const args1 = this.setArgs([this.handleCommand('aqil', values.aqil)], ['-I']);
      const args2 = this.setArgs([this.handleCommand('uil', values.uil)]);

      logger.info(`Brightness: ${value}`, this.accessory.displayName);

      await this.sendCMD(args1);
      await this.sendCMD(args2);
    } catch (err) {
      logger.warn('An error occured during changing light brightness!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }

    this.settingBrightness = false;
  }

  /**
   * Registers a write for confirmation. `aioairctrl set` sends an
   * unacknowledged (NON) CoAP packet and exits, so a resolved `sendCMD` proves
   * the command was *transmitted*, not that it was applied: a packet lost in
   * transit, or arriving while the device dozes, disappears with no error while
   * HomeKit keeps showing the value it was optimistically given.
   *
   * Expectations are recorded in generic key space, the space `handleResponse`
   * maps device registers back into, so this needs no per-model code.
   *
   * @param {string[]} args the exact command to resend if it did not take
   * @param {Record<string, unknown>} expectations generic key -> expected value
   */
  recordWrite(args, expectations) {
    const recordedAt = Date.now();

    //how long silence proves nothing depends on which regime the device is in,
    //and the plugin already models both: verifyWindow is derived from how fast a
    //*responsive* device answers, while a device reporting itself off may say
    //nothing for offStallTimeout without anything being wrong. Judging a write
    //to a sleeping device by the responsive window discarded it long before the
    //evidence arrived (issue #77). The regime is read once, here: a device that
    //wakes up is resolved by reconcilePendingWrites on the status that proves
    //it, so nothing needs to reconsider this later.
    //
    //max() rather than offStallTimeout alone, so a long configured
    //refreshInterval cannot make the off-state window the *shorter* of the two
    const knownOff = this.deviceKnownOff();
    const window = knownOff ? Math.max(this.offStallTimeout, this.verifyWindow) : this.verifyWindow;

    for (const [key, expected] of Object.entries(expectations)) {
      //a key the device has never mentioned can never confirm anything, so an
      //expectation on it would only buy a resend and a report of a failure that
      //may not have happened. the model may simply have no register for it
      if (this.receivedData && !(key in this.obj)) {
        logger.debug(
          `The device does not report ${key}, so ${key}=${expected} cannot be confirmed`,
          this.accessory.displayName
        );
        continue;
      }

      this.pendingWrites.set(key, {
        expected,
        args,
        //closed until the command has actually been transmitted: it is recorded
        //before the send, and a serialised send may wait its turn first
        since: Infinity,
        attempts: 0,
        recordedAt,
        knownOff,
        window,
        blindResent: false,
      });
    }

    this.armVerifyTimeout();
  }

  /**
   * Records a write and then sends it, in that order.
   *
   * The order is the point. `aioairctrl set` needs a session handshake before
   * its fire-and-forget packet, and that handshake has no timeout of its own,
   * so against a purifier that is unplugged or off the network the send does
   * not resolve for a long time and may not resolve at all. Recording after it
   * meant no pending write existed in exactly the case the verification
   * machinery was built for: HomeKit kept the value it had been given
   * optimistically, and nothing was ever going to correct it (issue #77).
   *
   * A pending write for a command that never left the host is the right state,
   * not a wrong one. The give-up path is what should handle it, and putting
   * HomeKit back is its job.
   *
   * Recording first also makes insertion order follow setter order rather than
   * child-process exit order, which is what any rule about the order commands
   * are resent in needs in order to mean anything.
   *
   * @param {string[]} args
   * @param {Record<string, unknown>} expectations generic key -> expected value
   * @returns {Promise<void>}
   */
  async sendTracked(args, expectations) {
    this.recordWrite(args, expectations);

    try {
      await this.sendCMD(args);
      this.markWriteSent(args);
    } catch (err) {
      //rethrown so each setter still reports the failure in its own words
      this.abandonWrite(args);
      throw err;
    }
  }

  /**
   * Closes the window on writes the device never spoke to. Verification rides
   * the refresh the stream is doing anyway: killing the subscription on a
   * write's own schedule threw away the notification it was waiting for, and
   * then paid a fresh subscription's latency to ask for it again.
   */
  armVerifyTimeout() {
    if (this.verifyTimeout || !this.pendingWrites.size) {
      return;
    }

    //the earliest deadline still outstanding, so a sweep triggered by an
    //unrelated status does not push an older write's expiry out by a window.
    //each write carries its own window, so this cannot be one shared deadline
    const due = Math.min(...[...this.pendingWrites.values()].map((pending) => this.nextVerifyDeadline(pending)));

    this.verifyTimeout = setTimeout(
      () => {
        this.verifyTimeout = null;
        this.expirePendingWrites();
        this.armVerifyTimeout();
      },
      Math.max(due - Date.now(), 0)
    );
  }

  /**
   * Whether a write is still owed its one unprompted resend.
   *
   * Deliberately *not* charged to `attempts`. That budget belongs to the resend
   * the device's own answer asks for, and with one retry to spend, charging a
   * blind resend to it would leave `reconcilePendingWrites` with nothing left
   * at the one moment the device had proved it was listening: a correct warning
   * and no second attempt, which is worse than not resending blind at all.
   *
   * Only for a write to a device already known to be off, where silence is
   * worth acting on. Measurement on an AC0850 settled what that silence means:
   * a wake-up that lands is answered fast, once in a single second by a device
   * that had said nothing for 53 minutes, because turning a purifier on wakes
   * it and it starts talking. So a wake-up still unanswered a window later was
   * very likely never received, which is the case a resend can actually fix.
   *
   * A responsive device that has gone quiet is a different problem: it has
   * already been answering, so silence there is freshness rather than a lost
   * command, and doubling every write on every unmeasured model would not fix
   * it.
   *
   * The window comparison is what keeps the two deadlines distinct: a
   * refreshInterval long enough to push verifyWindow past offStallTimeout
   * leaves no room before the give-up, so there is no unprompted resend to make.
   *
   * @param {PendingWrite} pending
   */
  blindEligible(pending) {
    return pending.knownOff && !pending.blindResent && pending.window > this.verifyWindow;
  }

  /**
   * When the sweep next has something to do about a write. Kept next to
   * armVerifyTimeout so the timer and expirePendingWrites cannot disagree about
   * when a write is due.
   *
   * @param {PendingWrite} pending
   */
  nextVerifyDeadline(pending) {
    return pending.recordedAt + (this.blindEligible(pending) ? this.verifyWindow : pending.window);
  }

  /**
   * Reconciles pending writes against a status the device has just sent.
   *
   * Three rules, all model-independent unlike the timings: only a status that
   * arrived *after* the write says anything about it, only a status that
   * mentions the key says anything about that key, and only a disagreement
   * proves the write was lost. A window passing in silence proves nothing.
   *
   * @param {number} receivedAt
   */
  reconcilePendingWrites(receivedAt) {
    if (!this.pendingWrites.size) {
      return;
    }

    //commands to resend once the pass is over, deduplicated: one can answer
    //several keys. Collected rather than sent from inside the loop, because a
    //status that contradicts two different commands would otherwise fire both
    //at once, which is the race the recovery path exists to undo
    /** @type {string[][]} */
    const resend = [];
    const queued = new Set();

    for (const [key, pending] of [...this.pendingWrites]) {
      //a status already in flight when the write was sent cannot have observed
      //it, and `since` carries a settling allowance so that one composed just as
      //the packet landed is discounted too. Erring this way costs at most a
      //skipped push; erring the other way reported a write the device applied
      if (receivedAt < pending.since) {
        continue;
      }

      //silence about a key is not disagreement with it: a status that never
      //mentions the key says exactly as much about the write as one sent before
      //it did. treating absent as unequal reported writes that were never lost
      if (!(key in this.obj)) {
        continue;
      }

      //the loose comparison rotationSpeed uses: device values arrive as strings
      //where the model maps hold numbers
      if ((this.obj[key] ?? '').toString() === (pending.expected ?? '').toString()) {
        this.pendingWrites.delete(key);
        this.loggedWriteFailure = false;
        continue;
      }

      if (pending.attempts < this.maxWriteRetries) {
        pending.attempts += 1;

        logger.debug(
          `Device reports ${key}=${this.obj[key]}, resending ${key}=${pending.expected}`,
          this.accessory.displayName
        );

        if (!queued.has(pending.args.join(' '))) {
          queued.add(pending.args.join(' '));
          resend.push(pending.args);
        }
        continue;
      }

      this.pendingWrites.delete(key);
      this.reportWriteFailure(key, pending);
    }

    if (resend.length) {
      this.resendInTurn(resend);
    }

    clearTimeout(this.verifyTimeout);
    this.verifyTimeout = null;
    this.armVerifyTimeout();
  }

  /**
   * Every pending write a command carries.
   *
   * The command rather than the key is what all of this acts on, because one
   * `set` can carry several: an AC0850 speed is `D0310A` and `D0310C` together,
   * recorded as two pending writes sharing one argv. Working per key would fire
   * that one command once per key, and #77 saw a scene write lost under exactly
   * that shape, two `set` processes racing at a device that serves one
   * connection.
   *
   * @param {string[]} args
   * @returns {[string, PendingWrite][]}
   */
  writesFor(args) {
    const command = args.join(' ');

    return [...this.pendingWrites].filter(([, pending]) => pending.args.join(' ') === command);
  }

  /**
   * Holds a command's writes open until it has actually been transmitted.
   * Nothing the device sent before then is evidence about it, and `since` is
   * what reconcilePendingWrites measures an incoming status against.
   *
   * @param {string[]} args
   */
  holdWrites(args) {
    this.writesFor(args).forEach(([, pending]) => {
      pending.since = Infinity;
    });
  }

  /**
   * Opens that horizon again, a settling allowance after the command went on
   * the wire rather than the instant it did. The device does not answer a
   * fire-and-forget packet, it just keeps pushing status, and a push already on
   * its way when the packet lands still carries the old value. See WRITE_SETTLE
   * for what treating that as a contradiction cost on hardware.
   *
   * @param {string[]} args
   */
  markWriteSent(args) {
    const sentAt = Date.now() + this.writeSettle;

    this.writesFor(args).forEach(([, pending]) => {
      pending.since = sentAt;
    });
  }

  /**
   * Gives up on every write a command carries, and puts HomeKit back to what
   * the device last reported. The setters update characteristics before the
   * command is on the wire, so a command that never left the host would
   * otherwise leave the Home app showing a state the device never reached.
   *
   * @param {string[]} args
   */
  abandonWrite(args) {
    this.writesFor(args).forEach(([key]) => {
      this.pendingWrites.delete(key);
      this.revertOptimisticUpdate(key);
    });
  }

  /**
   * Puts a command back on the wire, leaving the writes it carries pending.
   *
   * Callers do not await the send itself: the answer arrives as another status
   * line, not as an exit code.
   *
   * @param {string[]} args the command to resend
   * @returns {Promise<void>} settles when the command has been sent
   */
  resendWrite(args) {
    this.holdWrites(args);

    return this.sendCMD(args)
      .then(() => this.markWriteSent(args))
      .catch((err) => {
        this.abandonWrite(args);
        logger.error(err, this.accessory.displayName);
      });
  }

  /**
   * Puts the wake-up at the end of a batch.
   *
   * Two mechanisms could explain what issue #77 measured, and the evidence
   * cannot separate them. Under *contention*, two overlapping handshakes at a
   * one-connection device, order does not matter. Under *wake disturbance*, the
   * command that wakes the device has to be the last thing it hears, and a
   * second handshake arriving while it wakes knocks it over. So ordering the
   * wake-up last is a no-op if the first is true and load-bearing if the second
   * is, which makes it adoptable without knowing which.
   *
   * The rescue that was observed working sent speed first and power last, but
   * only by chance: insertion order used to be decided by which child process
   * exited first. Deterministic order also means a failure can be reproduced.
   *
   * Read off the pending write rather than by naming registers, so this needs
   * no per-model code, and only for a power-*on*: switching a device off cannot
   * wake it, so nothing about that write wants to go last.
   *
   * @param {string[][]} commands
   * @returns {string[][]}
   */
  orderPowerLast(commands) {
    const wake = this.pendingWrites.get('pwr');

    if (!wake || Number(wake.expected) !== 1) {
      return commands;
    }

    const command = wake.args.join(' ');
    const rest = commands.filter((args) => args.join(' ') !== command);

    return rest.length === commands.length ? commands : [...rest, wake.args];
  }

  /**
   * Sends a sweep's worth of resends one at a time, wake-up last. Firing them
   * together would be the very race that recovery is here to undo.
   *
   * @param {string[][]} commands
   */
  async resendInTurn(commands) {
    const batch = this.orderPowerLast(commands);

    //the whole batch's horizon closes up front rather than as each command is
    //reached: a status arriving while a later one waits its turn predates that
    //command going back on the wire, so it is not evidence about it
    batch.forEach((args) => this.holdWrites(args));

    for (const args of batch) {
      await this.resendWrite(args);
    }
  }

  /**
   * Drops writes the device never spoke to, and resends a wake-up once on the
   * way. What silence means depends on which device it came from, so see
   * reportWriteExpiry for which of these is worth telling the user about.
   */
  expirePendingWrites() {
    const now = Date.now();
    /** @type {string[][]} */
    const resend = [];
    const queued = new Set();

    //one unprompted resend on the way, at the window a responsive device would
    //have answered by. A `set` is a single unacknowledged packet, and resending
    //one costs a beep the device makes anyway; a wake-up command that was simply
    //dropped has nothing else that will ever notice.
    //
    //Once any of them is due they all go, so that a scene is one ordered batch
    //rather than a sweep per key. Each write's deadline is its own recordedAt
    //plus the window, and the setters record milliseconds apart, so judging them
    //separately split a power and a speed across two sweeps ordered by whichever
    //was recorded first: exactly the ordering resendInTurn exists to decide. The
    //cost is that a write recorded shortly before the sweep is resent a little
    //early, which is one more idempotent packet to a device already known to be
    //off, and blindResent still caps it at one per write
    const blindDue = [...this.pendingWrites.values()].some(
      (pending) => this.blindEligible(pending) && now - pending.recordedAt >= this.verifyWindow
    );

    for (const [key, pending] of [...this.pendingWrites]) {
      if (blindDue && this.blindEligible(pending)) {
        //flagged before the send, so nothing re-entrant can fire it twice
        pending.blindResent = true;

        logger.debug(
          `Nothing has answered ${key}=${pending.expected} while the device is off, resending it`,
          this.accessory.displayName
        );

        if (!queued.has(pending.args.join(' '))) {
          queued.add(pending.args.join(' '));
          resend.push(pending.args);
        }
        continue;
      }

      //each write owns its deadline: the timer is re-armed by every status, and
      //a device that keeps talking about other keys would otherwise hold a
      //pending write open indefinitely. the resend above does not move it, so
      //the give-up stays anchored to the original command
      if (now - pending.recordedAt < pending.window) {
        continue;
      }

      this.pendingWrites.delete(key);
      this.reportWriteExpiry(key, pending);
      this.revertOptimisticUpdate(key);
    }

    if (resend.length) {
      this.resendInTurn(resend);
    }
  }

  /**
   * Puts HomeKit back to what the plugin believes, for a write that has been
   * given up on.
   *
   * The setters update characteristics before the command is even on the wire,
   * because HomeKit expects an answer promptly and the device cannot give one.
   * That is fine while the write is still live, and wrong once it is not: the
   * Home app was left reporting PURIFYING_AIR for a purifier the plugin knew
   * was off, and stayed wrong until a real status happened to arrive, which for
   * an off device can be the better part of an hour (issue #77).
   *
   * `this.obj` is only ever assigned from a device status, so this publishes a
   * reading rather than a guess, and a device that has never answered has no
   * reading to publish. Every value here is the same expression processUpdate
   * pushes, so a reverted characteristic and a status-driven one agree.
   *
   * Only reached from expirePendingWrites. The other way a write is given up,
   * retries exhausted in reconcilePendingWrites, needs nothing: it runs from
   * processUpdate, and the status push immediately after it corrects HomeKit
   * from the very status that proved the write lost.
   *
   * Both exits say so, because neither is visible anywhere else. The revert
   * publishes the last reading, and a HomeKit that has abandoned the write has
   * already fallen back to that same value, so the tile looks identical whether
   * this ran or not. Measured on hardware over 11h35m without once being able
   * to tell which had happened.
   *
   * @param {string} key the generic key whose write was abandoned
   */
  revertOptimisticUpdate(key) {
    if (!this.everAnswered()) {
      logger.debug(
        `Leaving HomeKit's ${key} as it is, the device has never reported a reading to go back to`,
        this.accessory.displayName
      );
      return;
    }

    //the key is generic key space, which on some models is a register the
    //device need not have reported, so the reading is a suffix rather than an
    //`undefined` in the middle of the line
    const reading = key in this.obj ? ` (${this.obj[key]})` : '';

    logger.debug(
      `Putting HomeKit's ${key} back to the last reading the device gave${reading}`,
      this.accessory.displayName
    );

    const Characteristic = this.api.hap.Characteristic;
    const on = !!parseInt(this.obj.pwr);

    if (this.purifierService) {
      if (key === 'pwr') {
        this.purifierService
          .updateCharacteristic(Characteristic.Active, on ? 1 : 0)
          .updateCharacteristic(Characteristic.CurrentAirPurifierState, on ? 2 : 0);
      }

      if (key === 'mode' && this.supports('mode')) {
        this.purifierService.updateCharacteristic(Characteristic.TargetAirPurifierState, this.obj.mode === 'M' ? 0 : 1);
      }

      //the speed is spread across whichever keys the model maps it to, so ask
      //the model rather than naming them here
      if (this.speeds.some((speedConfig) => key in speedConfig)) {
        this.purifierService.updateCharacteristic(Characteristic.RotationSpeed, this.rotationSpeed());
      }
    }

    if (this.humidifierService && (key === 'func' || key === 'rhset')) {
      const watered = !(this.obj.func == 'PH' && this.obj.wl == 0);
      const humidifying = on && this.obj.func === 'PH';

      this.humidifierService
        .updateCharacteristic(Characteristic.Active, humidifying ? 1 : 0)
        .updateCharacteristic(Characteristic.CurrentHumidifierDehumidifierState, humidifying ? 2 : 0)
        .updateCharacteristic(
          Characteristic.RelativeHumidityHumidifierThreshold,
          humidifying && watered ? this.humidityThreshold() : 0
        );
    }
  }

  /**
   * Reports a write that ran out of window without the device ever speaking to
   * it. The two silences this can be are not the same thing.
   *
   * From a device that was answering, silence past the window means this model
   * answers more slowly than the one the delays were chosen against. That is a
   * freshness problem rather than a lost command, and reporting it would turn
   * every unmeasured model into a warning loop, so it stays at debug.
   *
   * From a device the plugin knew was off, it is the opposite. A wake-up that
   * lands is answered quickly, even by a device that had been quiet for the
   * best part of an hour, so silence here is not the device being slow. The
   * plugin has asked twice across the whole backstop the stall detector allows
   * and heard nothing back at all, which on the evidence means the command
   * never arrived. A silent drop there is how an arrive-home automation fails
   * with nothing in the log (issue #77).
   *
   * Latched on the same flag as reportWriteFailure, since an automation that
   * keeps failing should report once rather than on every cycle.
   *
   * @param {string} key
   * @param {PendingWrite} pending
   */
  reportWriteExpiry(key, pending) {
    const waited = Math.round(pending.window / 1000);

    if (!pending.knownOff) {
      logger.debug(
        `No status covering ${key}=${pending.expected} arrived within ${waited}s`,
        this.accessory.displayName
      );
      return;
    }

    const sends = 1 + pending.attempts + (pending.blindResent ? 1 : 0);
    const summary =
      `The device never answered ${key}=${pending.expected} in ${waited}s while switched off, ` +
      `after ${sends} attempts. The command was most likely lost; see README Troubleshooting.`;

    if (this.loggedWriteFailure) {
      logger.debug(summary, this.accessory.displayName);
      return;
    }

    this.loggedWriteFailure = true;
    logger.warn(summary, this.accessory.displayName);
  }

  /**
   * Reports a write the device demonstrably did not apply: it answered, and its
   * answer disagrees. Latched like reportPollFailure, since the HomeKit
   * automation that produced it will keep producing it.
   *
   * The message says what was observed and no more. It used to name a lost
   * packet as the likely cause, which the plugin cannot see and which was wrong
   * in the one case anybody has watched from both ends: the device beeped for
   * every command it was sent (issue #77). Where a status has come back and
   * disagrees, the device is the place to look, not the network.
   *
   * @param {string} key
   * @param {{ expected: unknown, attempts: number }} pending
   */
  reportWriteFailure(key, pending) {
    const summary =
      `The device did not apply ${key}=${pending.expected} after ${pending.attempts + 1} attempts ` +
      `(it reports ${this.obj[key]}). It answered each time, so the command reached it and was ` +
      'not acted on; see README Troubleshooting.';

    if (this.loggedWriteFailure) {
      logger.debug(summary, this.accessory.displayName);
      return;
    }

    this.loggedWriteFailure = true;
    logger.warn(summary, this.accessory.displayName);
  }

  /**
   * Elicits a reading by re-subscribing. A second `aioairctrl` process cannot
   * be used to read back: the device serves one connection at a time and
   * answers a competing client with nothing. A *fresh* subscription is
   * answered, which is the only prompt read-back available.
   */
  requestRefresh() {
    if (this.shutdown || this.refreshing || this.restartTimeout || !this.airControl) {
      return;
    }

    logger.debug('Requesting a fresh reading from the device', this.accessory.displayName);
    this.refreshing = true;
    this.refreshKilledAt = Date.now();
    this.airControl.kill();
  }

  //Longpoll Process
  longPoll() {
    this.purifierService = this.accessory.getService(this.api.hap.Service.AirPurifier);
    this.humidifierService = this.accessory.getService('Humidifier');
    this.temperatureService = this.accessory.getService('Temperature Sensor');
    this.humidityService = this.accessory.getService('Humidity Sensor');
    this.lightService = this.accessory.getService('Light');

    this.airQualityService = this.accessory.getService('Air Quality');
    this.preFilterService = this.accessory.getService('Pre Filter');
    this.carbonFilterService = this.accessory.getService('Active carbon filter');
    this.hepaFilterService = this.accessory.getService('HEPA filter');
    this.wickFilterService = this.accessory.getService('Wick filter');

    clearTimeout(this.processTimeout);
    clearTimeout(this.refreshTimeout);
    this.refreshTimeout = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stderrPartial = '';
    this.receivedData = false;
    this.stalled = false;
    this.stalledWhileOff = false;
    this.spawnFailed = false;
    this.refreshing = false;

    const child = spawn(this.binary, [...this.args, 'status-observe', '-J']);
    this.airControl = child;

    child.stdout.on('data', (data) => this.handleStdoutChunk(data));

    child.stderr.on('data', (data) => {
      const text = data.toString();

      this.captureStderr(text);
      logger.debug(text, this.accessory.displayName);
    });

    child.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
      const unrunnable = err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM';
      const error = unrunnable ? this.unrunnableBinaryError(err.code) : err;

      //'error' also fires on an already-running child, e.g. a kill that failed.
      //only a child that never started is a spawn failure; anything else must
      //still count toward the escalation threshold in 'close'
      const spawnFailure = child.pid === undefined;
      this.spawnFailed = spawnFailure;

      //a command that could not be started and one that would not stop are
      //different faults with the same event. calling the second one a failure
      //to run sends the reader after an aioairctrl install that is working
      const kind = spawnFailure ? 'spawn' : 'stop';

      //the summary has to stand on its own: 'error' carries the remedy, and a
      //user who set error:false to quieten a chatty device would otherwise be
      //left with a line that names neither the command nor what to do about it
      const summary = spawnFailure
        ? `Failed to run '${this.binary}' — see the startup log for how to fix the install`
        : 'Failed to stop the polling process';

      //only log the first failure of its kind in a retry loop to avoid spamming
      if (this.loggedFailureKind === kind) {
        logger.debug(error, this.accessory.displayName);
      } else {
        this.loggedFailureKind = kind;
        logger.warn(summary, this.accessory.displayName);
        logger.error(error, this.accessory.displayName);
      }

      this.scheduleRestart(spawnFailure ? this.spawnErrorRestartDelay : this.restartDelay);
    });

    child.on('close', (code) => {
      clearTimeout(this.processTimeout);
      this.processTimeout = null;

      logger.debug(
        `airControl process exited with code ${code} (${this.shutdown ? 'expected' : 'not expected'})`,
        this.accessory.displayName
      );

      if (this.shutdown) {
        return;
      }

      //a stream torn down on purpose has not failed, even if it produced
      //nothing before it was killed: the refresh elicits a reading, and the
      //off-state backstop only guards against a subscription that died unseen
      if (!this.receivedData && !this.spawnFailed && !this.refreshing && !this.stalledWhileOff) {
        this.pollFailures += 1;
        this.reportPollFailure(code);
      }

      logger.debug('Restarting polling process', this.accessory.displayName);
      this.scheduleRestart(this.restartDelay);
    });

    this.armStallTimeout();
  }

  /**
   * Keeps a bounded copy of what a failing process wrote to stderr, so that it
   * can explain itself when it dies without producing status. A Python
   * traceback is the whole diagnosis and it arrives last, so this keeps the
   * tail.
   *
   * The CLI's own progress records are dropped here rather than at report time,
   * so that with `debug` enabled its continuous chatter cannot push a real
   * diagnostic out of the budget. Only whole lines are judged: a Python crash
   * writes its traceback to stderr raw, after whatever the logger last wrote,
   * and swallowing that because the line above it was a `DEBUG:` record would
   * be far worse than keeping a stray continuation line.
   *
   * @param {string} text
   */
  captureStderr(text) {
    const lines = (this.stderrPartial + text).split('\n');

    //a CLI writing without newlines would otherwise grow this without bound
    this.stderrPartial = lines.pop().slice(-MAX_STDERR_CAPTURE);

    const kept = lines.filter((line) => !CLI_PROGRESS_LINE.test(line));

    if (kept.length) {
      this.stderrBuffer = (this.stderrBuffer + kept.join('\n') + '\n').slice(-MAX_STDERR_CAPTURE);
    }
  }

  /**
   * What of the captured stderr is worth showing a user. The trailing partial
   * line is included: a traceback's last line can arrive without a newline
   * before the process exits, and it is the line that names the exception.
   */
  reportableStderr() {
    const partial = CLI_PROGRESS_LINE.test(this.stderrPartial) ? '' : this.stderrPartial;

    return (this.stderrBuffer + partial).slice(-MAX_STDERR_CAPTURE).trim();
  }

  /**
   * Reports a poll that returned no status at all. Without this the plugin
   * respawns forever in silence: a broken `aioairctrl` install exits non-zero
   * on every attempt, and at debug level that looks identical to a device that
   * simply has nothing new to say.
   *
   * @param {number | null} code
   */
  reportPollFailure(code) {
    //a stall on a device that has never answered is already conclusive: the
    //subscription was accepted and nothing ever arrived, so it may be unplugged,
    //renumbered or on another network, and the first stall is the whole
    //diagnosis (#48). A device that *has* answered and then went quiet is a
    //different claim, and one that recovers on its own: 21 of them in a night on
    //an AC0850, every one self-recovered, all reported with the same "check that
    //the purifier is powered on" alarm as an unplugged one (#62). That waits for
    //the threshold like any other no-data close.
    const escalate = (this.stalled && !this.everAnswered()) || this.pollFailures >= FAILURE_ESCALATION_THRESHOLD;
    const kind = this.stalled ? 'stall' : 'exit';

    const summary = this.stalled
      ? `No status received from the device within ${Math.round(this.stallTimeout / 1000)}s. Check that the purifier is powered on and that 'host' and 'port' are correct.`
      : `The polling process exited with code ${code} without returning any status (attempt ${this.pollFailures}). Check that '${this.binary}' runs as the Homebridge user (see README Troubleshooting).`;

    //a failure of a kind already warned about is repetition; a new kind means
    //the fault has changed and the user has not been told about this one
    if (!escalate || this.loggedFailureKind === kind) {
      logger.debug(summary, this.accessory.displayName);
      return;
    }

    this.loggedFailureKind = kind;
    logger.warn(summary, this.accessory.displayName);

    const stderr = this.reportableStderr();

    if (stderr) {
      logger.error(new Error(`${this.binary} wrote: ${stderr}`), this.accessory.displayName);
    }
  }

  /**
   * Asks the device for a fresh reading once its own reporting goes quiet.
   *
   * Armed only from `processUpdate`, never from `longPoll`, and that is the
   * whole safety argument: the interval measures the time since a *reading*, so
   * a subscription that has not been answered yet is never killed, and an
   * interval shorter than a slow model's response latency degrades into wasted
   * waiting rather than into starvation. A device that pushes on its own faster
   * than the interval re-arms this before it ever fires.
   */
  armRefreshTimeout() {
    clearTimeout(this.refreshTimeout);
    this.refreshTimeout = null;

    if (!this.refreshInterval) {
      return;
    }

    this.refreshTimeout = setTimeout(() => {
      this.refreshTimeout = null;
      this.requestRefresh();
    }, this.refreshDelay());
  }

  /**
   * How long the plugin currently waits after a reading before re-subscribing:
   * what a refresh is measured to cost on this device, held between the
   * configured interval as a floor and the stall timeout as a ceiling. Past the
   * ceiling the fault detector tears the stream down anyway, so a refresh that
   * waited longer could never fire.
   */
  refreshDelay() {
    if (!this.refreshInterval) {
      return 0;
    }

    const cost = this.refreshCost === null ? this.refreshInterval : this.refreshCost;

    return Math.min(Math.max(cost, this.refreshInterval), this.stallTimeout);
  }

  /**
   * Prices the last refresh and adjusts how eager the next one is.
   *
   * Re-subscribing is a trade: it elicits a reading, and on some models it costs
   * far more than waiting for the device to push one. An AC0850 answers an
   * untouched stream every ~9 s but takes 140 s at the median to answer a
   * replacement subscription, so a refresh sized below its quiet period made
   * HomeKit *staler* (issue #71). Rather than replace one constant read off one
   * purifier with another, the interval follows what re-subscribing actually
   * costs here:
   *
   * The estimate is a smoothed average of what refreshes have actually cost,
   * and the wait is set to it directly. An earlier rule doubled and halved a
   * multiplier instead, comparing each cost against the current wait: back off
   * above it, come down at or below half of it. That cannot settle. A fixed
   * point needs the cost distribution to fall inside a deadband one octave wide,
   * and this hardware's is bimodal, so the multiplier flipped indefinitely -- 88
   * changes over 4.5 days on a live AC0850, a median of 19 minutes apart, 43 of
   * them the same 60s/120s pair. Half of that oscillation sat at the configured
   * floor, which is the eagerness #71 exists to avoid.
   *
   * Averaging the cost removes the deadband, so a bimodal signal produces one
   * wait between its modes rather than a flip across them. It settles into a
   * band rather than onto a point, since the input keeps moving, but the band is
   * a fraction of the octave the multiplier swung through.
   *
   * @param {number} receivedAt
   */
  adaptRefresh(receivedAt) {
    const killedAt = this.refreshKilledAt;

    this.refreshKilledAt = null;

    if (!killedAt || !this.refreshInterval) {
      return;
    }

    //a refresh that outran the fault detector says the same thing as one that
    //merely reached it, and clamping keeps a single outlier -- 1725s was
    //measured -- from sitting in the average for a dozen refreshes afterwards
    const cost = Math.min(receivedAt - killedAt, this.stallTimeout);
    const before = this.refreshDelay();
    const estimate = this.refreshCost === null ? this.refreshInterval : this.refreshCost;
    const weight = cost > estimate ? REFRESH_COST_RISE : REFRESH_COST_FALL;

    this.refreshCost = estimate + weight * (cost - estimate);

    const delay = this.refreshDelay();

    //every refresh moves the estimate, so logging each one would be noisier than
    //the rule it replaced. only a wait that moved enough to change behaviour is
    //worth a line
    if (Math.abs(delay - before) >= before / 5) {
      logger.debug(
        `Re-subscribing took ${Math.round(cost / 1000)}s against a ${Math.round(before / 1000)}s wait, ` +
          `asking for a fresh reading after ${Math.round(delay / 1000)}s from now on`,
        this.accessory.displayName
      );
    }
  }

  /**
   * Whether the device has ever answered. `this.obj` is assigned only from a
   * device status in `handleResponse`, never optimistically from a write, so an
   * empty one says the plugin has never heard from this device at all. It is
   * deliberately not `receivedData`, which is reset on every restart: what was
   * once known outlives the stream that reported it.
   */
  everAnswered() {
    return Object.keys(this.obj).length > 0;
  }

  /**
   * Whether the device has told us it is switched off. Model-independent:
   * `handleResponse` maps every dialect's registers back into generic key
   * space, so `pwr` is the generic key on all of them, the same basis
   * `processUpdate` uses to drive the Active characteristic.
   *
   * A device that has never answered is deliberately *not* known to be off: it
   * may be unplugged, misconfigured or on another network, which is exactly
   * what the stall warning exists to report. `this.obj` is empty until the
   * first status arrives, which says that on its own. It is deliberately not
   * `receivedData`, which is reset on every restart: the last known power
   * outlives the stream that reported it, and has to, since every off-state
   * stall is judged on a stream that has itself answered nothing yet.
   */
  deviceKnownOff() {
    return this.obj.pwr !== undefined && !parseInt(this.obj.pwr);
  }

  /**
   * How long the stall detector waits, measured from the last *reading* rather
   * than from the process now running.
   *
   * Armed at spawn it measured "this subscription has not been answered yet",
   * which with a refresh cutting in at 60 s made every stall fire at 365 s
   * rather than the 300 s the constant claims (issue #71). A device that has
   * never answered has no reading to measure from, and that is precisely the
   * case the warning exists for (#48), so it still gets the full timeout.
   *
   * The floor is what stops a deadline that is already past from killing every
   * replacement subscription before it can answer: a fresh stream gets at least
   * as long as the refresh is currently willing to wait for a reading. That is
   * for a deadline overrun by something *other* than a stall, such as a refresh
   * whose replacement was slow to be answered.
   *
   * A stall that has already been acted on is spent, so the clock runs from the
   * teardown as much as from the last reading. Measured from the reading alone
   * the deadline stays permanently past on a device that is not answering, so
   * every later arm falls through to the floor: that is how the 30 min
   * off-state backstop degraded into a teardown every 5 min, six times the rate
   * the constant claims, for as long as the purifier stayed switched off.
   */
  stallDelay() {
    const timeout = this.deviceKnownOff() ? this.offStallTimeout : this.stallTimeout;
    const since = Math.max(this.lastReadingAt || 0, this.lastStallAt || 0);
    const elapsed = since ? Date.now() - since : 0;
    const grace = this.refreshInterval ? Math.min(this.refreshDelay(), timeout) : timeout;

    return Math.max(timeout - elapsed, grace);
  }

  /**
   * Restarts the observe stream when the device goes quiet for far longer than
   * a refresh cycle can account for. Re-armed by every status line, so this is
   * a fault detector rather than a poll: the refresh above is what keeps an
   * idle device fresh.
   *
   * A device that reports itself switched off gets a much longer timeout and no
   * failure report, because silence from one is not a fault: these purifiers
   * answer only intermittently while off, and tearing the subscription down
   * does not make them answer sooner. The regime is chosen at arm time, so it
   * follows the device within one status of it being switched on or off.
   */
  armStallTimeout() {
    clearTimeout(this.processTimeout);

    const off = this.deviceKnownOff();
    const delay = this.stallDelay();

    this.processTimeout = setTimeout(() => {
      if (this.airControl) {
        const silence = this.lastReadingAt ? Date.now() - this.lastReadingAt : delay;

        logger.debug(
          `No status received for ${Math.round(silence / 1000)}s${off ? ' while the device is off' : ''}, restarting the polling process`,
          this.accessory.displayName
        );
        this.stalled = true;
        this.stalledWhileOff = off;
        this.lastStallAt = Date.now();
        //a refresh whose replacement subscription was never answered cost more
        //than any wait would have, which is the strongest evidence there is
        //that this device is not worth re-subscribing to so eagerly
        this.adaptRefresh(Date.now());
        this.airControl.kill();
      }
    }, delay);
  }

  handleStdoutChunk(data) {
    this.stdoutBuffer += data.toString();

    if (this.stdoutBuffer.length > MAX_STDOUT_BUFFER) {
      logger.warn('Device response exceeded buffer limit, discarding buffered data', this.accessory.displayName);
      this.stdoutBuffer = '';
      return;
    }

    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop();

    for (const line of lines) {
      if (line.trim()) {
        this.processUpdate(line);
      }
    }
  }

  scheduleRestart(delay) {
    if (this.shutdown || this.restartTimeout) {
      return;
    }

    this.restartTimeout = setTimeout(() => {
      this.restartTimeout = null;
      this.longPoll();
    }, delay);
  }

  async processUpdate(line) {
    const receivedAt = Date.now();

    //a line arriving proves the stream is alive, whether or not it parses, so
    //both the stall deadline and the price of the last refresh date from here
    this.lastReadingAt = receivedAt;
    this.adaptRefresh(receivedAt);

    if (this.airControl && !this.shutdown) {
      this.armStallTimeout();
      this.armRefreshTimeout();
    }

    try {
      const response = JSON.parse(line);

      //only a parseable status proves the device is healthy. a CLI that writes
      //a traceback to stdout instead of stderr would otherwise clear the
      //failure counters on every retry and never escalate
      this.receivedData = true;
      this.pollFailures = 0;
      this.loggedParseFailure = false;

      if (this.loggedFailureKind) {
        this.loggedFailureKind = null;
        logger.info('Device is responding again', this.accessory.displayName);
      }

      this.handleResponse(response);
    } catch (err) {
      //the brake the poll path already has, for the same reason. this normally
      //never fires, since the CLI writes only status JSON to stdout, but if it
      //ever began writing something else continuously that would be two log
      //entries per line for as long as it lasted, filling a disk and burying
      //everything else. the first one is the one worth seeing
      if (this.loggedParseFailure) {
        logger.debug('Failed to parse device response', this.accessory.displayName);
        logger.debug(err, this.accessory.displayName);
        return;
      }

      this.loggedParseFailure = true;
      logger.warn('Failed to parse device response', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
      return;
    }

    //outside the parse guard above: a failure in here is not a parse failure,
    //and must not be reported as one
    this.reconcilePendingWrites(receivedAt);

    try {
      //Air Purifier
      this.purifierService
        .updateCharacteristic(this.api.hap.Characteristic.Active, parseInt(this.obj.pwr) ? 1 : 0)
        .updateCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState, parseInt(this.obj.pwr) ? 2 : 0)
        .updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.rotationSpeed());

      //pushing these from a key the model never reports would push a default,
      //not a reading: 'mode' absent reads as AUTO and 'cl' absent as unlocked
      if (this.supports('mode')) {
        this.purifierService.updateCharacteristic(
          this.api.hap.Characteristic.TargetAirPurifierState,
          this.obj.mode === 'M' ? 0 : 1
        );
      }

      if (this.supports('cl')) {
        this.purifierService.updateCharacteristic(
          this.api.hap.Characteristic.LockPhysicalControls,
          this.obj.cl ? 1 : 0
        );
      }

      if (this.airQualityService) {
        //HomeKit AirQuality only accepts 0 (unknown) to 5 (poor)
        const airQuality = Math.min(Math.max(Math.ceil(this.obj.iaql / 3) || 0, 0), 5);

        this.airQualityService
          .updateCharacteristic(this.api.hap.Characteristic.AirQuality, airQuality)
          .updateCharacteristic(this.api.hap.Characteristic.PM2_5Density, hapNumber(this.obj.pm25, 0, 1000));
      }

      if (this.temperatureService) {
        this.temperatureService.updateCharacteristic(
          this.api.hap.Characteristic.CurrentTemperature,
          hapNumber(this.obj.temp, -270, 100)
        );
      }

      if (this.humidityService) {
        this.humidityService.updateCharacteristic(
          this.api.hap.Characteristic.CurrentRelativeHumidity,
          hapNumber(this.obj.rh, 0, 100)
        );
      }

      if (this.lightService) {
        if (this.obj.pwr == '1') {
          this.lightService
            .updateCharacteristic(this.api.hap.Characteristic.On, this.obj.aqil > 0)
            .updateCharacteristic(this.api.hap.Characteristic.Brightness, hapNumber(this.obj.aqil, 0, 100));
        } else {
          this.lightService.updateCharacteristic(this.api.hap.Characteristic.On, false);
        }
      }

      if (this.humidifierService) {
        let water_level = 100;
        let speed_humidity = 0;

        if (this.obj.func == 'PH' && this.obj.wl == 0) {
          water_level = 0;
        }

        if (this.obj.pwr == '1') {
          if (this.obj.func == 'PH' && water_level == 100) {
            speed_humidity = this.humidityThreshold();
          }
        }

        this.humidifierService
          .updateCharacteristic(
            this.api.hap.Characteristic.Active,
            parseInt(this.obj.pwr) ? (this.obj.func === 'PH' ? 1 : 0) : 0
          )
          .updateCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity, hapNumber(this.obj.rh, 0, 100))
          .updateCharacteristic(this.api.hap.Characteristic.WaterLevel, water_level)
          .updateCharacteristic(this.api.hap.Characteristic.TargetHumidifierDehumidifierState, 1)
          .updateCharacteristic(this.api.hap.Characteristic.RelativeHumidityHumidifierThreshold, speed_humidity);

        if (water_level == 0) {
          if (this.obj.func != 'P') {
            await this.setPurifierTargetState(true);
          }

          this.humidifierService
            .updateCharacteristic(this.api.hap.Characteristic.Active, 0)
            .updateCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState, 0)
            .updateCharacteristic(this.api.hap.Characteristic.RelativeHumidityHumidifierThreshold, 0);
        }

        if (this.wickFilterService && this.obj.wicksts !== undefined) {
          const fltwickchange = this.obj.wicksts == 0;
          const fltwicklife = hapNumber(Math.round((this.obj.wicksts / 4800) * 100), 0, 100);

          this.wickFilterService
            .updateCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, fltwickchange)
            .updateCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, fltwicklife);
        }
      }

      if (this.preFilterService && this.obj.fltsts0 !== undefined) {
        const fltsts0change = this.obj.fltsts0 == 0;
        const fltsts0maxlife = this.obj.flttotal0 ? this.obj.flttotal0 : 360;
        const fltsts0life = hapNumber((this.obj.fltsts0 / fltsts0maxlife) * 100, 0, 100);

        this.preFilterService
          .updateCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, fltsts0change)
          .updateCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, fltsts0life);
      }

      if (this.carbonFilterService && this.obj.fltsts2 !== undefined) {
        const fltsts2change = this.obj.fltsts2 == 0;
        const fltsts2maxlife = this.obj.flttotal2 ? this.obj.flttotal2 : 4800;
        const fltsts2life = hapNumber((this.obj.fltsts2 / fltsts2maxlife) * 100, 0, 100);

        this.carbonFilterService
          .updateCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, fltsts2change)
          .updateCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, fltsts2life);
      }

      if (this.hepaFilterService && this.obj.fltsts1 !== undefined) {
        const fltsts1change = this.obj.fltsts1 == 0;
        const fltsts1maxlife = this.obj.flttotal1 ? this.obj.flttotal1 : 4800;
        const fltsts1life = hapNumber((this.obj.fltsts1 / fltsts1maxlife) * 100, 0, 100);

        this.hepaFilterService
          .updateCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, fltsts1change)
          .updateCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, fltsts1life);
      }
    } catch (err) {
      logger.warn('Error updating characteristics from device response', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  kill(shutdown) {
    this.shutdown = shutdown || false;

    clearTimeout(this.processTimeout);
    clearTimeout(this.restartTimeout);
    clearTimeout(this.verifyTimeout);
    clearTimeout(this.refreshTimeout);
    this.processTimeout = null;
    this.restartTimeout = null;
    this.verifyTimeout = null;
    this.refreshTimeout = null;
    this.pendingWrites.clear();

    if (this.airControl) {
      logger.debug('Killing airControl process', this.accessory.displayName);
      this.airControl.kill();
    }
  }
}

module.exports = Handler;
