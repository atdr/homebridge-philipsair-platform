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
- `src/utils/` — `logger.js` (singleton logger) and `utils.js` (`generateConfig`,
  `validHost`).

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

Supported runtimes: Node `^20.18 || ^22.10 || ^24`, Homebridge `^1.8 || ^2.0.0-beta`.

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

## Quality checks

Run all five gates before opening a PR — CI (`.github/workflows/ci.yml`) runs them on
Node 20/22/24 and every gate must pass:

```bash
npm run typecheck     # tsc with checkJs over the plain JS
npm run lint          # eslint (check only; use npm run lint:fix to autofix)
npm run format:check  # prettier (check only; use npm run format to write)
npm run check         # node --check syntax pass over all JS files
npm run test          # node:test unit suite in test/
```

Tests use the built-in `node:test` runner — no test framework dependencies. New logic
should come with tests; pure data/logic (models, utils, handler mapping) is the
easiest to cover.

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

## Docs

A PR that adds, removes, or changes a module, config option, or supported device must
update the affected docs in the **same PR**. Before opening a PR, grep the docs for names
related to your change. Specific sync rules:

**`README.md`** — the tested/supported device list, example configs, and supported
clients must track what the code and `config.schema.json` actually support. Installation
and setup steps may only reference files that exist in the repo.

**`config.schema.json` + `example-config.json`** — the source of truth for user
configuration. When adding, changing, or removing a config option, update both, and keep
the README example configs consistent with them.

**`CHANGELOG.md`** — managed by release-please, which prepends generated entries above
the hand-written v1.x history (one reason commit messages must follow the conventional
format). Do not edit it by hand and do not restructure the existing entries.
