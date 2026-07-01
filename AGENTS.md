# pi-plugins repo guidance

- Keep every shareable resource individually installable: each extension and theme lives in its own package under `packages/`; global skills are intentionally excluded.
- Keep the root `package.json` Pi manifest in sync with all included extension/theme resource paths so Git package filters can select individual resources from this repo.
- Do not commit live Pi runtime state, credentials, OAuth material, session logs, caches, `node_modules`, raw `auth.json`, or unredacted API keys.
- Put Aviram-specific setup in `profiles/aviram/`; make it merge-oriented and template secrets.
- Use conventional commits. Run `npm run verify:structure`, plus package tests/typechecks when changing package code.

## Sync checklist for resource changes

When adding, removing, renaming, or moving an extension/theme, keep all install surfaces in sync in the same change:

- Root `package.json`: `workspaces` and `pi.extensions` / `pi.themes` paths.
- The resource package `package.json`: `name`, `description`, `keywords`, `pi.*`, `files`, `repository.directory`, version, and publish metadata.
- Package README: local install, future npm install, Git package-filter path, config/local-state notes.
- Root docs: `README.md` and `docs/installing.md` examples and resource lists.
- Profile templates: `profiles/aviram/settings.local.example.json`, `settings.npm.example.json`, relevant `configs/*.json`, and `mcp.example.json` when MCP categories change.
- `scripts/verify-structure.mjs`: expected extension/theme lists and structural checks.
- `package-lock.json`: regenerate with `npm install --package-lock-only --ignore-scripts` when package metadata/workspaces change; remove `node_modules/` afterward.

If an extension starts reading or writing local files, env vars, credentials, browser profiles, caches, or generated state, document that in its package README and add/verify matching `.gitignore` coverage. Do not leave stale install paths such as `~/.pi/agent/extensions/<name>` unless that is truly the supported install mode.

## Tag/version sync policy

Pi clients install this repo via a Git source pinned to a release tag (`git:github.com/doodledood/pi-plugins@vX.Y.Z`). A tag that doesn't exist, or that lags the version referenced in the docs, breaks installs/updates for every client pinned to it. To keep tags and docs always in sync:

- Any change under `packages/**` must bump the root `package.json` `version` (and the affected package's own `version`) in the same change. Bump minor for new features, patch for fixes, per semver.
- Update every `@vX.Y.Z` reference (`README.md`, `docs/installing.md`, each changed package's `README.md`) to the new version in the same change.
- `.github/workflows/tag-release.yml` runs on every push to `main`: it walks the root `package.json` version history and pushes a matching `vX.Y.Z` tag (plus a GitHub release) for any version that doesn't have one yet. It backfills gaps automatically, so never hand-create a release tag — just bump the version and let it merge.
- `.github/workflows/version-bump-check.yml` fails PRs that touch `packages/**` without bumping the root version, so this can't regress silently again.
