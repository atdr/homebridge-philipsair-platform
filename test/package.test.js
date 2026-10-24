'use strict';

//Guards for the package.json fields the Homebridge plugin checks read when a
//plugin asks to be verified (homebridge/plugins, plugin-checks-request.yml).
//They run against the published package, so a regression here would only show
//up after a release; failing CI is the cheaper place to find it.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const pkg = require('../package.json');

describe('package.json for the Homebridge plugin checks', () => {
  it('has the homebridge-plugin keyword, which makes it a plugin at all', () => {
    assert.ok(pkg.keywords.includes('homebridge-plugin'));
  });

  it('declares HAP as its transport, and not Matter, which it does not implement', () => {
    assert.ok(pkg.keywords.includes('supports-hap'));
    assert.ok(!pkg.keywords.includes('supports-matter'));
  });

  it('has no install scripts, which run on the user system', () => {
    for (const script of ['preinstall', 'install', 'postinstall']) {
      assert.equal(pkg.scripts[script], undefined, script);
    }
  });

  it('does not declare homebridge or hap-nodejs as a runtime, peer, or bundled dependency', () => {
    for (const field of ['dependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) {
      const declared = pkg[field] ?? {};
      const names = Array.isArray(declared) ? declared : Object.keys(declared);
      for (const name of ['homebridge', 'hap-nodejs', '@homebridge/hap-nodejs']) {
        assert.ok(!names.includes(name), `${name} in ${field}`);
      }
    }
  });

  it('has the homepage and bugs URL the checks look for', () => {
    assert.match(pkg.homepage, /^https:\/\/github\.com\//);
    assert.match(pkg.bugs.url, /^https:\/\/github\.com\/.+\/issues$/);
  });
});
