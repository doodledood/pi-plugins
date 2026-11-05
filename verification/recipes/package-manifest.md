---
kind: manifest
covers: package.json, package-lock.json, scripts/verify-structure.mjs, scripts/verify-structure-helpers.mjs, scripts/verify-structure.test.mjs, scripts/check-lockfile.mjs, scripts/check-lockfile.test.mjs, scripts/is-main.mjs, scripts/is-main.test.mjs
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
Proves: the scripts' tests pass (the structure and lockfile checks among them); the root
manifest, every package's metadata, the docs and the setup templates list the same extensions,
themes, skills and setup files; and the lockfile is what npm writes for the manifests in the tree,
every workspace on disk counted whether or not git has it. The lockfile check rebuilds it offline
in a temporary copy, which it removes, and names the command that regenerates it on a mismatch.
Line: 4.5 s on darwin-arm64-12cpu; raised: the structure scenario now runs the lockfile check (0.5 s) and its tests, which spawn npm offline on fixture repositories (about 3 s), and the old structure tests are no slower

## Gotchas

- The lockfile check runs npm with `--offline`. When a manifest asks for a package or version the
  lockfile lacks, npm cannot fetch it and the check reports that instead of a line: the lockfile
  is stale either way. To run it alone: `node scripts/check-lockfile.mjs`.
- A version bump under `packages/**` changes the lockfile too: regenerate it with
  `npm install --package-lock-only --ignore-scripts`, as the repository's AGENTS.md says.
