/**
 * v1
 *
 * @url https://github.com/atdr/homebridge-philipsair-platform
 * @author atdr <andreas@atdr.uk>
 *
 **/

'use strict';

module.exports = (homebridge) => {
  const { name: PLUGIN_NAME } = require('./package.json');
  const PhilipsAirPlatform = require('./src/platform')(homebridge);
  homebridge.registerPlatform(PLUGIN_NAME, 'PhilipsAirPlatform', PhilipsAirPlatform, true);
};
