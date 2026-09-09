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
