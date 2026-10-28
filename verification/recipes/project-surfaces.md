---
kind: walk
covers: AGENTS.md, CONTEXT.md, NORTH_STAR.md, docs/NORTH_STAR_CONVENTIONS.md, docs/adr, tickets
---
# Project surfaces

The direction, vocabulary and decision memory every session starts from: the context file's
project-surfaces section, the glossary, the North Star, the decision records with their index,
and the Ticket store config.

## How a user reaches it

- Every session reads `AGENTS.md` (also `CLAUDE.md`), `NORTH_STAR.md` and `CONTEXT.md` at start.
- Writing a decision record, which rebuilds `docs/adr/README.md` and the North Star's strategy list
  (`node scripts/adr-index.mjs`).

## Scenarios

### index
Run: `node scripts/adr-index.mjs --check`
Proves: the decision index and the North Star's strategy list are exactly what the records rebuild.
Line: 0.2 s on darwin-arm64-12cpu

### enforced
Run: `node --test scripts/adr-enforced.test.mjs`
Proves: every file a record in effect names under Enforced by exists and carries a comment citing
that record.
Line: 0.2 s on darwin-arm64-12cpu

## Gotchas

- No walk scenario checks that a fresh reader understands these files; the first change that needs
  one adds it, marked ask-first, since it would start an agent session.
