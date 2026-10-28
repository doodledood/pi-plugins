---
kind: walk
covers: README.md, docs/installing.md, docs/security.md
---
# Install documentation

The root README and the install guide: how a reader installs the whole repository, one
resource, or a local clone.

## How a user reaches it

- The repository front page, and `docs/installing.md` linked from it.

## Scenarios

### structure
Run: `node scripts/verify-structure.mjs`
Proves: the install examples name resource paths that exist.

## Gotchas

- No walk scenario exists yet: a fresh reader following the guide end to end would start an
  agent session, and the first change that needs it adds that scenario, marked ask-first.
