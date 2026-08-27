'use strict';

//Drift guard for the agent worktree ignores.
//
//An agent session that calls EnterWorktree checks a second copy of this repo out
//under .claude/worktrees/. Every gate that walks the tree from the repo root then
//sees that copy: eslint and the check script parse its JavaScript, prettier and
//markdownlint check its prose. A worktree holding work in progress therefore turns
//four gates red for reasons that have nothing to do with the branch under test,
//which happened once already and cost a debugging session.
//
//The dangerous repair is to weaken a gate to quieten the noise, so the ignores are
//checked here rather than left to a reviewer noticing they went missing. Node's
//test runner and tsc need no entry: `node --test` does not descend into dot
//directories, and tsconfig.json names its inputs with an explicit `include`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const pkg = JSON.parse(read('package.json'));

describe('agent worktrees', () => {
  it('are ignored by git', () => {
    assert.ok(
      read('.gitignore')
        .split('\n')
        .some((line) => line.trim() === '.claude/worktrees/'),
      '.gitignore must list .claude/worktrees/ so a worktree is never staged'
    );
  });

  it('are ignored by prettier', () => {
    assert.ok(
      read('.prettierignore')
        .split('\n')
        .some((line) => line.trim() === '.claude/worktrees/'),
      '.prettierignore must list .claude/worktrees/: prettier walks dot directories'
    );
  });

  it('are ignored by eslint', () => {
    assert.match(
      read('eslint.config.js'),
      /ignores:[^\]]*'\.claude\/worktrees\/'/,
      "eslint.config.js must ignore '.claude/worktrees/': `eslint .` walks dot directories"
    );
  });

  it('are ignored by the syntax check', () => {
    assert.match(
      pkg.scripts.check,
      /-not -path '\.\/\.claude\/worktrees\/\*'/,
      'the check script must prune .claude/worktrees, or find hands node --check a second copy of every file'
    );
  });

  it('are ignored by markdownlint', () => {
    for (const script of ['lint:md', 'lint:md:fix']) {
      assert.match(
        pkg.scripts[script],
        /--ignore \.claude\/worktrees/,
        `${script} must skip .claude/worktrees: --dot makes markdownlint descend into it`
      );
    }
  });
});
