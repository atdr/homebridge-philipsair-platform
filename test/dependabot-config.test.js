'use strict';

//Drift guard for .github/dependabot.yml. Security advisories here are deliberately
//ungrouped, and that is the kind of decision a later tidy-up reverses without knowing
//it was one, because grouping reads as obviously tidier than not grouping.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

//Read rather than required: tsc types package.json from its literal contents, so with no
//`dependencies` key today `pkg.dependencies` is a type error, which is the exact absence
//this guard exists to notice changing.
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

//Comments are stripped first. The comment in dependabot.yml has to name the key it is
//warning about, so a guard reading the raw file would fire on its own explanation.
const config = fs.readFileSync(path.join(__dirname, '..', '.github', 'dependabot.yml'), 'utf8').replace(/#.*$/gm, '');

//One block per ecosystem. Only the npm one describes what reaches a user's install; the
//github-actions block carries its own unrelated `prefix: ci`.
const npmBlock = config.split(/^ {2}- package-ecosystem:/m).find((block) => block.trimStart().startsWith('npm'));
assert.ok(npmBlock, 'dependabot.yml has no npm ecosystem block');

describe('Dependabot configuration', () => {
  it('leaves security updates ungrouped', () => {
    //A grouped security update filtered a high advisory out of its own job and still
    //reported success (js-yaml, alert 14, September 2026), which is the worst shape a
    //security signal can take. Grouping bought nothing to offset it either: advisories
    //arrive here one at a time, ten in a row bar a single same-day pair.
    assert.doesNotMatch(
      config,
      /applies-to:\s*security-updates/,
      'security advisories are deliberately ungrouped; see the comment in dependabot.yml'
    );
  });

  it('ties the npm commit prefix to whether the package has runtime dependencies', () => {
    //This is what makes the revert deterministic rather than remembered. Today every npm
    //bump is dev-tree only, so `fix(deps)` could only ever cut a release for a lockfile
    //change no consumer receives: npm never publishes package-lock.json, so consumers
    //resolve their own tree from the ranges in package.json. Declaring a runtime
    //dependency stops that being true, and this fails on the PR that declares one.
    const match = npmBlock.match(/^[ \t]+prefix:[ \t]*(\S+)[ \t]*$/m);
    assert.ok(match, 'the npm block declares no commit-message prefix');

    const runtime = Object.keys(pkg.dependencies ?? {});
    if (runtime.length > 0) {
      assert.equal(
        match[1],
        'fix(deps)',
        `package.json now declares runtime dependencies (${runtime.join(', ')}), which do reach a user's ` +
          "install, so dependabot.yml's npm prefix must go back to fix(deps) and let release-please cut a patch"
      );
    } else {
      assert.equal(
        match[1],
        'chore(deps)',
        'there are no runtime dependencies, so every npm bump is dev-tree only and must stay release-silent'
      );
    }
  });

  it('still groups development version updates', () => {
    //Weekly version bumps do arrive together, and batching those is the noise reduction
    //this config was added for. Only the security half is unsafe to group.
    assert.match(config, /^ {6}dev-dependencies:$/m, 'the dev-dependencies version-update group is gone');
  });
});
