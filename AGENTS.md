# Agent guidance

This file provides guidance for AI agents working on this codebase. It reflects the
project as it stands today.

## Project overview

A Homebridge **dynamic platform** plugin for Philips air purifiers and humidifiers
(AC3036, AC1715, AC0850, and more).

The runtime flow is:

- `index.js` — registers the platform with Homebridge (plugin identifier taken from
  the package name).
- `src/platform.js` — `PhilipsAirPlatform` class; reads config, sets up devices on
  `didFinishLaunching`.
- `src/accessories/` — the accessory layer:
  - `accessories.setup.js` — device initialisation from config.
  - `accessories.service.js` — HomeKit service/characteristic wiring (onGet/onSet).
  - `accessories.handler.js` — device I/O (the bulk of the logic).
  - `accessories.config.js` — per-accessory config shaping.
  - `accessories.models.js` — per-model speed/key/value maps (pure data).
  - `index.js` — barrel export.
- `src/utils/` — `logger.js` (singleton logger), `utils.js` (`generateConfig`,
  `validBinaryPath`, `validHost`, `validPort`, `hapNumber`), and `preflight.js`
  (`checkAioairctrl`, run once at startup to verify the CLI before any device uses it).

**Key gotcha:** device communication is not pure JavaScript. `accessories.handler.js`
runs the [`aioairctrl`](https://pypi.org/project/aioairctrl/) CLI (the pip package that
implements the encrypted Philips CoAP protocol) as a child process via
`execFile`/`spawn` with argument arrays — never a shell string. The executable is
resolved from the PATH, or from the `aioairctrlPath` platform option when it lives
elsewhere (e.g. a pipx install in `~/.local/bin`). Any install method works as long as
the Homebridge user can run the binary. Changes to device I/O may span the JS handler
and the third-party `aioairctrl` package (whose behaviour this repo does not control).

User-facing config surface: `config.schema.json` (Homebridge UI schema) and
`example-config.json`.

Supported runtimes: Node `^20.18 || ^22.10 || ^24`, Homebridge `^1.8 || ^2.0.0`.

## Language and module format

All runtime code is **CommonJS** (`require` / `module.exports`). Do not introduce ESM
(`import` / `export`). Files start with `'use strict';`.

This is plain JavaScript — there is **no TypeScript** build, but `npm run typecheck`
runs `tsc` over the JS with `checkJs`, so code must typecheck. Match the existing
style: 2-space indentation, single quotes, and a 120-column print width, as enforced
by `eslint.config.js` and `.prettierrc.json`.

## Git workflow

Never commit directly to `main` — every change lands via a pull request.

**Branches** are named `<type>/<short-description>` using the same types as commit
messages, e.g. `fix/handler-timeout`, `docs/refresh-readme`.

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<optional scope>): <imperative summary>`. Allowed types are `feat`, `fix`,
`refactor`, `test`, `docs`, `chore`, and `ci`, enforced by commitlint
(`commitlint.config.js`) in CI and locally via the husky `commit-msg` hook. Keep each
commit to one logical change so it can be reviewed and reverted independently.

**Pull requests** target `main`. Their titles are checked in CI against the same
commitlint rules (`type(scope): summary`).

**Releases** are automated with release-please: a `feat` commit drives a minor bump, a
`fix` a patch. Do not bump the version or edit the changelog by hand.

**Prereleases** are published by hand from their own workflow: run **publish-prerelease**
from the Actions tab (`workflow_dispatch`) with a prerelease version and an npm dist-tag.
The bump happens on the runner only, so `main`, `CHANGELOG.md`, and the open release PR
are untouched, and the tag is never `latest`. Details in CONTRIBUTING.md; invariants are
guarded by `test/publish-prerelease-workflow.test.js` (the stable release path is guarded
by `test/publish-release-workflow.test.js`).

## Quality checks

Run all six gates before opening a PR — CI (`.github/workflows/ci.yml`) runs them on
Node 20/22/24 and every gate must pass:

```bash
npm run typecheck     # tsc with checkJs over the plain JS
npm run lint          # eslint (check only; use npm run lint:fix to autofix)
npm run format:check  # prettier (check only; use npm run format to write)
npm run check         # node --check syntax pass over all JS files
npm run lint:md       # markdownlint over all *.md (config in .markdownlint.json)
npm run test          # node:test unit suite in test/
```

Tests use the built-in `node:test` runner — no test framework dependencies. New logic
should come with tests; pure data/logic (models, utils, handler mapping) is the
easiest to cover.

CI also runs a **dependency audit** job that is not one of the six and has no local
script. It blocks on `npm audit --omit=dev` (production dependencies are the only ones
that reach a user's install) and reports the full tree with `continue-on-error`, so a
development advisory annotates the run without failing it. Dependabot alerts remain the
signal of record for the development tree. `test/ci-workflow.test.js` guards the split.

### Coverage

CI also runs a **coverage** job, which like the audit is not one of the six gates. It
re-runs the suite under V8 instrumentation to produce `lcov.info` and uploads it to
Codecov, which supplies the README badge, per-PR comments, and history. The Node matrix
is what proves the suite passes; coverage only reports on it. Codecov's own status
checks are set `informational` in `codecov.yml` so they can never block a merge, and the
upload step is `continue-on-error` because an outage there says nothing about the change
under review. The coverage run itself stays blocking.

Unlike the audit it has a local script, and CI calls that script rather than its own
command line so the two cannot drift:

```bash
npm run coverage      # needs Node >= 22.5; writes lcov.info (gitignored)
```

Two flags in it are load-bearing and worth not "tidying away":

- `--test-coverage-include` twice, pinned to the `files` array in `package.json`, so the
  measurement is exactly what ships. Without it V8 reports every file that was loaded,
  which pulls in `test/`, the fixture shims, and any `.claude/worktrees/` checkout.
- `--require ./src/platform.js --require ./index.js`. V8 reports **nothing at all** for a
  file no test ever required, rather than reporting it at 0%. Neither of those two is
  required by any test, so dropping the preload does not lower the score. It deletes the
  least-covered files from the report, raising it.

`npm run coverage` is deliberately absent from `prepublishOnly`: `--test-coverage-include`
needs Node 22.5, and this package still supports the `^20.18` floor, where node exits on
the unknown flag. `test/coverage.test.js` guards all of the above.

### Workflow naming and timeouts

GitHub labels a check `<workflow name> / <job name>` and never shows the filename, so
every workflow's top-level `name:` is the filename stem (`ci`, `claude`,
`publish-release`, `publish-prerelease`, `stale`) and the job carries the description
instead. This makes every check readable back to its source file without guessing.

Every job also sets `timeout-minutes`: GitHub's default is six hours, and the failure
that matters is a stall (`npm ci`/`npm publish` hanging on a network fetch), not an
error. 10 minutes is the default; `pr-title` gets 5 (cheapest job in the repo); `claude`
gets 30 (it runs an actual Claude Code session, not a fixed script).

**Exception:** `Analyze (actions)` / `Analyze (javascript-typescript)` / `CodeQL` come
from code scanning default setup, a repo setting rather than a file in
`.github/workflows`, so GitHub owns their names and timeouts and neither convention
reaches them.

### Confirm the full check set ran before merging

Workflow runs here can sit in **`action_required`** until someone approves them. A run in
that state produces **no check runs at all**, so `gh pr checks` reports only the checks
that did run and exits 0 — a PR whose CI has never started is indistinguishable from one
with only CodeQL configured. Waiting for "nothing pending" therefore proves nothing.

This is not hypothetical: it is how the v1.2.0 release failed. CI on the release PR sat in
`action_required`, was read as three green checks, and the PR was merged — four minutes
after the approved run had actually gone red.

Before merging, confirm the Node 20.x/22.x/24.x jobs are present in `gh pr checks` (not
merely that nothing is pending), and check for a blocked run:

```bash
gh run list --branch "$(gh pr view <n> --json headRefName --jq .headRefName)" \
  --json conclusion,workflowName --jq '.[] | select(.conclusion=="action_required")'
