'use strict';

//Drift guards for the coverage job in .github/workflows/ci.yml and the `coverage`
//script it runs. Coverage is reporting, not a gate: the Node matrix is what proves the
//suite passes. But a report that quietly measures the wrong thing is worse than
//no report, because the number still looks authoritative.
//
//Two invariants are easy to lose and silent when lost:
//
//1. Scope. V8 reports every file that was loaded, so without --test-coverage-include
//   the report covers test/, the fixture shims, and the second checkout of this repo
//   under .claude/worktrees/ (test/worktree-ignores.test.js lists the other gates
//   that copy breaks). The include list is pinned to package.json's `files` array so
//   what is measured is exactly what ships.
//
//2. Preload. V8 reports nothing at all for a file no test ever required, rather than
//   reporting it at 0%. src/platform.js and index.js are required by no test, so
//   dropping the --require flags does not lower the score. It deletes the two
//   least-tested files from the report and raises it.
//
//CI runs `npm run coverage` rather than its own command line, so both invariants are
//checked once here and hold locally and in CI alike.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const script = pkg.scripts.coverage ?? '';
const workflow = read('.github/workflows/ci.yml');

//The LCOV file name has to agree in three places: the script that writes it, the CI
//step that uploads it, and .gitignore. Take the script as the source of truth.
const LCOV = 'lcov.info';

//Same job splitting as test/ci-workflow.test.js: job keys are the only two-space
//indented keys with no inline value, so a heading regex suffices without a YAML
//parser (this repo ships no runtime dependencies).
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

describe('coverage script', () => {
  it('exists', () => {
    assert.ok(pkg.scripts.coverage, 'package.json needs a coverage script; ci.yml runs it');
  });

  it('measures exactly what the package ships', () => {
    //A new shipped directory should fail here until it is added to the include list,
    //rather than silently sitting outside the measurement.
    const expected = pkg.files
      .filter((entry) => !entry.endsWith('.json'))
      .map((entry) => (entry.endsWith('.js') ? entry : `${entry}/**`))
      .sort();
    const includes = [...script.matchAll(/--test-coverage-include='([^']+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      includes,
      expected,
      'the --test-coverage-include list must cover every code entry in the package files array'
    );
  });

  it('preloads the source no test requires', () => {
    //Without these the report omits src/platform.js and index.js entirely, which
    //raises the headline percentage instead of lowering it.
    for (const entry of ['./src/platform.js', './index.js']) {
      assert.ok(
        script.includes(`--require ${entry}`),
        `coverage must preload ${entry}, or V8 drops it from the report rather than scoring it 0%`
      );
    }
  });

  it(`writes ${LCOV} for the upload`, () => {
    assert.match(script, /--test-reporter=lcov/);
    assert.match(script, new RegExp(`--test-reporter-destination=${LCOV.replace('.', '\\.')}`));
  });

  it('stays out of the publish gates', () => {
    //--test-coverage-include needs Node >= 22.5, below which node exits on the unknown
    //flag. package.json still supports ^20.18, so a publish must never depend on it.
    assert.doesNotMatch(pkg.scripts.prepublishOnly, /coverage/, 'coverage is not a gate and must not gate a publish');
  });
});

describe('CI coverage job', () => {
  const job = () => {
    const block = jobs.get('coverage');
    assert.ok(block, 'no coverage job in ci.yml');
    return block;
  };

  it('runs the same command as a developer would', () => {
    assert.match(job(), /run: npm run coverage/, 'CI must call the npm script, so CI and local cannot drift apart');
  });

  it('uploads the file the script writes', () => {
    assert.match(job(), new RegExp(`files: \\./${LCOV.replace('.', '\\.')}`));
    assert.match(job(), /uses: codecov\/codecov-action@v\d+/);
  });

  it('lets the upload fail without failing the job', () => {
    //An outage at Codecov, or a missing CODECOV_TOKEN, says nothing about the change
    //under review. The test run itself stays blocking: a job that can never fail is a
    //check that proves nothing.
    const upload = job().slice(job().indexOf('codecov/codecov-action'));
    assert.match(upload, /fail_ci_if_error: false/);
    assert.doesNotMatch(
      job(),
      /^ {4}continue-on-error: true/m,
      'continue-on-error belongs on the upload step, not the job'
    );
  });

  it('skips PR jobs once the pull request is closed', () => {
    //Same guard as every other job: 'edited' events fire for merged PRs.
    assert.match(job(), /if: github\.event_name == 'push' \|\| github\.event\.pull_request\.state == 'open'/);
  });
});

describe('coverage reporting config', () => {
  it(`keeps ${LCOV} out of git`, () => {
    assert.ok(
      read('.gitignore')
        .split('\n')
        .some((line) => line.trim() === LCOV),
      `.gitignore must list ${LCOV}; the existing *.lcov entry does not match it`
    );
  });

  it('leaves Codecov unable to block a merge', () => {
    //Without this, Codecov adds two status checks it owns to every PR. CI is the gate.
    const codecov = read('codecov.yml');
    const informational = [...codecov.matchAll(/informational: true/g)];
    assert.equal(informational.length, 2, 'both the project and patch statuses must be informational');
    for (const status of ['project:', 'patch:']) {
      assert.ok(codecov.includes(status), `codecov.yml must configure the ${status.slice(0, -1)} status`);
    }
  });

  it('is advertised in the README', () => {
    assert.match(read('README.md'), /codecov\.io\/gh\/atdr\/homebridge-philipsair-platform/);
  });
});
