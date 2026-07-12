---
name: change-control-and-docs
description: >-
  How a change lands in homebridge-philipsair-platform: branch naming,
  Conventional Commits and the commitlint type list, the six quality gates,
  release-please + npm trusted publishing, and the mechanical docs-sync
  obligations (including keeping these skills current). Load before committing,
  naming a branch, opening a PR, cutting a release, or when a change touches
  config options, models, or docs.
---

# Change control and docs

The procedure for turning a working change into a merged, released one. `AGENTS.md`
and `CONTRIBUTING.md` are the docs of record for the workflow; this skill adds the
rationale and a mechanical docs-sync table.

- To know _whether your change is proven enough to commit_, use
  `testing-and-validation` first.
- For the domain/architecture context of what you changed, use the reference
  skills. This skill is only about how it ships.

## Branches and commits

- **Never commit to `main`.** Every change lands via a PR targeting `main`.
- **Branch name:** `<type>/<short-description>`, e.g. `fix/handler-timeout`,
  `docs/refresh-readme`. Same `<type>` vocabulary as commits.
  - Exception for this environment: automated sessions push to their assigned
    branch (currently `claude/skills-library-prompt-k6042o`), still via PR.
- **Commit / PR-title format:** Conventional Commits — `type(scope): imperative
summary`. Allowed types are exactly, from `commitlint.config.js`:
  `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.
- **WHY the type matters:** release-please derives the version bump from commit
  types (`feat` → minor, `fix` → patch), so the type you choose _is_ the release
  decision. Keep each commit to one logical change so it can be reviewed and
  reverted independently.
- **Enforcement:** the husky `commit-msg` hook (`.husky/commit-msg` runs
  `commitlint --edit`) locally, plus two CI jobs — `commitlint` (checks every
  commit in the PR range) and `pr-title` (checks the PR title).

## The six quality gates

CI (`.github/workflows/ci.yml`) runs all six on Node 20 / 22 / 24; every one must
pass before merge. Run them locally first:

```bash
npm run typecheck     # tsc --checkJs over the plain JS (tsconfig.json)
npm run lint          # eslint (lint:fix to autofix)
npm run format:check  # prettier (format to write)
npm run check         # node --check syntax pass over every *.js
npm run lint:md       # markdownlint over **/*.md (lint:md:fix to autofix)
npm run test          # node:test unit suite (node --test)
```

Autofix helpers: `npm run lint:fix`, `npm run format`, `npm run lint:md:fix`.
The same six run in `prepublishOnly`. There is **no build step** — the JS ships
as-is; `typecheck` is a `checkJs` pass, not a compile.

## Releasing (fully automated — do not do it by hand)

On merge to `main`, `.github/workflows/release-please.yml`:

1. `release-please-action` opens/updates a release PR that bumps the version and
   prepends generated `CHANGELOG.md` entries above the hand-written v1.x history.
2. When that release PR is merged (`release_created == true`), the `publish` job
   runs `npm ci && npm publish` to the npm registry using **trusted publishing**
   (OIDC; `id-token: write`, provenance automatic — no stored npm token).

Consequences:

- **Never hand-edit the version** (`package.json`) or `CHANGELOG.md`, and never
  tag or `npm publish` manually. (Confirmed maintainer unwritten rule: do not
  bypass release-please.)
- The version bump is only ever as large as your commit types imply — if a
  user-facing feature must cut a minor release, it needs a `feat` commit.

## Docs-sync obligations (mechanical)

A PR that changes any of the left column MUST update the right column **in the
same PR**. Rows marked _(CI-enforced)_ fail a gate if you forget.

| When you change...                                                             | You must also update...                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A config option (add/remove/rename) in `config.schema.json`                    | `example-config.json` and the README field table — _(CI-enforced by `test/docs.test.js`)_ — and the option's description text                                                              |
| Add a model mapping in `accessories.models.js`                                 | `config.schema.json` model typeahead _(CI-enforced by `test/config.schema.test.js`)_ and the README "Tested devices" list _(CI-enforced by `test/docs.test.js`)_; see `new-device-bringup` |
| A module: add/remove/rename a file or its role                                 | The `AGENTS.md` "Project overview" architecture list, and `README.md` if user-facing                                                                                                       |
| Device I/O behaviour, keys, formulas, or CLI usage in `accessories.handler.js` | The `homekit-device-reference` skill and, if triage changes, `debugging-playbook`                                                                                                          |
| An invariant, its enforcement, or the runtime flow                             | The `architecture-and-invariants` skill                                                                                                                                                    |
| The gates, branch/commit rules, or release flow                                | This skill, plus `AGENTS.md` / `CONTRIBUTING.md`                                                                                                                                           |
| **Any** code change that invalidates a fact stated in a skill                  | That skill's body **and** its "Provenance and maintenance" commands, in the same PR                                                                                                        |
| `CHANGELOG.md`                                                                 | Nothing by hand — it is release-please-managed                                                                                                                                             |

The guiding principle (from AGENTS.md): where a doc/code invariant can be checked
mechanically, prefer a `node:test` guard over a prose rule, so CI catches drift
instead of a reviewer having to grep. The existing drift tests are the pattern to
copy — see `testing-and-validation`.

## Provenance and maintenance

Facts verified 2026-07-12 against the working tree. Re-verify:

```bash
# Commit types, hooks, gates
grep -n "type-enum" commitlint.config.js
cat .husky/commit-msg
grep -n "npm run\|npm test" package.json .github/workflows/ci.yml

# Release + trusted publishing
grep -n "release-please\|npm publish\|id-token" .github/workflows/release-please.yml

# The CI-enforced drift guards still exist
ls test/docs.test.js test/config.schema.test.js
```
