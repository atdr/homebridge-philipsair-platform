<!-- Write plainly: short sentences, concrete detail, no filler. A reviewer should be able to tell what changed and why in under a minute. -->

## What changed

<!-- One or two sentences. The PR title becomes the commit on main, so keep it conventional: type(scope): summary -->

## Why

<!-- The problem this solves. Link the issue: Fixes #123 -->

## Checks

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm run check && npm run lint:md && npm run test` all pass
- [ ] Docs updated in this PR, if this changes a config option, a module, or a supported device
- [ ] Tests added or updated, if this changes behaviour

## Test plan

<!-- On a draft: what you intend to test, so it can be argued with before you spend the time. On a PR ready for review: what you tested and what you saw. For a device change, name the model you ran against. -->
