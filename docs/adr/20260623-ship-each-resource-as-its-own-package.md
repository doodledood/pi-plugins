# ADR: Ship each extension and theme as its own installable package

## Status
Accepted

## Area
packaging

## Decided by
The user

## Context
The repository collects Pi extensions and themes that people may want one at a time. Pi installs a Git source as one package, and a package filter in `settings.json` can select individual resource paths from it. The repository was bootstrapped with one package per resource from its first commit.

**Rationale not recovered** beyond what the repository's guidance states: the alternatives weighed and the wider reasons were not found and are not reconstructed here.

## Decision
Every shareable extension and theme lives in its own package under `packages/`, with its own `package.json`, README and version, and the root `package.json` Pi manifest lists every resource path, so Git package filters can select individual resources from this repository. Global skills are excluded from packages.

## Alternatives Considered
_Not recovered._

## Consequences

### Positive
- A user installs one extension or theme without the rest, from Git with a filter or from npm.
- Each package carries its own version history and publish metadata.

### Negative
- Every resource change touches several install surfaces that must stay in sync: root workspaces and manifest, the package's own metadata and README, the root docs, the setup templates, the structure check's lists and the lockfile.

## Enforced by
`scripts/verify-structure.mjs` — fails when an expected extension or theme lacks its package, README or entry file, or when the root manifest, setup templates or docs name a different set of resources.

## Source
- Retroactive — reconstructed from the bootstrap commit bca7321 (2026-06-23), the repository guidance in `AGENTS.md` ("Keep every shareable resource individually installable … so Git package filters can select individual resources") and `scripts/verify-structure.mjs`.
- Session: (no session — captured post-hoc)
