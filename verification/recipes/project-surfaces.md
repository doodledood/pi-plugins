---
kind: walk
covers: AGENTS.md, CONTEXT.md, NORTH_STAR.md, docs/NORTH_STAR_CONVENTIONS.md, docs/adr, tickets, scripts/adr-index.mjs, scripts/adr-index.test.mjs, scripts/adr-enforced.test.mjs, scripts/embed-conventions.mjs
---
# Project surfaces

The direction, vocabulary and decision memory every session starts from: the context file's
project-surfaces section, the glossary, the North Star, the decision records with their index,
and the Ticket store config.

## How a user reaches it

- Every session reads `AGENTS.md` (also `CLAUDE.md`), `NORTH_STAR.md` and `CONTEXT.md` at start.
- Syncing `setup/CODING_CONVENTIONS.md`, after which `node scripts/embed-conventions.mjs`
  regenerates the conventions section `AGENTS.md` embeds.
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

### conventions
Run: `node scripts/embed-conventions.mjs --check`
Proves: the Coding Conventions section `AGENTS.md` embeds matches `setup/CODING_CONVENTIONS.md`;
when it does not, the run fails without writing and names the command that regenerates it.
Line: 0.0 s on linux-x64-4cpu

## Gotchas

- No walk scenario checks that a fresh reader understands these files; the first change that needs
  one adds it, marked ask-first, since it would start an agent session.
