'use strict';

//Drift guard for the workflow naming convention documented in AGENTS.md: GitHub
//labels every check "<workflow name> / <job name>" and never shows the filename,
//so each workflow's top-level `name:` must be its filename stem. Without this,
//a renamed file or a copy-pasted new workflow can silently drift from its name
//and strand a check that no longer reads back to its source.
//Same convention as atdr/contrail-gh#7.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const workflowsDir = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(workflowsDir).filter((file) => file.endsWith('.yml'));

describe('workflow naming', () => {
  it('found workflow files to check', () => {
    assert.ok(files.length > 0, 'no workflow files under .github/workflows');
  });

  for (const file of files) {
    it(`${file} names itself after its file`, () => {
      const contents = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
      const match = contents.match(/^name:\s*(.+)$/m);
      assert.ok(match, `${file} has no top-level 'name:' key`);
      assert.equal(match[1].trim(), path.basename(file, '.yml'));
    });
  }
});
