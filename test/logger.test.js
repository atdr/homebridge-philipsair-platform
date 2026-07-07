'use strict';

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

const logger = require('../src/utils/logger');

const makeSink = () => {
  const sink = { infos: [], warns: [], errors: [] };
  sink.log = {
    info: (msg) => sink.infos.push(msg),
    warn: (msg) => sink.warns.push(msg),
    error: (msg) => sink.errors.push(msg),
  };
  return sink;
};

describe('logger', () => {
  let sink;

  beforeEach(() => {
    sink = makeSink();
  });

  it('prefixes messages with the accessory name', () => {
    logger.configure(sink.log, {});
    logger.info('hello', 'Purifier');
    assert.deepEqual(sink.infos, ['Purifier: hello']);
  });

  it('only logs debug messages in debug mode', () => {
    logger.configure(sink.log, { debug: false });
    logger.debug('hidden');
    assert.equal(sink.infos.length, 0);

    logger.configure(sink.log, { debug: true });
    logger.debug('shown', 'Purifier');
    assert.deepEqual(sink.infos, ['[DEBUG] Purifier: shown']);
  });

  it('honours warn and error switches', () => {
    logger.configure(sink.log, { warn: false, error: false });
    logger.warn('warning');
    logger.error('error');
    assert.equal(sink.warns.length, 0);
    assert.equal(sink.errors.length, 0);
  });

  it('serialises object messages', () => {
    logger.configure(sink.log, {});
    logger.info({ pwr: '1' });
    assert.deepEqual(sink.infos, ['{"pwr":"1"}']);
  });

  it('logs the raw error in extended mode and the message otherwise', () => {
    const err = new Error('boom');

    logger.configure(sink.log, { extendedError: true });
    logger.error(err, 'Purifier');
    assert.equal(sink.errors[0], err);

    logger.configure(sink.log, { extendedError: false });
    logger.error(err, 'Purifier');
    assert.equal(sink.errors[1], 'Purifier: boom');
  });
});
