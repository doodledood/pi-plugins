# ADR: Keep workplace material out of the repository with a structure scan

## Status
Accepted

## Area
publishing

## Decided by
The user

## Context
The repository is public. Two pieces of employer-specific material had reached the tree — a test fixture using a real work repository path and a pull-request rule naming one employer's security bot — even though "don't commit work material" was already the rule. As the scan's own comment puts it, a term naming a workplace cannot be unpublished once pushed.

## Decision
Employer-specific material lives in the owner's local install, never in this repository. The structure check scans every tracked text file for terms that identify the workplace and fails with the file and line; the check file itself is exempt because it has to name the terms. The two leaked strings were genericized or moved, and history was left intact because they were ordinary strings rather than secrets.

## Alternatives Considered
- **Keep the rule as prose only**: rejected — the prose rule already let both pieces through.
- **Rewrite history to remove the old strings**: rejected — they were not secrets, and history stays intact.

## Consequences

### Positive
- Workplace terms fail the build before they are published, for contributors who never read the rule.

### Negative
- The term list is maintained by hand; a workplace term not on it passes.

## Enforced by
`scripts/verify-structure.mjs` (the `employerTerms` scan) — fails on any tracked text file containing a listed workplace term.

## Source
- Retroactive — reconstructed from commit c1bf990 (2026-08-11, "chore: keep workplace material out of the repo, and enforce it"), whose message carries the reasoning, and the comment above the scan in `scripts/verify-structure.mjs`.
- Session: (no session — captured post-hoc)
