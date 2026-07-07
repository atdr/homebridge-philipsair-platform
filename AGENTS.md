# Agent guidance

This file provides guidance for AI agents working on this codebase. It reflects the
project as it stands today; conventions that are not yet automated are flagged
**Planned (later phase)**.

## Project overview

A Homebridge **dynamic platform** plugin for Philips air purifiers and humidifiers
(AC3036, AC1715, AC0850, and more).

The runtime flow is:

- `index.js` — registers the platform with Homebridge.
- `src/platform.js` — `PhilipsAirPlatform`; reads config, sets up devices on
  `didFinishLaunching`.
- `src/accessories/` — the accessory layer:
  - `accessories.setup.js` — device initialisation from config.
  - `accessories.service.js` — HomeKit service/characteristic wiring.
  - `accessories.handler.js` — device I/O (the bulk of the logic).
  - `accessories.config.js` — per-accessory config shaping.
  - `index.js` — barrel export.
- `src/utils/` — `logger.js` (singleton logger) and `utils.js` (`generateConfig`).

**Key gotcha:** device communication is not pure JavaScript. `accessories.handler.js`
shells out via Node's `child_process` (`exec`/`spawn`) to `lib/pyaircontrol.py`. That
script is a thin wrapper around [`aioairctrl`](https://pypi.org/project/aioairctrl/),
the pip package that implements the encrypted Philips CoAP protocol. Python 3 and
`aioairctrl` (via `pip install aioairctrl`) must be available on the host, and changes
to device I/O may span the JS handler, the Python wrapper, and the third-party
`aioairctrl` package (whose behaviour this repo does not control).

`aioairctrl` must be importable by the **system** `python3`; installs isolated by pipx
or a virtualenv are not picked up, and on PEP 668 systems (Debian 12+) the supported
install is `sudo python3 -m pip install --break-system-packages aioairctrl`. **Planned
(later phase):** invoke the `aioairctrl` executable directly via `spawn`/`execFile`
(path configurable) and delete the wrapper, so pipx installs work — see
[#1](https://github.com/atdr/homebridge-philipsair-platform/issues/1).

User-facing config surface: `config.schema.json` (Homebridge UI schema) and
`example-config.json`.

Supported runtimes: Node `^20.18 || ^22.10 || ^24`, Homebridge `^1.8 || ^2.0.0-beta`.

## Language and module format

All runtime code is **CommonJS** (`require` / `module.exports`). Do not introduce ESM
(`import` / `export`). Files start with `'use strict';`.

This is plain JavaScript — there is **no TypeScript** and no JSDoc typedef system. Match
the existing style: 2-space indentation, single quotes, and a 120-column print width, as
enforced by `.eslintrc.js` and `.prettierrc.json`.

## Git workflow

Never commit directly to `main` — every change lands via a pull request.

**Branches** are named `<type>/<short-description>` using the same types as commit
messages, e.g. `fix/handler-timeout`, `docs/refresh-readme`.

**Commits** follow [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<optional scope>): <imperative summary>`. Allowed types are `feat`, `fix`,
`refactor`, `test`, `docs`, `chore`, and `ci`. Keep each commit to one logical change so
it can be reviewed and reverted independently.

**Pull requests** target `main` and use the same conventional format for their title
(`type(scope): summary`).

**Planned (later phase):** commit messages will be linted by commitlint
(`@commitlint/config-conventional`) both in CI and locally via a husky `commit-msg` hook;
PR titles will be checked with the same rules; and releases (version bumps + changelog)
will be automated with release-please, driving a minor bump from `feat` and a patch from
`fix`.

## Quality checks

Run **today** before opening a PR:

```bash
npm run lint    # eslint --fix . (also applies Prettier via plugin:prettier/recommended)
```

Note that `npm run lint` **rewrites files** (it runs eslint with `--fix`), so expect it
to leave changes in the working tree; include them in your commit. There are currently
**no tests**: `npm test` is an empty script that exits successfully without testing
anything, so do not treat it as verification. `npm run build` only deletes `dist/` and
builds nothing.

**Planned (later phase):** a five-gate set will run in CI and should be run locally once
the scripts exist — `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run check` (syntax check), and `npm run test`. These scripts do not exist yet; do
not attempt to run them until they do.

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

**`CHANGELOG.md`** — maintained by hand for now; add an entry for any user-facing
change. **Planned (later phase):** release-please will take over, prepending generated
entries above the existing hand-written ones (one reason commit messages must follow the
conventional format). Do not restructure the existing entries in the meantime.
