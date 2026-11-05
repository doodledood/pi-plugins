---
kind: manifest
covers: package.json, package-lock.json, scripts/verify-structure.mjs, scripts/verify-structure-helpers.mjs, scripts/verify-structure.test.mjs
---
# Package manifest

The root `package.json` Pi reads when it installs this repository from Git (its `pi.extensions` and
`pi.themes` paths are what a Git package filter selects), its workspaces and version, the lockfile
that pins them, and the structure check that keeps every install surface naming the same
resources.

## How a user reaches it

- `pi install git:github.com/doodledood/pi-plugins` (or `pi update`), which reads the root
  manifest, installs from the lockfile and loads the paths it lists.

## Scenarios

### structure
Run: `npm run verify:structure`
Proves: the structure script's tests pass, and the root manifest, every package's metadata, the
docs and the setup templates list the same extensions, themes, skills and setup files.
Line: 0.8 s on darwin-arm64-12cpu

### lockfile
Run: `d=$(mktemp -d) && git ls-files -z package.json package-lock.json '*/package.json' | xargs -0 -I{} rsync -R {} "$d/" && (cd "$d" && npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund >/dev/null) && cmp package-lock.json "$d/package-lock.json"`
Proves: the committed lockfile is what npm writes for the committed manifests: every workspace and
version in it matches its `package.json`. It runs on a copy, so it never edits the tree.
Line: 1.0 s on darwin-arm64-12cpu

## Gotchas

- `--offline` reads npm's local cache. On a machine that has never installed this repository it
  can fail for want of a cached package; run `npm install` once, then drive it again.
- A version bump under `packages/**` changes the lockfile too: regenerate it with
  `npm install --package-lock-only --ignore-scripts`, as the repository's AGENTS.md says.
