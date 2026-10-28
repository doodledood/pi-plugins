---
kind: ci
covers: .github
---
# Continuous integration

The GitHub Actions workflow that fails a pull request touching `packages/**` without a root
version bump.

## How a user reaches it

- Opening or updating a pull request on GitHub.

## Scenarios

None runs locally: the check needs a pull request event. A change to the workflow is checked by
the next pull request that touches `packages/**`.
