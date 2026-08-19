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
    //Every job on the dispatch path, so a later one cannot reintroduce the hole.
    for (const name of ['publish-prerelease', 'tag-prerelease']) {
      const job = jobs.get(name);
      assert.match(job, /VERSION: \$\{\{ inputs\.version \}\}/, `${name} does not read version through env`);
      assert.match(job, /DIST_TAG: \$\{\{ inputs\.dist_tag \}\}/, `${name} does not read dist_tag through env`);
      //Those two env lines are the only places an input may be expanded; anywhere
      //else means it reaches a run script, where a crafted value is shell.
      const expansions = job.match(/\$\{\{ *inputs\./g) ?? [];
      assert.equal(expansions.length, 2, `${name} must only expand dispatch inputs into env, never into a run script`);
    }
  });

  it('tags the commit a published prerelease came from', () => {
    //The tag is what maps a beta a tester is running back to a commit on main.
    const tag = jobs.get('tag-prerelease');
    assert.ok(tag, 'no tag-prerelease job');
    assert.match(tag, /needs: publish-prerelease/, 'a tag must not outlive a failed publish');
    assert.match(tag, /refs\/tags\/prerelease\/\$VERSION/, 'the tag does not name the published version');
    assert.match(tag, /sha=\$GITHUB_SHA/, 'the tag does not point at the dispatched commit');
  });

  it('never turns a prerelease into a GitHub Release', () => {
    //release-please reads the Releases API to find the last release and applies
    //no prerelease filter, so a 1.2.0-beta.5 Release would outrank v1.1.0 and
    //become the version it bumps from. A plain ref is invisible to it: bare tags
    //are only its third-choice fallback, unreachable while a merged release PR or
    //a Release exists.
    const tag = jobs.get('tag-prerelease');
    assert.match(tag, /git\/refs/, 'the tag is not created through the plain git refs API');
    assert.doesNotMatch(
      tag,
      /gh release create|action-gh-release|\/releases/,
      'a GitHub Release would be read as the latest release'
    );
    //Belt-and-braces, and keeps `git tag -l 'v*'` meaning released versions.
    assert.doesNotMatch(tag, /refs\/tags\/v/, 'prerelease tags should not share the release tag namespace');
  });

  it('grants write access only to the job that creates the tag', () => {
    assert.match(jobs.get('tag-prerelease'), /contents: write/, 'the tag job cannot push a ref');
    for (const name of ['publish', 'publish-prerelease']) {
      assert.match(jobs.get(name), /contents: read/, `${name} should not hold a writable token while publishing`);
    }
  });
});

//CHANGELOG.md is generated by release-please and AGENTS.md forbids editing it
//by hand, so the repo's own formatters must not have an opinion about it. When
//they did, prepublishOnly's lint:md failed on the generated file and blocked
//the v1.2.0 publish after the GitHub release had already been cut.
describe('generated changelog', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const prettierIgnore = fs.readFileSync(path.join(__dirname, '..', '.prettierignore'), 'utf8');

  it('is excluded from markdownlint', () => {
    assert.match(
      pkg.scripts['lint:md'],
      /--ignore CHANGELOG\.md/,
      'lint:md must skip CHANGELOG.md: release-please writes it, and prepublishOnly runs lint:md before every publish'
    );
  });

  it('is excluded from prettier', () => {
    assert.ok(prettierIgnore.split('\n').includes('CHANGELOG.md'), '.prettierignore must list CHANGELOG.md');
  });

  //the gate that turned a formatting nit into a failed release
  it('is not reachable through prepublishOnly by any other formatter', () => {
    const publishGates = pkg.scripts.prepublishOnly;

    assert.match(publishGates, /lint:md/, 'prepublishOnly no longer runs lint:md; this guard needs revisiting');
    assert.match(
      publishGates,
      /format:check/,
      'prepublishOnly no longer runs format:check; this guard needs revisiting'
    );
  });
});
