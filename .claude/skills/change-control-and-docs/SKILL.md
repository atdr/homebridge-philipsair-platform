---
name: change-control-and-docs
description: How changes land in this repo and what must stay in sync - the rationale behind the branch/commit/PR/release-please conventions, the release and npm publishing path (OIDC trusted publishing), and the mechanical docs-sync table including when to update these skills. Load before committing, opening a PR, cutting a release, or whenever a change touches config options, models, modules, or docs. Not a restatement of AGENTS.md - read that first; this adds the WHY and the sync obligations.
---

# Change control and docs sync

AGENTS.md is the doc of record for the workflow itself: branch naming, Conventional
Commits, the six quality gates, logging rules, and the docs rules. CONTRIBUTING.md is
the human-facing summary. **Follow those; this skill only adds rationale, the release
path, and a mechanical sync table.** On any conflict, AGENTS.md wins.

When NOT to use this skill: test-writing specifics are in `testing-and-validation`;
what the gates catch at runtime is not covered here.

## Why the conventions are load-bearing (not ceremony)

- **Commit types drive releases.** release-please reads the merged commit history:
  `feat` → minor bump, `fix` → patch. A mislabeled type ships a wrong version number
  and changelog entry. That is also why commitlint checks both commits and PR titles in
  CI (`.github/workflows/ci.yml`) — squash merges take the PR title as the commit.
- **Never hand-edit `CHANGELOG.md` or `version`.** release-please owns both; it
  prepends above the hand-written v1.x history. Hand edits collide with its PRs
  (AGENTS.md states the rule; this is the mechanism behind it).
- **Releasing = merging the release-please PR.** After changes merge to `main`,
  release-please opens/updates a release PR; merging it tags the release and triggers
  `npm publish` in `.github/workflows/release-please.yml`.
- **Prereleases are a manual dispatch of the same workflow.** `workflow_dispatch` on
  `.github/workflows/release-please.yml` takes a `version` and a `dist_tag`, bumps the
  version on the runner with `--no-git-tag-version`, and publishes under that tag. It
  lives in that file rather than its own because npm allows **one trusted publisher per
  package, pinned to a workflow filename** — a second workflow would fail OIDC auth until
  the publisher is repointed on npmjs.com. The guards (no stable version, never `latest`,
  never committed, inputs read via `env`) are asserted by `test/release-workflow.test.js`;
  fix the workflow, not the test. Note `npm publish` tags whatever it publishes `latest`
  unless `--tag` is passed: npm does not infer anything from the `-beta.1` suffix. For
  the same reason the release `publish` job branches on the version and derives a tag
  from the prerelease identifier (`1.2.0-beta.1` → `beta`), so a deliberate
  `Release-As: 1.2.0-beta.1` footer publishes correctly instead of moving `latest`.
- **npm publishing uses trusted publishing (OIDC)** — GitHub Actions authenticates to
  npm directly; there is no `NPM_TOKEN` secret to leak or rotate, and provenance is
  automatic (PR #3). If publishing breaks, the trusted-publisher configuration lives on
  npmjs.com under the package settings (maintainer account required — agents cannot fix
  this side).
- **One logical change per commit** exists so a bad change can be reverted without
  collateral (AGENTS.md); the release automation above amplifies the cost of tangled
  commits.
- **Dependabot PRs** arrive pre-formatted from `.github/dependabot.yml`, and the prefix
  encodes whether the bump reaches users. Development bumps are `chore(deps)` and
  release-silent; production bumps are `fix(deps)` and cut a patch release. The split
  exists because npm never publishes `package-lock.json`, so consumers resolve their own
  tree from the ranges in `package.json`: only a direct production bump changes what they
  install. There are no runtime dependencies today, so every bump is currently `chore`.
  Dev minor/patch updates are grouped, as are dev security advisories (a group needs
  `applies-to: security-updates` to cover advisories at all; the default is version
  updates only). Majors and production advisories arrive individually for isolated review
  (commit bce7dc3). Major toolchain bumps sometimes need real fixes — e.g.
  TypeScript 7 required config and JSDoc changes (commit 4292672).
- **The CI audit job mirrors that same split** and is not one of the six gates: it blocks
  on `npm audit --omit=dev` and reports the full tree with `continue-on-error`, so a red
  "Dependency audit" annotation on a green job is the development tree, not a regression
  in the PR. Both steps use `--package-lock-only`, so nothing is installed from the tree
  being audited. `test/ci-workflow.test.js` asserts the production step can never become
  non-blocking; fix the workflow, not the test. A dev advisory that Dependabot
  auto-dismisses still shows up here, and is cleared by hand with
  `npm update <pkg> --package-lock-only` (commit 5389f52).

## Docs-sync obligations (mechanical table)

"Same PR" means the PR does not merge without the update. Rows marked **enforced** fail
CI via the named test if forgotten; the others rely on you.

| If your change touches...                                                                                                            | You must also update (same PR)                                                                         | Enforced by                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A config option (add/change/remove)                                                                                                  | `config.schema.json` + `example-config.json` + README field table and example configs                  | `test/docs.test.js` (README table ↔ schema, example ↔ schema)                                                         |
| A model mapping in `accessories.models.js`                                                                                           | `config.schema.json` typeahead + README "Tested devices"                                               | `test/config.schema.test.js`, `test/docs.test.js`                                                                     |
| A module (add/remove/rename in `src/`)                                                                                               | AGENTS.md module map; README if user-visible                                                           | Not enforced — grep AGENTS.md for the old name                                                                        |
| Supported Node/Homebridge versions (`engines`)                                                                                       | README "Supported clients"; AGENTS.md; CI matrix                                                       | Not enforced                                                                                                          |
| Install/setup behaviour (binary resolution, `aioairctrlPath`, error text)                                                            | README Installation + Troubleshooting                                                                  | Not enforced                                                                                                          |
| **Anything a skill in `.claude/skills/` states as fact** — commands, flags, log strings, timings, file paths, invariants, model data | The affected `SKILL.md`, same PR. Run each skill's "Provenance and maintenance" commands to find drift | `test/skills.test.js` (frontmatter + `src`/`test` path references); everything else relies on the provenance commands |
| A doc/code invariant that could be checked mechanically                                                                              | Prefer adding a `node:test` guard over prose (AGENTS.md "Docs"; `test/docs.test.js` is the pattern)    | The new test, once you write it                                                                                       |

## Landing a change: the loop

```bash
git checkout -b <type>/<short-description>   # types per AGENTS.md
# ...edit, keeping one logical change per commit...
npm run typecheck && npm run lint && npm run format:check && npm run check && npm run lint:md && npm test
git commit  # husky commit-msg hook runs commitlint locally
git push -u origin <type>/<short-description>
# open a PR against main; title must also pass commitlint (type(scope): summary)
```

Never commit directly to `main` (AGENTS.md). Evidence expectations per kind of change
are in `testing-and-validation`.

## Provenance and maintenance

Verified against the repo at commit c5742dc, 2026-08-17. Re-verify:

```bash
grep -n "release-please\|npm publish\|id-token" .github/workflows/release-please.yml  # release + OIDC path
grep -n "type-enum" commitlint.config.js                                              # allowed commit types
grep -n "npm run\|npm test\|npm audit" .github/workflows/ci.yml                       # the six gates + audit job
cat .husky/commit-msg                                                                 # local commitlint hook
grep -n "prefix\|applies-to" .github/dependabot.yml                                   # which bumps cut a release
```
