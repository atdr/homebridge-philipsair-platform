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
    logger.error(err);
    assert.equal(sink.errors[0], err);

    logger.configure(sink.log, { extendedError: false });
    logger.error(err, 'Purifier');
    assert.equal(sink.errors[1], 'Purifier: boom');
  });

  //with two purifiers the stack trace is useless unless it says which device
  //it came from, so extended mode must keep the name as well as the stack
  it('keeps the accessory name and the full stack in extended mode', () => {
    const err = new Error('boom');

    logger.configure(sink.log, { extendedError: true });
    logger.error(err, 'Bedroom');

    assert.equal(sink.errors.length, 1);
    assert.equal(typeof sink.errors[0], 'string');
    assert.ok(sink.errors[0].startsWith('Bedroom: Error: boom'), sink.errors[0]);
    assert.ok(sink.errors[0].includes(err.stack.split('\n')[1]), 'the stack frames were dropped');
  });

  //an execFile failure carries code, stderr and the like on the error itself,
  //and those are what Homebridge would have printed for the bare error
  it('keeps the own properties of an error in extended mode', () => {
    const err = Object.assign(new Error('boom'), { code: 'ENOENT', stderr: 'no such host' });

    logger.configure(sink.log, { extendedError: true });
    logger.error(err, 'Bedroom');

    assert.match(sink.errors[0], /code: 'ENOENT'/);
    assert.match(sink.errors[0], /stderr: 'no such host'/);
  });

  //a `%s` in a device name must not be read as a format specifier
  it('does not treat the accessory name as a format string', () => {
    const err = new Error('boom');

    logger.configure(sink.log, { extendedError: true });
    logger.error(err, 'Office %s');

    assert.ok(sink.errors[0].startsWith('Office %s: Error: boom'), sink.errors[0]);
  });

  it('keeps the debug marker on errors in extended mode', () => {
    const err = new Error('boom');

    logger.configure(sink.log, { debug: true, extendedError: true });
    logger.debug(err, 'Bedroom');
    logger.debug(err);

    assert.ok(sink.infos[0].startsWith('[DEBUG] Bedroom: Error: boom'), sink.infos[0]);
    assert.ok(sink.infos[1].startsWith('[DEBUG] Error: boom'), sink.infos[1]);
    assert.ok(sink.infos[1].includes(err.stack.split('\n')[1]), 'the stack frames were dropped');
  });

  it('keeps the accessory name and the stack on alerts in extended mode', () => {
    const err = new Error('broken');

    logger.configure(sink.log, { error: false, extendedError: true });
    logger.alert(err, 'Purifier');

    assert.ok(sink.errors[0].startsWith('Purifier: Error: broken'), sink.errors[0]);
    assert.ok(sink.errors[0].includes(err.stack.split('\n')[1]), 'the stack frames were dropped');
  });

  //install faults are not verbosity: a user who quietened a chatty device has
  //not asked to be kept in the dark about a plugin that cannot work at all
  it('reports alerts even when error logging is switched off', () => {
    logger.configure(sink.log, { error: false });
    logger.alert('aioairctrl is missing');

    assert.deepEqual(sink.errors, ['aioairctrl is missing']);
  });

  it('prefixes alerts with the accessory name like every other level', () => {
    logger.configure(sink.log, {});
    logger.alert('broken', 'Purifier');

    assert.deepEqual(sink.errors, ['Purifier: broken']);
  });
});
