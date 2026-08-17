'use strict';

//Drift guards for the publishing half of .github/workflows/release-please.yml.
//A published npm version is permanent past the 72 hour unpublish window, and a
//prerelease that lands on the 'latest' dist-tag reaches every Homebridge UI
//install, so the invariants below are checked here rather than left to review.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release-please.yml'), 'utf8');

//Split the jobs mapping into one block of text per job. Job keys are the only
//two-space-indented keys with no inline value, so the heading regex is enough
//without pulling in a YAML parser (this repo ships no runtime dependencies).
const jobs = (() => {
  const jobsIndex = workflow.indexOf('\njobs:');
  assert.notEqual(jobsIndex, -1, "release-please.yml has no 'jobs:' mapping");
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

describe('release workflow', () => {
  it('publishes releases and prereleases from one workflow file', () => {
    //npm allows a single trusted publisher per package, pinned to this
    //filename, so both publish paths have to live here.
    assert.ok(jobs.has('publish'), 'no publish job');
    assert.ok(jobs.has('publish-prerelease'), 'no publish-prerelease job');
    for (const name of ['publish', 'publish-prerelease']) {
      assert.match(jobs.get(name), /id-token: write/, `${name} cannot authenticate to npm without id-token: write`);
    }
  });

  it('only runs the release-please path on a push to main', () => {
    assert.match(workflow, /^ {2}push:\n {4}branches: \[main\]$/m);
    assert.match(jobs.get('release-please'), /if: github\.event_name == 'push'/);
    assert.match(jobs.get('publish-prerelease'), /if: github\.event_name == 'workflow_dispatch'/);
  });

  it('never publishes a prerelease to the latest dist-tag', () => {
    const prerelease = jobs.get('publish-prerelease');
    assert.match(prerelease, /npm publish --tag "\$DIST_TAG"/);
    assert.doesNotMatch(prerelease, /npm publish\s*$/m, 'an untagged npm publish would move the latest dist-tag');
    assert.match(prerelease, /if \[ "\$DIST_TAG" = latest \]/, 'no guard against dispatching dist_tag: latest');
    assert.match(prerelease, /\*-\*\) ;;/, 'no guard against dispatching a stable version');
  });

  it('tags rather than refuses a prerelease reaching the release path', () => {
    //Reachable only via a Release-As footer or prerelease config, but npm
    //publishes are permanent, so the release path must not assume 'latest'.
    const publish = jobs.get('publish');
    assert.match(publish, /case "\$version" in/, 'the release publish does not branch on the version');
    assert.match(publish, /npm publish --tag "\$tag"/, 'a prerelease from the release path would move latest');
  });

  it('keeps the prerelease version bump off the repository', () => {
    //release-please owns package.json's version and CHANGELOG.md. A committed
    //bump here would collide with its open release PR.
    assert.match(jobs.get('publish-prerelease'), /npm version "\$VERSION" --no-git-tag-version/);
  });

  it('passes dispatch inputs through the environment, not shell interpolation', () => {
    const prerelease = jobs.get('publish-prerelease');
    assert.match(prerelease, /VERSION: \$\{\{ inputs\.version \}\}/);
    assert.match(prerelease, /DIST_TAG: \$\{\{ inputs\.dist_tag \}\}/);
    //Those two env lines are the only places an input may be expanded; anywhere
    //else means it reaches a run script, where a crafted value is shell.
    const expansions = prerelease.match(/\$\{\{ *inputs\./g) ?? [];
    assert.equal(expansions.length, 2, 'dispatch inputs must only be expanded into env, never into a run script');
  });
});
