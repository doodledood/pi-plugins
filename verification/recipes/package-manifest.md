---
kind: manifest
covers: package.json, package-lock.json, scripts/verify-structure.mjs, scripts/verify-structure-helpers.mjs, scripts/verify-structure.test.mjs, scripts/check-lockfile.mjs, scripts/check-lockfile.test.mjs
---
# Package manifest

The root `package.json` Pi reads when it installs this repository from Git (its `pi.extensions` and
`pi.themes` paths are what a Git package filter selects), its workspaces and version, the lockfile
that pins them, and the two checks that guard them: the structure check, which keeps every install
surface naming the same resources, and the lockfile check.

## How a user reaches it

- `pi install git:github.com/doodledood/pi-plugins@main` (or `pi update --extensions`), which
  reads the root manifest, installs from the lockfile and loads the paths it lists.

## Scenarios

### structure
Run: `npm run verify:structure`
Proves: the structure script's tests pass, and the root manifest, every package's metadata, the
docs and the setup templates list the same extensions, themes, skills and setup files, and the
lockfile matches the manifests.
Line: 4.5 s on darwin-arm64-12cpu; raised: the structure scenario now runs scripts/check-lockfile.test.mjs, whose five tests build fixture lockfiles with npm offline (about 3.7 s), the old structure tests are no slower

### lockfile
Run: `node scripts/check-lockfile.mjs`
Proves: the lockfile in the tree is what npm writes for the tree's manifests, every workspace on
disk counted whether or not git has it; on a mismatch it names the command that regenerates it.
It rebuilds the lockfile offline in a temporary copy, which it removes, so the tree is never edited.
Line: 1.0 s on darwin-arm64-12cpu

## Gotchas

- It runs npm with `--offline`. When a manifest names a package the lockfile lacks, npm cannot
  fetch it and the check reports that instead of a line: the lockfile is stale either way.
- `npm run verify:structure` runs the same check, so `project-checks` runs it too.
- A version bump under `packages/**` changes the lockfile too: regenerate it with
  `npm install --package-lock-only --ignore-scripts`, as the repository's AGENTS.md says.
