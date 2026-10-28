# ADR: Install from main and publish no release tags

## Status
Accepted

## Area
packaging

## Decided by
The user

## Context
Install snippets once pinned release tags (`@vX.Y.Z`), so every release moved every snippet in the docs, package READMEs and setup templates, and a pinned install never picked up a new version through `pi update --extensions`.

## Decision
Every Pi install snippet references the Git source on `main` (`git:github.com/doodledood/pi-plugins@main`), so installs and `pi update --extensions` follow the latest version with no doc change on release. Release tags were at first still created automatically as frozen snapshots; since 2026-07-23 the tag-release workflow is removed and new versions publish no tags, while the few old `vX.Y.Z` tags stay as frozen snapshots. Versions still bump on every change under `packages/**` — minor for features, patch for fixes — because they remain the release history and the npm publish metadata. Prime Agent snippets stay ref-less, because Prime Agent treats any ref as pinned and skips pinned sources when it updates.

## Alternatives Considered
- **Pinned release tags in every snippet**: the previous practice — rejected because each release churned every snippet and pinned installs did not follow updates.
- **`@main` in Prime Agent snippets too**: rejected because Prime Agent treats any ref as pinned, so the package would never update there.

## Consequences

### Positive
- `pi update --extensions` always brings an install to the latest version.
- A release changes no documentation.

### Negative
- An install cannot stay on a known-good version except through an old frozen tag or a commit pin.
- A broken commit on `main` reaches every installation at its next update.

## Enforced by
partly — `.github/workflows/version-bump-check.yml` fails a pull request that touches `packages/**` without bumping the root version; that snippets reference `@main`, and that Prime Agent snippets stay ref-less, rests on review.

## Source
- Retroactive — reconstructed from commit 7d16bb7 (2026-07-06, "docs: track @main for installs instead of pinned release tags"), commit 2251832 (2026-07-23, "chore(ci): remove tag-release workflow; installs track @main, tags no longer auto-published"), commit d1dc160 (2026-08-06, the Prime Agent ref-less policy) and the "Version and install-ref policy" section of `AGENTS.md`.
- Session: (no session — captured post-hoc)
