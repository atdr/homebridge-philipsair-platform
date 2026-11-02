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
  const PhilipsAirPlatform = require('./src/platform');

  homebridge.registerPlatform(PLUGIN_NAME, 'PhilipsAirPlatform', PhilipsAirPlatform, true);
  //Keep the platform identifier used by homebridge-philips-air (NikDevx), so
  //installations can switch plugins without first renaming their platform block.
  homebridge.registerPlatform(PLUGIN_NAME, 'philipsAir', PhilipsAirPlatform, true);
};
