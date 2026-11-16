'use strict';

const logger = require('../utils/logger');

class Accessory {
  constructor(api, accessory, handler) {
    this.api = api;
    this.accessory = accessory;
    this.handler = handler;

    this.purifierService = null;
    this.humidifierService = null;
    this.temperatureService = null;
    this.humidityService = null;
    this.lightService = null;
    this.airQualityService = null;
    this.preFilterService = null;
    this.carbonFilterService = null;
    this.hepaFilterService = null;
    this.wickFilterService = null;

    this.getService();
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Services
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  getService() {
    logger.info(`Initializing ${this.accessory.displayName}`);

    //Service.AirPurifier
    this.purifierService = this.ensureService(this.api.hap.Service.AirPurifier, this.accessory.displayName, 'purifier');

    //a model with no child lock register gets no child lock control: the
    //characteristic is optional, so it can be left off (and taken off a cached
    //accessory that has one) rather than reporting a state the device never has
    if (this.handler.supports('cl')) {
      if (!this.purifierService.testCharacteristic(this.api.hap.Characteristic.LockPhysicalControls)) {
        this.purifierService.addCharacteristic(this.api.hap.Characteristic.LockPhysicalControls);
      }
    } else if (this.purifierService.testCharacteristic(this.api.hap.Characteristic.LockPhysicalControls)) {
      this.purifierService.removeCharacteristic(
        this.purifierService.getCharacteristic(this.api.hap.Characteristic.LockPhysicalControls)
      );
    }

    if (!this.purifierService.testCharacteristic(this.api.hap.Characteristic.RotationSpeed)) {
      this.purifierService.addCharacteristic(this.api.hap.Characteristic.RotationSpeed);
    }

    //onGet handlers report the last polled device state, or No Response while
    //the device cannot be reached (Handler.read)
    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.Active)
      .onGet(() => this.handler.read(() => (parseInt(this.handler.obj.pwr) ? 1 : 0)))
      .onSet(async (state) => await this.handler.setPurifierActive(state));

    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
      .onGet(() => this.handler.read(() => (parseInt(this.handler.obj.pwr) ? 2 : 0)));

    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState)
      .onGet(() => this.handler.read(() => (this.handler.inAutoMode() ? 1 : 0)))
      .onSet(async (state) => await this.handler.setPurifierTargetState(state));

