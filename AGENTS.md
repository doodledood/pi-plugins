# pi-plugins repo guidance

- Keep every shareable resource individually installable: each extension and theme lives in its own package under `packages/`; global skills are intentionally excluded.
- Keep the root `package.json` Pi manifest in sync with all included extension/theme resource paths so Git package filters can select individual resources from this repo.
- Do not add `self-compact`; it is intentionally excluded.
- Do not commit live Pi runtime state, credentials, OAuth material, session logs, caches, `node_modules`, raw `auth.json`, or unredacted API keys.
- Put Aviram-specific setup in `profiles/aviram/`; make it merge-oriented and template secrets.
- Use conventional commits. Run `npm run verify:structure`, plus package tests/typechecks when changing package code.
