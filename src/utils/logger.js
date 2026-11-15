'use strict';

const util = require('util');

class Logger {
  constructor() {
    this.log = console;

    this.debugMode = false;
    this.warnMode = true;
    this.errorMode = true;
    this.extendedErrorMode = true;
  }

  configure(logger, config) {
    this.log = logger;

    this.debugMode = config.debug;
    this.warnMode = config.warn === undefined ? true : config.warn;
    this.errorMode = config.error === undefined ? true : config.error;
    this.extendedErrorMode = config.extendedError === undefined ? true : config.extendedError;
  }

  formatMessage(message, accessoryName, mode) {
    let formatted = mode === 'debug' ? '[DEBUG] ' : '';

    if (accessoryName) {
      formatted += accessoryName + ': ';
    }

    if (message instanceof Error) {
      if (this.extendedErrorMode) {
        //with nothing to prefix, hand Homebridge the error itself as before.
        //otherwise inspect it here, which is what Homebridge's util.format
        //would do, so the stack and own properties (code, stderr) survive
        //alongside the name. one string rather than (prefix, err) so a `%`
        //in a device name is never read as a format specifier
        return formatted ? formatted + util.inspect(message) : message;
      }
      formatted += message.message;
    } else if (typeof message === 'object') {
      formatted += JSON.stringify(message);
    } else {
      formatted += message;
    }

    return formatted;
  }

  info(message, accessoryName) {
    this.log.info(this.formatMessage(message, accessoryName, 'info'));
  }

  warn(message, accessoryName) {
    if (this.warnMode) {
      this.log.warn(this.formatMessage(message, accessoryName, 'warn'));
    }
  }

  error(message, accessoryName) {
    if (this.errorMode) {
      this.log.error(this.formatMessage(message, accessoryName, 'error'));
    }
  }

  debug(message, accessoryName) {
    if (this.debugMode) {
      this.log.info(this.formatMessage(message, accessoryName, 'debug'));
    }
  }

  /**
   * A fault that stops the plugin working at all, reported whatever the log
   * flags say. `warn` and `error` are verbosity switches for per-device
   * operational noise; a missing prerequisite is not verbosity, and a user who
   * turned `error` off to quieten a chatty device has not asked to be kept in
   * the dark about an install that cannot work. Goes through `log.error` rather
   * than the ungated `log.info` so Homebridge still renders it as a fault.
   *
   * Reserved for setup faults. Anything recoverable belongs on `warn`/`error`.
   *
   * @param {unknown} message
   * @param {string} [accessoryName]
   */
  alert(message, accessoryName) {
    this.log.error(this.formatMessage(message, accessoryName, 'error'));
  }
}

const logger = new Logger();
module.exports = logger;
