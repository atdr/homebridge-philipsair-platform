/**
 * v1
 *
 * @url https://github.com/atdr/homebridge-philipsair-platform
 * @author atdr <andreas@atdr.uk>
 *
 **/

module.exports = (homebridge) => {
  const PhilipsAirPlatform = require('./src/platform')(homebridge);
  homebridge.registerPlatform('@atdr/homebridge-philipsair-platform', 'PhilipsAirPlatform', PhilipsAirPlatform, true);
};
