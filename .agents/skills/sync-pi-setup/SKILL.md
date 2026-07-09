---
name: sync-pi-setup
description: Syncs the current local Pi setup back into this repo's portable setup templates. Use when the user says to sync, refresh, or update this repo from their installed Pi config, extensions, models, MCP template, or agent instructions.
argument-hint: '<optional focus such as settings, mcp, agents, or all>'
---

# Sync Pi Setup

Keep this repo's `setup/` directory aligned with the user's current portable Pi setup without committing private/local state.

## Privacy boundary

When inspecting credential-bearing local files such as `~/.pi/agent/auth.json`, `~/.pi/agent/mcp.json`, or `~/.pi/web-search.json`, use redacted/structural reads or targeted scripts. Never print, quote, summarize, or paste raw secret values, credential-bearing URLs, OAuth material, proxy IDs, or tokens into the transcript. Preserve only key names, provider/server shape, env-var names, and placeholder-worthy fields.

## Workflow

1. Inspect the repo first: read `README.md`, `setup/README.md`, `AGENTS.md`, `.gitignore`, and `scripts/verify-structure.mjs`.
2. Inspect local Pi config only as needed:
   - `~/.pi/agent/settings.json`, especially `packages`, default provider/model, enabled models, theme, and package-specific settings
   - the installed package list from local settings and, when useful, `pi list`; compare it to `setup/settings.example.json` and `setup/settings.local.example.json`
   - prompt/profile files such as `~/.pi/agent/AGENTS.md`, `~/.pi/agent/APPEND_SYSTEM.md`, and any local template-like setup files that correspond to files under `setup/`
   - non-secret extension configs that correspond to `setup/configs/*.json`
   - `~/.pi/agent/models.json` only if model-provider overrides are expected
   - `~/.pi/agent/mcp.json` and `~/.pi/web-search.json` only through redacted/structural inspection for shape, provider choice, and placeholder-worthy fields — never for copying or exposing secrets verbatim
3. Compare local values, package list, prompt/profile files, and template-like files to `setup/`. Update repo templates only for portable defaults the user wants preserved across machines.
4. For secrets, credential-bearing URLs, OAuth material, private endpoints, local absolute paths, proxy IDs, and user-specific tokens, keep or introduce placeholders/env references in the repo template. Do not ask the user to paste secrets into chat.
5. If a local value is ambiguous — personal preference vs machine-specific vs private/internal — ask before adopting it. Default to leaving it local.
6. If package/resource paths change, update all install surfaces together: root `package.json`, package READMEs, root docs, `setup/`, and `scripts/verify-structure.mjs`.
7. Do not add a separate local-only setup layer. The repo uses templates with placeholders; filled files stay local.

## Never copy into the repo

- raw `auth.json`, API keys, OAuth state, tokens, cookies, sessions, caches, logs, package caches, or `node_modules`
- filled MCP URLs, proxy IDs, credential-bearing command args, or private/internal endpoints
- live `web-search.json` keys
- private/internal workflow instructions that are not part of the portable setup

## Verification

After changing the repo, run targeted verification:

```bash
npm run verify:structure
! rg "profiles/"'aviram' README.md docs setup packages AGENTS.md scripts .agents .claude
find setup -name '*.json' -print0 | xargs -0 node -e 'for (const f of process.argv.slice(1)) JSON.parse(require("fs").readFileSync(f,"utf8"))'
git status --short
```

Search tracked diffs and any untracked files for accidental secrets, filled credential-bearing URLs, private endpoints, proxy IDs, and runtime state. Treat placeholder hits like `<MCP_HOST>`, `<TAVILY_API_KEY>`, and `$OPENAI_API_KEY` as expected template values; treat filled values as blockers to remove before committing. Use `git add -N <new-file>` for new files before diff-based scans, or scan the untracked file contents directly.

```bash
git diff -- . ':(exclude)package-lock.json' | rg -n "api[_-]?key|secret|token|oauth|cookie|https://[^<[:space:]]+|proxy/[A-Za-z0-9_-]+|sessions?|mcp-oauth|web-search\.json|auth\.json" || true
git ls-files --others --exclude-standard -z | xargs -0 -r rg -n "api[_-]?key|secret|token|oauth|cookie|https://[^<[:space:]]+|proxy/[A-Za-z0-9_-]+|sessions?|mcp-oauth|web-search\.json|auth\.json" || true
```

If applying the setup to a local machine, also search copied local files for remaining placeholder markers and report them to the user instead of filling secrets in chat.

Also inspect `git diff --stat` and `git diff` for accidental secrets or runtime state. Summarize:

- which local files were compared;
- which repo templates/docs changed;
- which placeholders remain for the user to fill locally;
- which verification commands passed or still need attention.