    //TargetAirPurifierState is required on this service and cannot be removed,
    //so a model with no mode keeps it pinned to AUTO instead. The Home app then
    //stops offering an auto/manual switch that could never take effect. Props
    //are cached with the accessory, so a model that has a mode gets both values
    //set back explicitly in case it was paired while pinned
    const { AUTO, MANUAL } = this.api.hap.Characteristic.TargetAirPurifierState;
    const targetState = this.purifierService.getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState);

    if (this.handler.supportsMode()) {
      targetState.setProps({ validValues: [MANUAL, AUTO] });
    } else {
      targetState.updateValue(AUTO).setProps({ validValues: [AUTO] });
    }

    if (this.handler.supports('cl')) {
      this.purifierService
        .getCharacteristic(this.api.hap.Characteristic.LockPhysicalControls)
        .onGet(() => this.handler.read(() => (this.handler.obj.cl ? 1 : 0)))
        .onSet(async (state) => await this.handler.setPurifierLockPhysicalControls(state));
    }

    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
      .onGet(() => this.handler.read(() => this.handler.rotationSpeed()))
      .onSet(async (value) => await this.handler.setPurifierRotationSpeed(value))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: this.handler.speedsMinStep(),
      });

    //Service.AirQuality
    this.airQualityService = this.ensureService(this.api.hap.Service.AirQualitySensor, 'Air Quality', 'Air Quality');

    if (!this.airQualityService.testCharacteristic(this.api.hap.Characteristic.PM2_5Density)) {
      this.airQualityService.addCharacteristic(this.api.hap.Characteristic.PM2_5Density);
    }

    //Service.FilterMaintenance [Pre Filter], [Active carbon filter], [HEPA filter]
    for (const [option, field, name] of [
      ['preFilter', 'preFilterService', 'Pre Filter'],
      ['carbonFilter', 'carbonFilterService', 'Active carbon filter'],
      ['hepaFilter', 'hepaFilterService', 'HEPA filter'],
    ]) {
      if (this.accessory.context.config[option]) {
        const service = this.ensureService(this.api.hap.Service.FilterMaintenance, name, name);
        if (!service.testCharacteristic(this.api.hap.Characteristic.FilterLifeLevel)) {
          service.addCharacteristic(this.api.hap.Characteristic.FilterLifeLevel);
        }
        this[field] = service;
      } else {
        this.dropService(this.api.hap.Service.FilterMaintenance, name);
      }
    }

    //Service.HumidifierDehumidifier, only on a model with a humidifier on/off
    //(func) to drive: accessories.setup.js warns when the option is ignored
    if (this.accessory.context.config.humidifier && this.handler.supports('func')) {
      this.humidifierService = this.ensureService(
        this.api.hap.Service.HumidifierDehumidifier,
        'Humidifier',
        'Humidifier'
      );

      //Service.FilterMaintenance [Wick filter]
      this.wickFilterService = this.ensureService(this.api.hap.Service.FilterMaintenance, 'Wick filter', 'Wick filter');

      if (!this.humidifierService.testCharacteristic(this.api.hap.Characteristic.RelativeHumidityHumidifierThreshold)) {
        this.humidifierService.addCharacteristic(this.api.hap.Characteristic.RelativeHumidityHumidifierThreshold);
      }

      if (!this.humidifierService.testCharacteristic(this.api.hap.Characteristic.WaterLevel)) {
        this.humidifierService.addCharacteristic(this.api.hap.Characteristic.WaterLevel);
      }

      this.humidifierService
        .getCharacteristic(this.api.hap.Characteristic.Active)
        .onSet(async (state) => await this.handler.setHumidifierActive(state));

      this.humidifierService
        .getCharacteristic(this.api.hap.Characteristic.CurrentHumidifierDehumidifierState)
        .setProps({
          validValues: [
            this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
            this.api.hap.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING,
          ],
        });

      this.humidifierService
        .getCharacteristic(this.api.hap.Characteristic.TargetHumidifierDehumidifierState)
        .updateValue(this.api.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER)
        .onSet(async (state) => {
          await this.handler.setHumidifierActive(state);
          //await this.handler.setHumidifierTargetState(state);
        })
        .setProps({
          validValues: [this.api.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER],
        });

      this.humidifierService
        .getCharacteristic(this.api.hap.Characteristic.RelativeHumidityHumidifierThreshold)
        .onSet(async (state) => await this.handler.setHumidifierTargetState(state))
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 25,
        });
    } else {
      this.dropService(this.api.hap.Service.HumidifierDehumidifier, 'Humidifier');

      //the wick filter is added with the humidifier, so it goes with it
      this.dropService(this.api.hap.Service.FilterMaintenance, 'Wick filter');
    }

    //Service.TemperatureSensor
    if (this.accessory.context.config.temperature) {
      this.temperatureService = this.ensureService(
        this.api.hap.Service.TemperatureSensor,
        'Temperature Sensor',
        'Temperature Sensor'
      );

      this.temperatureService
        .getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
        .onGet(() => this.handler.read(() => this.handler.obj.temp || 0));
    } else {
      this.dropService(this.api.hap.Service.TemperatureSensor, 'Temperature Sensor');
    }

    //Service.HumiditySensor
    if (this.accessory.context.config.humidity) {
      this.humidityService = this.ensureService(
        this.api.hap.Service.HumiditySensor,
        'Humidity Sensor',
        'Humidity Sensor'
      );

      this.humidityService
        .getCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.handler.read(() => this.handler.obj.rh || 0));
    } else {
      this.dropService(this.api.hap.Service.HumiditySensor, 'Humidity Sensor');
    }

    //Service.Lightbulb
    if (this.accessory.context.config.light) {
      this.lightService = this.ensureService(this.api.hap.Service.Lightbulb, 'Light', 'Light');

      if (!this.lightService.testCharacteristic(this.api.hap.Characteristic.Brightness)) {
        this.lightService.addCharacteristic(this.api.hap.Characteristic.Brightness);
      }

      this.lightService
        .getCharacteristic(this.api.hap.Characteristic.On)
        .onGet(() => this.handler.read(() => this.handler.obj.pwr == '1' && this.handler.obj.aqil > 0))
        .onSet(async (state) => await this.handler.setLightOn(state));

      this.lightService
        .getCharacteristic(this.api.hap.Characteristic.Brightness)
        .onGet(() => this.handler.read(() => this.handler.obj.aqil || 0))
        .onSet(async (value) => await this.handler.setLightBrightness(value))
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 25,
        });
    } else {
      this.dropService(this.api.hap.Service.Lightbulb, 'Light');
    }

    //handed over once, so a restart of the polling process does not look them up again
    this.handler.useServices({
      purifierService: this.purifierService,
      airQualityService: this.airQualityService,
      preFilterService: this.preFilterService,
      carbonFilterService: this.carbonFilterService,
      hepaFilterService: this.hepaFilterService,
      humidifierService: this.humidifierService,
      wickFilterService: this.wickFilterService,
      temperatureService: this.temperatureService,
      humidityService: this.humidityService,
      lightService: this.lightService,
    });

    this.handler.longPoll();
  }

  /**
   * Finds a service this plugin created by its type and the subtype it was
   * created with (issue #183). The subtype is the stable identifier: every
   * release has cached these services under the same subtypes, while a display
   * name can change, and a lookup by name could also match the purifier
   * itself, which carries the accessory's own name.
   *
   * A type the accessory only ever has one of is also found under any other
   * subtype, so a service cached that way is adopted rather than duplicated or
   * left behind. The filters share a type, so they are only ever found by
   * subtype.
   *
   * @param {any} type a HAP Service class
   * @param {string} subtype
   */
  findService(type, subtype) {
    const service = this.accessory.getServiceById(type, subtype);

    if (service || type === this.api.hap.Service.FilterMaintenance) {
      return service;
    }

    return this.accessory.getService(type);
  }

  /**
   * The service of this type and subtype, added under `name` if the accessory
   * does not have it yet.
   *
   * @param {any} type a HAP Service class
   * @param {string} name
   * @param {string} subtype
   */
  ensureService(type, name, subtype) {
    const service = this.findService(type, subtype) || this.accessory.addService(type, name, subtype);

    this.nameService(service);

    return service;
  }

  /**
   * Gives a service the ConfiguredName the Home app labels its tile with
   * (issue #179). Without one the Home app tends to fall back to the accessory
   * name for every service, so the purifier, its sensors and its filters show
   * tiles that cannot be told apart.
   *
   * Set once, to the name the service was created with, and never again: once
   * it exists it is the user's, since a rename in the Home app is written
   * there. A service restored from cache without one gets it the same way.
   * A rename is saved to the accessory cache straight away rather than at
   * shutdown, so it survives a Homebridge that does not stop cleanly.
   *
   * @param {any} service a HAP Service
   */
  nameService(service) {
    const { Characteristic, ChangeReason } = this.api.hap;

    if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
      service.addCharacteristic(Characteristic.ConfiguredName).updateValue(service.displayName);
    }

    service.getCharacteristic(Characteristic.ConfiguredName).on('change', ({ reason }) => {
      if (reason === ChangeReason.WRITE) {
        this.api.updatePlatformAccessories([this.accessory]);
      }
    });
  }

  /**
   * Removes the service of this type and subtype, if the accessory has it.
   *
   * @param {any} type a HAP Service class
   * @param {string} subtype
   */
  dropService(type, subtype) {
    const service = this.findService(type, subtype);

    if (service) {
      this.accessory.removeService(service);
    }
  }
}

module.exports = Accessory;
