---
kind: ci
covers: .github
---
# Continuous integration

The GitHub Actions workflows on pull requests to `main`: one fails a pull request touching
`packages/**` without a root version bump; the other runs `npm run -s verify:structure` (the
structure check, the `scripts/*.test.mjs` unit tests and the lockfile check, none of which need an
npm install), so a root `AGENTS.md` whose embedded conventions drifted from
`setup/CODING_CONVENTIONS.md` cannot merge green.

## How a user reaches it

- Opening or updating a pull request on GitHub.

## Scenarios

None runs locally: the checks need a pull request event. The structure job runs the same command
as `npm run -s verify:structure`, which `project-checks` runs here; a change to the version-bump
workflow is checked by the next pull request that touches `packages/**`.
