'use strict';

const { execFile, spawn } = require('child_process');

const logger = require('../utils/logger');
const modelConfig = require('./accessories.models');

class Handler {
  constructor(api, accessory) {
    this.api = api;
    this.accessory = accessory;

    this.shutdown = false;
    this.airControl = null;
    this.processTimeout = null;
    this.restartTimeout = null;
    this.stdoutBuffer = '';
    this.obj = {};

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
      await this.sendCMD(args2);
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

    this.airControl = spawn(this.binary, [...this.args, 'status-observe', '-J']);

    this.airControl.stdout.on('data', (data) => {
      this.stdoutBuffer += data.toString();

      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          this.processUpdate(line);
        }
      }
    });

    this.airControl.stderr.on('data', (data) => {
      logger.debug(data.toString(), this.accessory.displayName);
    });

    this.airControl.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
      logger.warn('Failed to run polling process', this.accessory.displayName);
      logger.error(err.code === 'ENOENT' ? this.missingBinaryError() : err, this.accessory.displayName);
      this.scheduleRestart(30 * 1000);
    });

    this.airControl.on('close', (code) => {
      logger.debug(
        `airControl process exited with code ${code} (${this.shutdown ? 'expected' : 'not expected'})`,
        this.accessory.displayName
      );

      if (!this.shutdown) {
        logger.debug('Restarting polling process', this.accessory.displayName);
        this.scheduleRestart(5 * 1000);
      }
    });

    //the observe connection is refreshed once a minute to recover from silent stalls
    this.processTimeout = setTimeout(() => {
      if (this.airControl) {
        this.airControl.kill();
      }
    }, 60 * 1000);
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
    try {
      this.handleResponse(JSON.parse(line));
    } catch (err) {
      logger.warn('Failed to parse device response', this.accessory.displayName);
      logger.error(err, this.accessory.displayName);
      return;
    }

    try {
      //Air Purifier
      this.purifierService
        .updateCharacteristic(this.api.hap.Characteristic.Active, parseInt(this.obj.pwr) ? 1 : 0)
        .updateCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState, parseInt(this.obj.pwr) * 2)
        .updateCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState, this.obj.mode === 'M' ? 0 : 1)
        .updateCharacteristic(this.api.hap.Characteristic.LockPhysicalControls, this.obj.cl ? 1 : 0)
        .updateCharacteristic(this.api.hap.Characteristic.RotationSpeed, this.rotationSpeed());

      if (this.airQualityService) {
        this.airQualityService
          .updateCharacteristic(this.api.hap.Characteristic.AirQuality, Math.ceil(this.obj.iaql / 3))
          .updateCharacteristic(this.api.hap.Characteristic.PM2_5Density, this.obj.pm25);
      }

      if (this.temperatureService) {
        this.temperatureService.updateCharacteristic(this.api.hap.Characteristic.CurrentTemperature, this.obj.temp);
      }

      if (this.humidityService) {
        this.humidityService.updateCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity, this.obj.rh);
      }

      if (this.lightService) {
        if (this.obj.pwr == '1') {
          this.lightService
            .updateCharacteristic(this.api.hap.Characteristic.On, this.obj.aqil > 0)
            .updateCharacteristic(this.api.hap.Characteristic.Brightness, this.obj.aqil);
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
          .updateCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity, this.obj.rh)
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

        if (this.wickFilterService) {
          const fltwickchange = this.obj.wicksts == 0;
          const fltwicklife = Math.round((this.obj.wicksts / 4800) * 100);

          this.wickFilterService
            .updateCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, fltwickchange)
            .updateCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, fltwicklife);
        }
      }

      if (this.preFilterService && this.obj.fltsts0 !== undefined) {
        const fltsts0change = this.obj.fltsts0 == 0;
        const fltsts0maxlife = this.obj.flttotal0 ? this.obj.flttotal0 : 360;
        const fltsts0life = (this.obj.fltsts0 / fltsts0maxlife) * 100;

        this.preFilterService
          .updateCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, fltsts0change)
          .updateCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, fltsts0life);
      }

      if (this.carbonFilterService && this.obj.fltsts2 !== undefined) {
        const fltsts2change = this.obj.fltsts2 == 0;
        const fltsts2maxlife = this.obj.flttotal2 ? this.obj.flttotal2 : 4800;
        const fltsts2life = (this.obj.fltsts2 / fltsts2maxlife) * 100;

        this.carbonFilterService
          .updateCharacteristic(this.api.hap.Characteristic.FilterChangeIndication, fltsts2change)
          .updateCharacteristic(this.api.hap.Characteristic.FilterLifeLevel, fltsts2life);
      }

      if (this.hepaFilterService && this.obj.fltsts1 !== undefined) {
        const fltsts1change = this.obj.fltsts1 == 0;
        const fltsts1maxlife = this.obj.flttotal1 ? this.obj.flttotal1 : 4800;
        const fltsts1life = (this.obj.fltsts1 / fltsts1maxlife) * 100;

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
    this.restartTimeout = null;

    if (this.airControl) {
      logger.debug('Killing airControl process', this.accessory.displayName);
      this.airControl.kill();
    }
  }
}

module.exports = Handler;
