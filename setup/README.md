# Pi setup

This directory is Aviram's portable Pi setup source of truth. It is a merge/copy template set, not a blind overwrite bundle.

## Files

- `settings.example.json` — normal installed setup. It tracks `git:github.com/doodledood/pi-plugins@main`, installs external helper packages, sets `openai/gpt-5.5-1m` as the default model alias, enables `deep-focus-pi`, and configures image generation to use `gpt-image-2`.
- `settings.local.example.json` — local development setup. Replace `/ABSOLUTE/PATH/TO/pi-plugins` with the clone path before use.
- `configs/` — non-secret per-extension configs. Copy files you use to `~/.pi/agent/` with the same basename, for example `configs/model-aliases.json` → `~/.pi/agent/model-aliases.json`.
- `mcp.example.json` — MCP template with placeholders for local wrapper paths, remote MCP hosts, proxy URLs, proxy IDs, and API keys.
- `web-search.example.json` — `pi-web-access` template. Copy to `~/.pi/web-search.json` and fill provider secrets locally.
- `models.example.json` — empty model-provider template. GPT-5.5 1M is configured via `configs/model-aliases.json`, not by overriding a built-in model.
- `auth.example.json` — secret-free template for `~/.pi/agent/auth.json`. It uses `$OPENAI_API_KEY` env indirection and scopes `PI_CACHE_RETENTION=long` to the built-in OpenAI provider.
- `AGENTS.md` and `APPEND_SYSTEM.md` — Aviram's portable operating posture for the agent.

## Sync flow

1. Back up existing local files before replacing anything.
2. Use `settings.example.json` for normal installs and `settings.local.example.json` only while developing this repo.
3. Copy or merge `configs/*.json` into `~/.pi/agent/` after reviewing them.
4. Copy or merge `auth.example.json` into `~/.pi/agent/auth.json`, keep it `0600`, and provide the real `OPENAI_API_KEY` through the local environment rather than in this repo.
5. Merge `AGENTS.md` / `APPEND_SYSTEM.md` only when the user wants Aviram's agent behavior.
6. Copy `mcp.example.json` and `web-search.example.json` as local templates, then fill placeholders in local files. Do not ask the user to paste secrets into chat.
7. If local MCP server names are changed, update matching `mcp-tool-loadout` prior keys in `configs/mcp-tool-loadout.json` before copying that config.
8. If a previous machine used `models.json` to override `openai/gpt-5.5` to 1M context, remove that override so normal GPT-5.5 and explicit `openai/gpt-5.5-1m` remain separate.

## Secret handling

Never commit filled local values. Keep raw API keys, OAuth state, tokens, cookies, sessions, caches, logs, generated package repos, raw `auth.json`, filled `mcp.json`, and real `web-search.json` outside this repo. Templates here should use placeholders or environment-variable references only.
