'use strict';

const { execFile, spawn } = require('child_process');

const logger = require('../utils/logger');
const { hapNumber } = require('../utils/utils');
const modelConfig = require('./accessories.models');

//status lines are small JSON objects; anything beyond this is a misbehaving
//device or CLI streaming data without newlines
const MAX_STDOUT_BUFFER = 1024 * 1024;

//the observe stream is torn down and respawned once the device has been silent
//for this long. this is an *idle* timer, reset by every status line, so a
//healthy stream is never interrupted: an AC0850 notifies roughly every 50s,
//which a fixed process lifetime races rather than supervises
const STALL_TIMEOUT = 120 * 1000;

//delay before respawning a stream that ended
const RESTART_DELAY = 5 * 1000;

//longer delay when the binary could not be executed at all, since retrying
//quickly cannot fix a missing or unrunnable command
const SPAWN_ERROR_RESTART_DELAY = 30 * 1000;

//how much of a failing process's stderr is kept so that it can be reported.
//aioairctrl's tracebacks are what tell a user their Python install is broken
const MAX_STDERR_CAPTURE = 4 * 1024;

//consecutive polls returning nothing before the plugin escalates from a debug
//line to a warning. a single dropped stream is normal; a run of them is not
const FAILURE_ESCALATION_THRESHOLD = 3;

//how long a write waits for the device to say something about it before the
//plugin elicits a reading. a bound the plugin chooses, not a device
//measurement: the only purifier these have been observed on is an AC0850
const VERIFY_REFRESH_DELAY = 30 * 1000;

//how long a write stays pending in total. a write still unconfirmed when this
//expires is only reported if the device actually answered and disagreed;
//silence means this model is slower than the one the delays were chosen
//against, which is a freshness problem rather than a lost command
const VERIFY_WINDOW = 90 * 1000;

