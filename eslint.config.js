'use strict';

const js = require('@eslint/js');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  {
    //a second checkout of this repo lives here while an agent session holds a
    //worktree; linting that copy reports every file twice and fails on any work
    //in progress it happens to contain
    ignores: ['node_modules/', '.claude/worktrees/'],
  },
  js.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },
];
