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

CI additionally runs a dependency audit, which has no local equivalent. It blocks on
high severity advisories in production dependencies and merely reports them for
development ones, since linters and commit tooling never ship to users. A red
"Dependency audit" annotation with the job still green is that second, advisory step.

## Commits and pull requests

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/)
(`type(scope): summary`) with types `feat`, `fix`, `refactor`, `test`, `docs`, `chore`,
or `ci`. A husky `commit-msg` hook and CI both enforce this — releases are cut
automatically by release-please from the commit history, so the type you pick decides
the version bump. Keep each commit to one logical change.

## Prerelease builds

To get a build in front of a tester without cutting a release, run the
**Release Please** workflow from the Actions tab (Run workflow) and give it:

- **version** — a prerelease version such as `1.2.0-beta.1`. The workflow refuses
  anything without a prerelease suffix.
- **dist_tag** — the npm tag to publish under, `beta` by default. It refuses `latest`.

Testers then install it explicitly, and nobody else picks it up, because Homebridge
installs the `latest` tag:

```bash
npm install @atdr/homebridge-philipsair-platform@beta
```

Run workflow lets you pick the branch, so a prerelease can come from a PR branch before
it merges (the branch needs this workflow file in it). The version bump happens on the
runner and is never committed, so `main`, `CHANGELOG.md`, and any open release-please PR
are untouched, and the eventual `1.2.0` release still sorts above every `1.2.0-beta.n`.
The six checks above still run, via `prepublishOnly`.

Published versions are permanent past npm's 72 hour unpublish window, so treat the
dispatch form as irreversible and bump the `.n` rather than reusing a version.

A prerelease can also come through the normal release path, from a
`Release-As: 1.2.0-beta.1` commit footer. That is a deliberate act, so the release job
publishes it rather than refusing it, under a tag taken from the version's own
identifier (`1.2.0-beta.1` publishes to `beta`). Either way, `latest` only ever points
at a stable version.

## Credits

> This project is based on <https://github.com/seydx/homebridge-philipsair-platform>, which was heavily inspired by <https://github.com/NikDevx/homebridge-philips-air>. Credit for the mappable config parameters goes to <https://github.com/we5/homebridge-philipsair-platform/tree/refactor/use-config-mappings>