//resends of a write the device answered and did not apply, before the user is
//told. one lost packet is unremarkable; two in a row is worth a warning
const MAX_WRITE_RETRIES = 1;

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
    this.receivedData = false;
    this.stalled = false;
    this.spawnFailed = false;
    this.refreshing = false;
    this.pollFailures = 0;
    //which kind of failure ('spawn' | 'exit' | 'stall') has already been warned
    //about, so a retry loop stays quiet without hiding a *different* failure
    /** @type {'spawn' | 'exit' | 'stall' | null} */
    this.loggedFailureKind = null;
    //writes waiting for the device to confirm them, keyed by the generic status
    //key each one sets. see recordWrite
    /** @type {Map<string, { expected: unknown, args: string[], attempts: number, since: number }>} */
    this.pendingWrites = new Map();
    this.verifyTimeout = null;
    //whether an unapplied write has already been warned about, so an automation
    //that keeps failing reports once rather than on every cycle
    this.loggedWriteFailure = false;
    this.obj = {};

    //instance fields rather than bare constants so tests can shorten the waits
    this.stallTimeout = STALL_TIMEOUT;
    this.restartDelay = RESTART_DELAY;
    this.spawnErrorRestartDelay = SPAWN_ERROR_RESTART_DELAY;
    this.verifyRefreshDelay = VERIFY_REFRESH_DELAY;
    this.verifyWindow = VERIFY_WINDOW;
    this.maxWriteRetries = MAX_WRITE_RETRIES;

    const { speeds, keyMaps, valueMaps, extraSetFlags } = modelConfig(this.accessory.context.config);
    this.speeds = speeds;
    this.keyMaps = keyMaps;
    this.valueMaps = valueMaps;
    this.extraSetFlags = extraSetFlags;

    this.binary = this.accessory.context.config.aioairctrlPath || 'aioairctrl';
    this.args = [
      '-H',
      this.accessory.context.config.host,
      '-P',
      String(this.accessory.context.config.port),
      this.accessory.context.config.debug ? '-D' : '',
    ].filter((cmd) => cmd);
  }

  missingBinaryError() {
    return new Error(
      `${this.binary} not found. Install it with 'pipx install aioairctrl' and make sure the Homebridge user can run it, or set 'aioairctrlPath' in the platform config to its full path (see README).`
    );
  }

  /**
   * @param {string[]} args
   * @returns {Promise<void>}
   */
  sendCMD(args) {
    logger.debug(`CMD: ${this.binary} ${args.join(' ')}`, this.accessory.displayName);

    return new Promise((resolve, reject) => {
      execFile(this.binary, args, (err, stdout, stderr) => {
        if (err) {
          return reject(err.code === 'ENOENT' ? this.missingBinaryError() : err);
        }

        logger.debug(stderr, this.accessory.displayName);
        resolve();
      });
    });
  }

  handleResponse(json) {
    this.obj = json;

    Object.entries(this.keyMaps).forEach(([key, mappedKey]) => {
      this.obj[key] = this.valueMaps[key] ? this.valueMaps[key][this.obj[mappedKey]] : this.obj[mappedKey];
      delete this.obj[mappedKey];
    });

    logger.debug(this.obj, this.accessory.displayName);
  }

  handleCommand(key, value) {
    value = this.valueMaps[key] ? this.valueMaps[key][value] : value;
    key = this.keyMaps[key] || key;
    logger.debug(`${key}=${value}`, this.accessory.displayName);

    return `${key}=${value}`;
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

      const args = [...this.args];
      args.push('set', ...this.extraSetFlags, `${this.handleCommand('pwr', stateNumber)}`);

      this.purifierService.updateCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState, stateNumber * 2);

      logger.info(`Purifier Active: ${state}`, this.accessory.displayName);
      await this.sendCMD(args);
      this.recordWrite(args, { pwr: stateNumber });
    } catch (err) {
      logger.warn('An error occured during changing purifier state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  async setPurifierTargetState(state) {
    try {
      const values = {
        mode: state ? 'P' : this.accessory.context.config.allergicFunc ? 'A' : 'M',
      };

      if (state != 0) {
        this.purifierService
          .updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, 0)
          .updateCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, state);
      }

      const args = [...this.args];
      args.push('set', ...this.extraSetFlags, `${this.handleCommand('mode', values.mode)}`);

      logger.info(`Purifier Mode: ${state}`, this.accessory.displayName);

      await this.sendCMD(args);
      this.recordWrite(args, { mode: values.mode });
    } catch (err) {
      logger.warn('An error occured during changing target purifier state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  async setPurifierLockPhysicalControls(state) {
    try {
      const values = {
        cl: state == 1,
      };

      const args = [...this.args];
      args.push('set', ...this.extraSetFlags, `${this.handleCommand('cl', values.cl)}`);

      logger.info(`Lock: ${state}`, this.accessory.displayName);

      await this.sendCMD(args);
      this.recordWrite(args, { cl: values.cl });
    } catch (err) {
      logger.warn('An error occured during changing lock state!', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
    }
  }

  async setPurifierRotationSpeed(value) {
    try {
      const speed = Math.ceil(value / this.speedsMinStep());

      if (speed > 0) {
        this.purifierService.updateCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, 0);
        logger.info(`Purifier Rotation Speed: value: ${value}`, this.accessory.displayName);

        let args = [...this.args];
        let cmds = [];
        Object.entries(this.speeds[speed - 1]).forEach(([cmd, value]) => {
          cmds.push(`${this.handleCommand(cmd, value)}`);
        });
        args.push('set', ...this.extraSetFlags, ...cmds);

        logger.info(`Purifier Rotation Speed: cmds: ${cmds.join(' ')}`, this.accessory.displayName);

        await this.sendCMD(args);
        this.recordWrite(args, this.speeds[speed - 1]);
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

        if (this.obj.rhset == 40) {
          speed_humidity = 25;
        } else if (this.obj.rhset == 50) {
          speed_humidity = 50;
        } else if (this.obj.rhset == 60) {
          speed_humidity = 75;
        } else if (this.obj.rhset == 70) {
          speed_humidity = 100;
        }
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

      const args = [...this.args];
      args.push('set', ...this.extraSetFlags, `${this.handleCommand('func', values.func)}`);

      logger.info(`Humidifier Active: ${state}`, this.accessory.displayName);

      await this.sendCMD(args);
      this.recordWrite(args, { func: values.func });
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

      const args1 = [...this.args];
      const args2 = [...this.args];

      args1.push('set', ...this.extraSetFlags, `${this.handleCommand('func', values.func)}`);
      args2.push('set', ...this.extraSetFlags, `${this.handleCommand('rhset', values.rhset)}`, '-I');

      logger.info(`Humidifier State: ${state}`, this.accessory.displayName);

      await this.sendCMD(args1);
      this.recordWrite(args1, { func: values.func });
      await this.sendCMD(args2);
      this.recordWrite(args2, { rhset: values.rhset });
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
      const args1 = [...this.args];
      const args2 = [...this.args];

      args1.push('set', ...this.extraSetFlags, `${this.handleCommand('aqil', values.aqil)}`, '-I');
      args2.push('set', ...this.extraSetFlags, `${this.handleCommand('uil', values.uil)}`);

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
      const args1 = [...this.args];
      const args2 = [...this.args];

      args1.push('set', ...this.extraSetFlags, `${this.handleCommand('aqil', values.aqil)}`, '-I');
      args2.push('set', ...this.extraSetFlags, `${this.handleCommand('uil', values.uil)}`);

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
    const since = Date.now();

    for (const [key, expected] of Object.entries(expectations)) {
      this.pendingWrites.set(key, { expected, args, attempts: 0, since });
    }

    this.armVerifyTimeout();
  }

  /**
   * Gives the device a chance to report the write on its own, then elicits a
   * reading. The device pushes spontaneously only while values are changing, so
   * a *dropped* write is exactly the case that produces no notification at all.
   */
  armVerifyTimeout() {
    if (this.verifyTimeout || !this.pendingWrites.size) {
      return;
    }

    this.verifyTimeout = setTimeout(() => {
      this.requestRefresh();

      //let the elicited reading use what is left of the window
      this.verifyTimeout = setTimeout(
        () => {
          this.verifyTimeout = null;
          this.expirePendingWrites();
        },
        Math.max(this.verifyWindow - this.verifyRefreshDelay, 0)
      );
    }, this.verifyRefreshDelay);
  }

  /**
   * Reconciles pending writes against a status the device has just sent.
   *
   * Two rules, both model-independent unlike the timings: only a status that
   * arrived *after* the write says anything about it, and only a disagreement
   * proves it was lost. A window passing in silence proves nothing.
   *
   * @param {number} receivedAt
   */
  reconcilePendingWrites(receivedAt) {
    if (!this.pendingWrites.size) {
      return;
    }

    for (const [key, pending] of [...this.pendingWrites]) {
      //a status already in flight when the write was sent cannot have observed
      //it. the resolution is coarse, and the cost of getting it wrong is one
      //extra resend of a command the device has already applied
      if (receivedAt < pending.since) {
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
        //nothing is evidence about the resend until the resend is on the wire:
        //status the device sent in the meantime describes the state before it
        pending.since = Infinity;

        logger.debug(
          `Device reports ${key}=${this.obj[key]}, resending ${key}=${pending.expected}`,
          this.accessory.displayName
        );

        //not awaited: this runs while a status line is being processed, and the
        //answer to it arrives as another status line, not as an exit code
        this.sendCMD(pending.args)
          .then(() => {
            pending.since = Date.now();
          })
          .catch((err) => {
            this.pendingWrites.delete(key);
            logger.error(err, this.accessory.displayName);
          });
        continue;
      }

      this.pendingWrites.delete(key);
      this.reportWriteFailure(key, pending);
    }

    clearTimeout(this.verifyTimeout);
    this.verifyTimeout = null;
    this.armVerifyTimeout();
  }

  /**
   * Drops writes the device never spoke to. Deliberately quiet: silence past
   * the window means this device answers more slowly than the one the delays
   * were chosen against, and reporting that as a lost command would turn every
   * unmeasured model into a warning loop.
   */
  expirePendingWrites() {
    for (const [key, pending] of this.pendingWrites) {
      logger.debug(
        `No status covering ${key}=${pending.expected} arrived within ${Math.round(this.verifyWindow / 1000)}s`,
        this.accessory.displayName
      );
    }

    this.pendingWrites.clear();
  }

  /**
   * Reports a write the device demonstrably did not apply: it answered, and its
   * answer disagrees. Latched like reportPollFailure, since the HomeKit
   * automation that produced it will keep producing it.
   *
   * @param {string} key
   * @param {{ expected: unknown, attempts: number }} pending
   */
  reportWriteFailure(key, pending) {
    const summary =
      `The device did not apply ${key}=${pending.expected} after ${pending.attempts + 1} attempts ` +
      `(it reports ${this.obj[key]}). The command was most likely lost in transit; ` +
      'see README Troubleshooting.';

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
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.receivedData = false;
    this.stalled = false;
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
      const error = err.code === 'ENOENT' ? this.missingBinaryError() : err;

      //'error' also fires on an already-running child, e.g. a kill that failed.
      //only a child that never started is a spawn failure; anything else must
      //still count toward the escalation threshold in 'close'
      const spawnFailure = child.pid === undefined;
      this.spawnFailed = spawnFailure;

      //only log the first failure of its kind in a retry loop to avoid spamming
      if (this.loggedFailureKind === 'spawn') {
        logger.debug(error, this.accessory.displayName);
      } else {
        this.loggedFailureKind = 'spawn';
        logger.warn('Failed to run polling process', this.accessory.displayName);
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

      //a stream torn down on purpose to elicit a reading has not failed, even
      //if it produced nothing before it was killed
      if (!this.receivedData && !this.spawnFailed && !this.refreshing) {
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
   * tail: with `debug` enabled the CLI's own startup chatter would otherwise
   * fill the budget and crowd the error out.
   *
   * @param {string} text
   */
  captureStderr(text) {
    this.stderrBuffer = (this.stderrBuffer + text).slice(-MAX_STDERR_CAPTURE);
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
    //a stall means the subscription was accepted and nothing ever arrived,
    //which is already conclusive; an exit could still be a one-off
    const escalate = this.stalled || this.pollFailures >= FAILURE_ESCALATION_THRESHOLD;
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

    const stderr = this.stderrBuffer.trim();

    if (stderr) {
      logger.error(new Error(`${this.binary} wrote: ${stderr}`), this.accessory.displayName);
    }
  }

  /**
   * Restarts the observe stream when the device goes quiet. Re-armed by every
   * status line, so this fires only on an actual stall rather than on a timer
   * racing the device's own notification interval.
   */
  armStallTimeout() {
    clearTimeout(this.processTimeout);

    this.processTimeout = setTimeout(() => {
      if (this.airControl) {
        logger.debug(
          `No status received for ${Math.round(this.stallTimeout / 1000)}s, restarting the polling process`,
          this.accessory.displayName
        );
        this.stalled = true;
        this.airControl.kill();
      }
    }, this.stallTimeout);
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

    //a line arriving proves the stream is alive, whether or not it parses
    if (this.airControl && !this.shutdown) {
      this.armStallTimeout();
    }

    try {
      const response = JSON.parse(line);

      //only a parseable status proves the device is healthy. a CLI that writes
      //a traceback to stdout instead of stderr would otherwise clear the
      //failure counters on every retry and never escalate
      this.receivedData = true;
      this.pollFailures = 0;

      if (this.loggedFailureKind) {
        this.loggedFailureKind = null;
        logger.info('Device is responding again', this.accessory.displayName);
      }

      this.handleResponse(response);
    } catch (err) {
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
        .updateCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, this.obj.mode === 'M' ? 0 : 1)
        .updateCharacteristic(this.api.hap.Characteristic.LockPhysicalControls, this.obj.cl ? 1 : 0)
        .updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.rotationSpeed());

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
            if (this.obj.rhset == 40) {
              speed_humidity = 25;
            } else if (this.obj.rhset == 50) {
              speed_humidity = 50;
            } else if (this.obj.rhset == 60) {
              speed_humidity = 75;
            } else if (this.obj.rhset == 70) {
              speed_humidity = 100;
            }
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
    this.processTimeout = null;
    this.restartTimeout = null;
    this.verifyTimeout = null;
    this.pendingWrites.clear();

    if (this.airControl) {
      logger.debug('Killing airControl process', this.accessory.displayName);
      this.airControl.kill();
    }
  }
}

module.exports = Handler;
