# Contributing

Bug reports, device status dumps and pull requests are all welcome.

- **Something is broken?** Check [Troubleshooting](README.md#troubleshooting) first,
  then open a
  [bug report](https://github.com/atdr/homebridge-philipsair-platform/issues/new?template=bug_report.yml).
  The form asks for the model ID and a debug log, which is what a diagnosis usually
  turns on.
- **Your model is not supported?** Open a
  [model support request](https://github.com/atdr/homebridge-philipsair-platform/issues/new?template=model_support.yml)
  with an `aioairctrl -H <ip> -P 5683 status -J` dump. That dump is what a new mapping
  in `src/accessories/accessories.models.js` is derived from.
- **Sending code?** Read on.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security issues go through the [security policy](SECURITY.md), not a public issue.

## Development setup

```bash
git clone https://github.com/atdr/homebridge-philipsair-platform.git
cd homebridge-philipsair-platform
npm install
```

`npm run watch` links the plugin and starts a local Homebridge (`nodemon.json` controls
the invocation). Device communication needs the
[`aioairctrl`](https://pypi.org/project/aioairctrl/) CLI, covered in the README
installation section.

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
or `ci`. A husky `commit-msg` hook and CI both enforce this. Releases are cut
automatically by release-please from the commit history, so the type you pick decides
the version bump. Keep each commit to one logical change.

## Docs

A change that adds, removes, or alters a config option, a module, or a supported device
updates the affected docs in the same PR. `config.schema.json` and `example-config.json`
are the source of truth for user configuration, and the README tracks both.

`test/config.schema.test.js` and `test/docs.test.js` enforce the parts of this that
can be checked mechanically, so CI catches the drift rather than a reviewer having to
grep for it. Each opens with a comment saying what it covers and what a failure means.
When a new invariant can be checked that way, prefer adding a check to writing a prose
rule.

## Prerelease builds

To get a build in front of a tester without cutting a release, run the
**Release Please** workflow from the Actions tab (Run workflow) and give it:

- **version**: a prerelease version such as `1.2.0-beta.1`. The workflow refuses
  anything without a prerelease suffix.
- **dist_tag**: the npm tag to publish under, `beta` by default. It refuses `latest`.

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

Each published prerelease is tagged `prerelease/<version>` at the commit it was built
from, so a bug report against a beta can be read against the code that beta actually
contained:

```bash
git fetch --tags
git log prerelease/1.2.0-beta.1..main   # what has landed since that beta
git show prerelease/1.2.0-beta.1
```

The tag is a plain ref and never a GitHub Release. release-please finds the last release
by reading the Releases API and applies no prerelease filter, so a `1.2.0-beta.5` Release
would outrank `v1.1.0` and become the version it bumps from. Bare tags are only its
third-choice fallback, unreachable while a merged release PR or a Release exists, so the
tag itself is inert either way; the `prerelease/` prefix is belt-and-braces and keeps
`git tag -l 'v*'` meaning released versions.

A prerelease can also come through the normal release path, from a
`Release-As: 1.2.0-beta.1` commit footer. That is a deliberate act, so the release job
publishes it rather than refusing it, under a tag taken from the version's own
identifier (`1.2.0-beta.1` publishes to `beta`). Either way, `latest` only ever points
at a stable version.
