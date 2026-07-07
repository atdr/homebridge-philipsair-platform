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

    this.getService();
  }

  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//
  // Services
  //~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~//

  getService() {
    logger.info(`Initializing ${this.accessory.displayName}`);

    //Service.AirPurifier
    this.purifierService = this.accessory.getService(this.api.hap.Service.AirPurifier);

    if (!this.purifierService) {
      this.purifierService = this.accessory.addService(
        this.api.hap.Service.AirPurifier,
        this.accessory.displayName,
        'purifier'
      );
    }

    if (!this.purifierService.testCharacteristic(this.api.hap.Characteristic.LockPhysicalControls)) {
      this.purifierService.addCharacteristic(this.api.hap.Characteristic.LockPhysicalControls);
    }

    if (!this.purifierService.testCharacteristic(this.api.hap.Characteristic.RotationSpeed)) {
      this.purifierService.addCharacteristic(this.api.hap.Characteristic.RotationSpeed);
    }

    //onGet handlers report the last polled device state
    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.Active)
      .onGet(() => (parseInt(this.handler.obj.pwr) ? 1 : 0))
      .onSet(async (state) => await this.handler.setPurifierActive(state));

    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.CurrentAirPurifierState)
      .onGet(() => (parseInt(this.handler.obj.pwr) ? 2 : 0));

    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.TargetAirPurifierState)
      .onGet(() => (this.handler.obj.mode === 'M' ? 0 : 1))
      .onSet(async (state) => await this.handler.setPurifierTargetState(state));

    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.LockPhysicalControls)
      .onGet(() => (this.handler.obj.cl ? 1 : 0))
      .onSet(async (state) => await this.handler.setPurifierLockPhysicalControls(state));

    this.purifierService
      .getCharacteristic(this.api.hap.Characteristic.RotationSpeed)
      .onGet(() => this.handler.rotationSpeed())
      .onSet(async (value) => await this.handler.setPurifierRotationSpeed(value))
      .setProps({
        minValue: 0,
        maxValue: 100,
        minStep: this.handler.speedsMinStep(),
      });

    //Service.AirQuality
    this.airQualityService = this.accessory.getService(this.api.hap.Service.AirQualitySensor);

    if (!this.airQualityService) {
      this.airQualityService = this.accessory.addService(
        this.api.hap.Service.AirQualitySensor,
        'Air Quality',
        'Air Quality'
      );
    }

    if (!this.airQualityService.testCharacteristic(this.api.hap.Characteristic.PM2_5Density)) {
      this.airQualityService.addCharacteristic(this.api.hap.Characteristic.PM2_5Density);
    }

    //Service.FilterMaintenance [Pre-Filter]
    if (this.accessory.context.config.preFilter) {
      let preFilterService = this.accessory.getService('Pre Filter');
      if (!preFilterService) {
        preFilterService = this.accessory.addService(
          this.api.hap.Service.FilterMaintenance,
          'Pre Filter',
          'Pre Filter'
        );
      }
      if (!preFilterService.testCharacteristic(this.api.hap.Characteristic.FilterLifeLevel)) {
        preFilterService.addCharacteristic(this.api.hap.Characteristic.FilterLifeLevel);
      }
    } else {
      const service = this.accessory.getService('Pre Filter');
      if (service) {
        this.accessory.removeService(service);
      }
    }

    //Service.FilterMaintenance [Active carbon filter]
    if (this.accessory.context.config.carbonFilter) {
      let carbonFilterService = this.accessory.getService('Active carbon filter');
      if (!carbonFilterService) {
        carbonFilterService = this.accessory.addService(
          this.api.hap.Service.FilterMaintenance,
          'Active carbon filter',
          'Active carbon filter'
        );
      }
      if (!carbonFilterService.testCharacteristic(this.api.hap.Characteristic.FilterLifeLevel)) {
        carbonFilterService.addCharacteristic(this.api.hap.Characteristic.FilterLifeLevel);
      }
    } else {
      const service = this.accessory.getService('Active carbon filter');
      if (service) {
        this.accessory.removeService(service);
      }
    }

    //Service.FilterMaintenance [HEPA filter]
    if (this.accessory.context.config.hepaFilter) {
      let hepaFilterService = this.accessory.getService('HEPA filter');
      if (!hepaFilterService) {
        hepaFilterService = this.accessory.addService(
          this.api.hap.Service.FilterMaintenance,
          'HEPA filter',
          'HEPA filter'
        );
      }
      if (!hepaFilterService.testCharacteristic(this.api.hap.Characteristic.FilterLifeLevel)) {
        hepaFilterService.addCharacteristic(this.api.hap.Characteristic.FilterLifeLevel);
      }
    } else {
      const service = this.accessory.getService('HEPA filter');
      if (service) {
        this.accessory.removeService(service);
      }
    }

    //Service.HumidifierDehumidifier
    if (this.accessory.context.config.humidifier) {
      this.humidifierService = this.accessory.getService(this.api.hap.Service.HumidifierDehumidifier);

      if (!this.humidifierService) {
        this.humidifierService = this.accessory.addService(
          this.api.hap.Service.HumidifierDehumidifier,
          'Humidifier',
          'Humidifier'
        );
      }

      //Service.FilterMaintenance [Wick filter]
      if (!this.accessory.getService('Wick filter')) {
        this.accessory.addService(this.api.hap.Service.FilterMaintenance, 'Wick filter', 'Wick filter');
      }

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
      const service = this.accessory.getService(this.api.hap.Service.HumidifierDehumidifier);
      if (service) {
        this.accessory.removeService(service);
      }
    }

    //Service.TemperatureSensor
    if (this.accessory.context.config.temperature) {
      this.temperatureService = this.accessory.getService(this.api.hap.Service.TemperatureSensor);

      if (!this.temperatureService) {
        this.temperatureService = this.accessory.addService(
          this.api.hap.Service.TemperatureSensor,
          'Temperature Sensor',
          'Temperature Sensor'
        );
      }

      this.temperatureService
        .getCharacteristic(this.api.hap.Characteristic.CurrentTemperature)
        .onGet(() => this.handler.obj.temp || 0);
    } else {
      const service = this.accessory.getService(this.api.hap.Service.TemperatureSensor);
      if (service) {
        this.accessory.removeService(service);
      }
    }

    //Service.HumiditySensor
    if (this.accessory.context.config.humidity) {
      this.humidityService = this.accessory.getService(this.api.hap.Service.HumiditySensor);

      if (!this.humidityService) {
        this.humidityService = this.accessory.addService(
          this.api.hap.Service.HumiditySensor,
          'Humidity Sensor',
          'Humidity Sensor'
        );
      }

      this.humidityService
        .getCharacteristic(this.api.hap.Characteristic.CurrentRelativeHumidity)
        .onGet(() => this.handler.obj.rh || 0);
    } else {
      const service = this.accessory.getService(this.api.hap.Service.HumiditySensor);
      if (service) {
        this.accessory.removeService(service);
      }
    }

    //Service.Lightbulb
    if (this.accessory.context.config.light) {
      this.lightService = this.accessory.getService(this.api.hap.Service.Lightbulb);

      if (!this.lightService) {
        this.lightService = this.accessory.addService(this.api.hap.Service.Lightbulb, 'Light', 'Light');
      }

      if (!this.lightService.testCharacteristic(this.api.hap.Characteristic.Brightness)) {
        this.lightService.addCharacteristic(this.api.hap.Characteristic.Brightness);
      }

      this.lightService
        .getCharacteristic(this.api.hap.Characteristic.On)
        .onGet(() => this.handler.obj.pwr == '1' && this.handler.obj.aqil > 0)
        .onSet(async (state) => await this.handler.setLightOn(state));

      this.lightService
        .getCharacteristic(this.api.hap.Characteristic.Brightness)
        .onGet(() => this.handler.obj.aqil || 0)
        .onSet(async (value) => await this.handler.setLightBrightness(value))
        .setProps({
          minValue: 0,
          maxValue: 100,
          minStep: 25,
        });
    } else {
      const service = this.accessory.getService(this.api.hap.Service.Lightbulb);
      if (service) {
        this.accessory.removeService(service);
      }
    }

    this.handler.longPoll();
  }
}

module.exports = Accessory;