```

Re-read the checks immediately before merging. Approval can land, and a run can go red,
between an earlier check and the merge.

## Logging

All runtime log output must go through the singleton logger in `src/utils/logger.js`.
Do not use `console.log` / `console.warn` / `console.error` directly in runtime code.

The logger is configured once, in `src/platform.js`, via `logger.configure(log, config)`,
which wires it to the Homebridge log and honours the `debug`, `warn`, `error`, and
`extendedError` config flags. Everywhere else, require the logger and call it:

```js
const logger = require('./utils/logger'); // adjust the path relative to the file
logger.info('Thing happened');
logger.debug('Detail', accessoryName);
logger.error(err, accessoryName);
```

`logger.alert(message)` is a fifth level that ignores the `error` flag. It exists for
**setup faults that stop the plugin working at all** — currently only the startup
`aioairctrl` preflight in `src/platform.js`. The log flags are verbosity switches for
per-device operational noise, so a user who turned `error` off has not asked to be kept
in the dark about an install that cannot work. Do not reach for it to make an ordinary
warning louder: anything the plugin can recover from belongs on `warn`/`error`.

## Docs

A PR that adds, removes, or changes a module, config option, or supported device must
update the affected docs in the **same PR**. Before opening a PR, grep the docs for names
related to your change.

Where a doc/code invariant can be checked mechanically, prefer a `node:test` check over a
prose rule so CI catches drift instead of relying on a reviewer grepping.
`test/config.schema.test.js` (model typeahead ⊇ mapped models) and `test/docs.test.js`
(README config table, `example-config.json`, and README tested-device list track
`config.schema.json` / `accessories.models.js`) are the pattern to copy when you add a new
config option, model, or device. Specific sync rules:

**`README.md`** — the tested/supported device list, example configs, and supported
clients must track what the code and `config.schema.json` actually support. Installation
and setup steps may only reference files that exist in the repo.

**`config.schema.json` + `example-config.json`** — the source of truth for user
configuration. When adding, changing, or removing a config option, update both, and keep
the README example configs consistent with them.

**`CHANGELOG.md`** — managed by release-please, which prepends generated entries above
the hand-written v1.x history (one reason commit messages must follow the conventional
format). Do not edit it by hand and do not restructure the existing entries.

Because it is generated, it is exempt from this repo's formatters: `.prettierignore` lists
it and `lint:md` passes `--ignore CHANGELOG.md`. Do not remove either. `prepublishOnly`
runs both gates before every publish, so a formatting rule release-please does not follow
fails the release itself — that is how the v1.2.0 publish was blocked after its GitHub
release had already been cut. Guarded by `test/publish-release-workflow.test.js`.
