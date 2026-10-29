'use strict';

//Drift guards for .github/workflows/ci.yml. The jobs themselves live in
//atdr/github-boilerplate's node-ci.yml, pinned by tag, which owns the audit's
//blocking/advisory split and the coverage upload. What this repo controls is how
//it calls that workflow: which Node lines, which gates, and that neither the
//audit nor coverage is switched off.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

describe('CI workflow', () => {
  it('calls the boilerplate node-ci at a pinned tag', () => {
    assert.match(workflow, /uses: atdr\/github-boilerplate\/\.github\/workflows\/node-ci\.yml@v\d+\.\d+\.\d+$/m);
  });

  it('runs every gate prepublishOnly runs, bar markdownlint', () => {
    //lint:md runs in checks.yml, through the boilerplate's markdown workflow.
    const match = /^ {6}scripts: (.+)$/m.exec(workflow);
    assert.ok(match, 'ci.yml passes no scripts to node-ci');
    const scripts = match[1].trim().split(/\s+/);
    for (const script of scripts)
      assert.ok(pkg.scripts[script], `ci.yml runs npm script '${script}', which is missing`);
    const gates = [...pkg.scripts.prepublishOnly.matchAll(/npm run ([\w:]+)/g)].map((m) => m[1]);
    for (const gate of gates.filter((gate) => gate !== 'lint:md')) {
      assert.ok(scripts.includes(gate), `prepublishOnly runs '${gate}' but CI does not`);
    }
  });

  it('keeps the dependency audit and coverage on', () => {
    //Both default to true in node-ci; turning either off here would leave CI green
    //with nothing auditing what reaches a user's Homebridge install.
    assert.doesNotMatch(workflow, /^ {6}audit: false/m);
    assert.doesNotMatch(workflow, /^ {6}coverage: false/m);
  });
});

describe('CI Node matrix', () => {
  //Homebridge plugin verification requires the plugin to run on every Node line it
  //declares, so the matrix must test exactly the majors in engines.node: no more,
  //no fewer. A major added to one and not the other is caught here, not by a user.
  const engineMajors = () =>
    pkg.engines.node
      .split('||')
      .map((range) => {
        const match = /^\s*\^(\d+)(?:\.\d+){0,2}\s*$/.exec(range);
        assert.ok(match, `engines.node range is not a caret range: ${range.trim()}`);
        return Number(match[1]);
      })
      .sort((a, b) => a - b);

  const matrixMajors = () => {
    const match = /^ {6}node-versions: '(.*)'$/m.exec(workflow);
    assert.ok(match, 'ci.yml does not pass node-versions to node-ci, so it tests the LTS lines instead');
    return JSON.parse(match[1])
      .map((entry) => {
        const version = /^(\d+)\.x$/.exec(entry);
        assert.ok(version, `matrix entry is not a <major>.x line: ${entry}`);
        return Number(version[1]);
      })
      .sort((a, b) => a - b);
  };

  it('tests exactly the Node majors that engines.node declares', () => {
    assert.deepEqual(matrixMajors(), engineMajors());
  });

  it('covers the current Node LTS lines and no end-of-life one', () => {
    //Node 20 reached end of life in April 2026; 22, 24 and 26 are the LTS lines.
    assert.deepEqual(engineMajors(), [22, 24, 26]);
  });
});
