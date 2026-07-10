# Contributing

Pull requests are welcome from everyone.

## Development setup

```bash
git clone https://github.com/atdr/homebridge-philipsair-platform.git
cd homebridge-philipsair-platform
npm install
```

`npm run watch` links the plugin and starts a local Homebridge (`nodemon.json` controls
the invocation). Device communication needs the [`aioairctrl`](https://pypi.org/project/aioairctrl/)
CLI — see the README installation section.

## Quality gates

CI runs these six checks on Node 20/22/24; all must pass before a PR can merge:

```bash
npm run typecheck     # tsc with checkJs
npm run lint          # eslint (npm run lint:fix to autofix)
npm run format:check  # prettier (npm run format to write)
npm run check         # node --check syntax pass
npm run lint:md       # markdownlint (npm run lint:md:fix to autofix)
npm run test          # node:test unit suite
```

## Commits and pull requests

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)
(`type(scope): summary`) with types `feat`, `fix`, `refactor`, `test`, `docs`, `chore`,
or `ci`. A husky `commit-msg` hook and CI both enforce this — releases are cut
automatically by release-please from the commit history, so the type you pick decides
the version bump. Keep each commit to one logical change.

## Credits

> This project is based on <https://github.com/seydx/homebridge-philipsair-platform>, which was heavily inspired by <https://github.com/NikDevx/homebridge-philips-air>. Credit for the mappable config parameters goes to <https://github.com/we5/homebridge-philipsair-platform/tree/refactor/use-config-mappings>
