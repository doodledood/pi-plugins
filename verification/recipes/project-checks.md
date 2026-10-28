---
kind: suite
covers: .
---
# Project checks

The checks this repository runs across the whole tree: the structure check, every workspace's
type check and every workspace's tests. Each scenario calls the root script `npm run verify`
runs, so there is still one definition of each check.

## How a user reaches it

- `npm run verify`, or its parts `npm run verify:structure`, `npm run typecheck` and `npm test`,
  which contributors call directly while iterating; the evidence a change rests on is a drive of
  this recipe.

## Scenarios

### structure
Run: `npm run verify:structure`
Proves: the script tests pass and every install surface lists the same extensions, themes,
skills and setup files, with no workplace term in the published tree.
Line: 0.8 s on darwin-arm64-12cpu

### types
Run: `npm run typecheck`
Proves: every workspace compiles with no type error.
Line: 34.2 s on darwin-arm64-12cpu

### tests
Run: `npm test`
Proves: every workspace's tests pass.
Line: 61.8 s on darwin-arm64-12cpu

## Gotchas

- It covers the whole tree, so `verify affected` names it for every change; it never counts as
  covering a path a user reaches, which the other recipes cover.
- A new workspace joins the root `test` and `typecheck` scripts by hand; until it does, these
  scenarios pass without running it.
