# pi-plugins repo guidance

- Keep every shareable resource individually installable: each extension and theme lives in its own package under `packages/`; global skills are intentionally excluded.
- Keep the root `package.json` Pi manifest in sync with all included extension/theme resource paths so Git package filters can select individual resources from this repo.
- Do not commit live Pi runtime state, credentials, OAuth material, session logs, caches, `node_modules`, raw `auth.json`, or unredacted API keys.
- Put Aviram's portable setup in top-level `setup/`; make it merge-oriented and template secrets/placeholders.
- Use conventional commits. Run `npm run verify:structure`, plus package tests/typechecks when changing package code.

## Sync checklist for resource changes

When adding, removing, renaming, or moving an extension/theme, keep all install surfaces in sync in the same change:

- Root `package.json`: `workspaces` and `pi.extensions` / `pi.themes` paths.
- The resource package `package.json`: `name`, `description`, `keywords`, `pi.*`, `files`, `repository.directory`, version, and publish metadata.
- Package README: local install, future npm install, Git package-filter path, config/local-state notes.
- Root docs: `README.md` and `docs/installing.md` examples and resource lists.
- Setup templates: `setup/settings.local.example.json`, `setup/settings.example.json`, relevant `configs/*.json`, and `mcp.example.json` when MCP categories change.
- `scripts/verify-structure.mjs`: expected extension/theme lists and structural checks.
- `package-lock.json`: regenerate with `npm install --package-lock-only --ignore-scripts` when package metadata/workspaces change; remove `node_modules/` afterward.

If an extension starts reading or writing local files, env vars, credentials, browser profiles, caches, or generated state, document that in its package README and add/verify matching `.gitignore` coverage. Do not leave stale install paths such as `~/.pi/agent/extensions/<name>` unless that is truly the supported install mode.

## Project Language and Decision Records

**The glossary is not optional reading.** `CONTEXT.md` is this project's language. Read it at the start of every session before doing anything else — it exists to stop silent misreading, and nobody looks up a term they already believe they understand.

**Read `docs/adr/README.md` before re-deciding something** — before settling a question this project may already have settled, and when a change contradicts or narrows an existing decision. Outside those two moments, leave it closed.

**Writing a decision record is one act, not three** — the record, the restatus of anything whose standing it changes, and the index, in one change. Step two is the one that gets dropped, and dropping any of them leaves the corpus asserting something untrue. The index is rebuilt from the records rather than edited beside them, so it can never assert something they do not. `docs/adr/CONVENTIONS.md` carries the bar, the template, and the rebuild rules — open it before you start.

## Version and install-ref policy

Pi clients install this repo via a Git source tracking the `main` branch (`git:github.com/doodledood/pi-plugins@main`), so installs and `pi update --extensions` always follow the latest version — no doc reference needs to move on release. Tags are not published for new versions; a few old `vX.Y.Z` tags remain as frozen historical snapshots.

- All Pi install snippets in docs (`README.md`, `docs/installing.md`, package READMEs, setup templates) reference `@main`. Do not reintroduce `@vX.Y.Z` pins into install examples.
- Prime Agent install snippets are deliberately ref-less (`git:github.com/doodledood/pi-plugins`). Prime Agent 0.7.0 treats any ref as pinned and silently skips pinned sources in `prime-agent package update` and in its startup update notice, so `@main` there means the package never updates. Do not "fix" those snippets to `@main`.
- Any change under `packages/**` must still bump the root `package.json` `version` (and the affected package's own `version`) in the same change. Bump minor for new features, patch for fixes, per semver — versions remain the release history and npm-publish metadata.
- `.github/workflows/version-bump-check.yml` fails PRs that touch `packages/**` without bumping the root version, so this can't regress silently.
