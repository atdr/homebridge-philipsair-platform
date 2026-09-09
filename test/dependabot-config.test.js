'use strict';

//Drift guard for .github/dependabot.yml. Security advisories here are deliberately
//ungrouped, and that is the kind of decision a later tidy-up reverses without knowing
//it was one, because grouping reads as obviously tidier than not grouping.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

//Comments are stripped first. The comment in dependabot.yml has to name the key it is
//warning about, so a guard reading the raw file would fire on its own explanation.
const config = fs.readFileSync(path.join(__dirname, '..', '.github', 'dependabot.yml'), 'utf8').replace(/#.*$/gm, '');

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

  it('still groups development version updates', () => {
    //Weekly version bumps do arrive together, and batching those is the noise reduction
    //this config was added for. Only the security half is unsafe to group.
    assert.match(config, /^ {6}dev-dependencies:$/m, 'the dev-dependencies version-update group is gone');
  });
});
