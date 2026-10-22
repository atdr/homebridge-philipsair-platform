'use strict';

//Drift guards for the dependency audit in .github/workflows/ci.yml. The two
//audit steps differ only in a flag and in how each treats a non-zero exit, so an
//edit that loses the distinction would leave CI looking green while nothing
//blocks a vulnerable runtime dependency from reaching a user's Homebridge
//install.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8');

//Same job splitting as test/publish-release-workflow.test.js: job keys are the only
//two-space-indented keys with no inline value, so a heading regex suffices
//without a YAML parser (this repo ships no runtime dependencies).
const jobs = (() => {
  const jobsIndex = workflow.indexOf('\njobs:');
  assert.notEqual(jobsIndex, -1, "ci.yml has no 'jobs:' mapping");
  const section = workflow.slice(jobsIndex);
  const heading = /^ {2}([a-z][a-z0-9-]*):$/gm;
  const blocks = new Map();
  let previous = null;
  let match;
  while ((match = heading.exec(section)) !== null) {
    if (previous) blocks.set(previous.name, section.slice(previous.end, match.index));
    previous = { name: match[1], end: heading.lastIndex };
  }
  if (previous) blocks.set(previous.name, section.slice(previous.end));
  return blocks;
})();

const auditSteps = () => {
  const audit = jobs.get('audit');
  assert.ok(audit, 'no audit job in ci.yml');
  //One entry per '- run:' step, each carrying the lines that follow it.
  return audit
    .split(/^ {6}- (?=run:|uses:|name:)/m)
    .slice(1)
    .filter((step) => /^ *run:/m.test(step));
};

describe('CI dependency audit', () => {
  it('blocks on production advisories', () => {
    const blocking = auditSteps().filter((step) => step.includes('--omit=dev'));
    assert.equal(blocking.length, 1, 'expected exactly one production-only audit step');
    assert.doesNotMatch(
      blocking[0],
      /continue-on-error:\s*true/,
      'the production audit must fail the job — it is the only gate on what reaches users'
    );
    assert.match(blocking[0], /--audit-level=high/);
  });

  it('keeps the full-tree audit advisory only', () => {
    const advisory = auditSteps().filter((step) => step.includes('npm audit') && !step.includes('--omit=dev'));
    assert.equal(advisory.length, 1, 'expected exactly one full-tree audit step');
    //The step swallows npm audit's exit code rather than being forgiven by
    //continue-on-error, so that the annotation it leaves behind is one this repo wrote.
    //continue-on-error cannot change the runner's own 'exit code 1' notice, only the
    //conclusion beneath it, and that notice explains nothing.
    assert.match(
      advisory[0],
      /if ! npm audit/,
      'a dev-tree advisory must not block unrelated PRs; Dependabot alerts are the signal of record'
    );
    //Deliberately ::error, not ::warning. A red annotation on a green job is incongruous
    //enough to get read, which is the whole job of this step; a warning sinks into the
    //standing noise of deprecation notices. It is not permanent wallpaper either, because
    //a Dependabot bump clears it.
    assert.match(advisory[0], /::error title=/, 'a swallowed advisory must still surface, or the step is useless');
    assert.doesNotMatch(
      advisory[0],
      /continue-on-error/,
      'the step handles its own exit code; continue-on-error would also mask a broken wrapper'
    );
  });

  it('audits without installing', () => {
    //An install would run lifecycle scripts from the very tree under audit.
    for (const step of auditSteps()) {
      assert.match(step, /--package-lock-only/, `audit step runs without --package-lock-only: ${step.trim()}`);
    }
    assert.doesNotMatch(jobs.get('audit'), /npm ci/, 'the audit job does not need an install');
  });

  it('skips PR jobs once the pull request is closed', () => {
    //'edited' events fire for merged PRs, where the commit range no longer
    //resolves after a squash merge (see the comment above the jobs mapping).
    assert.match(
      jobs.get('audit'),
      /if: github\.event_name == 'push' \|\| github\.event\.pull_request\.state == 'open'/
    );
  });
});

describe('CI Node matrix', () => {
  //Homebridge plugin verification requires the plugin to run on every Node line it
  //declares, so the matrix must test exactly the majors in engines.node: no more,
  //no fewer. A major added to one and not the other is caught here, not by a user.
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

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
    const build = jobs.get('build');
    assert.ok(build, 'no build job in ci.yml');
    const match = /^\s*node-version: \[([^\]]*)\]$/m.exec(build);
    assert.ok(match, 'build job has no inline node-version matrix');
    return match[1]
      .split(',')
      .map((entry) => {
        const version = /^\s*(\d+)\.x\s*$/.exec(entry);
        assert.ok(version, `matrix entry is not a <major>.x line: ${entry.trim()}`);
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
