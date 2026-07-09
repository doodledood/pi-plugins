# Aviram Pi profile

This is a copy/merge profile for Aviram's Pi setup. It is not a blind overwrite bundle.

## What is included

- `settings.upstream.example.json`: preferred setup for Aviram's live install. It loads this repo from the upstream Git `@main` branch (always latest) and keeps custom extensions out of bare local files.
- `settings.local.example.json`: development setup using local paths after cloning this repo, plus external npm helper packages. It includes `npm:@amaster.ai/pi-image-gen` with `pi-image-gen.defaultModel` set to `gpt-image-2`. Replace `/ABSOLUTE/PATH/TO/pi-plugins` before use.
- `mcp.example.json`: MCP setup template with placeholders for local wrapper paths, direct remote MCP URLs, `mcp-remote` command servers, proxy-style MCP URLs, proxy IDs, and API keys. Standalone Tavily MCP is intentionally omitted; use `pi-web-access` instead.
- `web-search.example.json`: `pi-web-access` search-provider template. Copy to `~/.pi/web-search.json`, fill secrets locally, and keep permissions private.
- `models.example.json`: empty model-provider template; GPT-5.5 1M is configured in `configs/model-aliases.json` instead of a global built-in model override.
- `auth.example.json`: secret-free template for `~/.pi/agent/auth.json` that scopes `PI_CACHE_RETENTION=long` (24h prompt-cache retention) to the built-in `openai` provider. The GPT-5.5 1M alias is now `openai/gpt-5.5-1m`, so it reuses the normal `openai` auth/cache-retention surface; no synthetic OpenAI provider entry is needed. The `$OPENAI_API_KEY` value is env-indirection, no secret stored. Anthropic intentionally stays on the default 5-minute cache TTL — its 1h tier doubles every cache write, and the `cache-optimization` extension's TTL keepalive covers in-flight gaps far cheaper. Do not set `PI_CACHE_RETENTION` in your shell environment; that would flip Anthropic to 1h too. Separately, the `openai-max-output-floor` extension is included because the regular `openai` provider can still hit Pi's near-window output-token underflow: near the 272k window Pi's output-token clamp can fall below OpenAI's minimum and 400 the request, so the floor raises `max_output_tokens` back to 16 (see `docs/adr/20260708-openai-max-output-floor-extension.md`).
- `AGENTS.md` and `APPEND_SYSTEM.md`: Aviram's global instruction/profile text.
- `configs/`: current non-secret per-extension config files. Copy the files you use to `~/.pi/agent/` with the same basename, for example `configs/model-aliases.json` → `~/.pi/agent/model-aliases.json`. Default-valued fields are intentionally omitted so package defaults continue to apply, except intentional profile overrides like `configs/subagents.json` raising `@gotgenes/pi-subagents` background concurrency from its default 4 to 10. The `openai-tts` extension is configured by local environment variables such as `OPENAI_API_KEY`/`OPENAI_TTS_*`, not committed config files.

## Install/copy flow

1. Clone this repo.
2. For Aviram's normal setup, merge from `settings.upstream.example.json`. Use `settings.local.example.json` only when developing this repo from a local clone.
3. Merge `AGENTS.md` / `APPEND_SYSTEM.md` into your Pi agent directory if you want Aviram's operating posture.
4. Merge `auth.example.json` into `~/.pi/agent/auth.json` (keep 0600 permissions) for OpenAI long cache retention. Copy per-extension configs from `configs/` into `~/.pi/agent/` only after reviewing them; this includes `subagents.json`, which sets `@gotgenes/pi-subagents` to run up to 10 background agents concurrently instead of the upstream default 4. Copy `web-search.example.json` to `~/.pi/web-search.json` if using `pi-web-access` search. If you previously used `models.json` to override `openai/gpt-5.5` to 1M context, remove that override so normal GPT-5.5 and the configurable `openai/gpt-5.5-1m` alias stay separate.
5. Fill MCP and web-search placeholders locally; never commit filled-in tokens, OAuth state, private endpoint values, raw `auth.json`, or real `~/.pi/web-search.json`. The image-generation package defaults to `gpt-image-2` and expects normal provider auth such as `OPENAI_API_KEY` in your environment. When you rename placeholder MCP servers, update matching `mcp-tool-loadout` prior keys in `configs/mcp-tool-loadout.json`.

## Upstream package setup

`settings.upstream.example.json` pins this repo as `git:github.com/doodledood/pi-plugins@main`. That is the preferred live setup: custom extensions come from the upstream Git package/tag, while local bare extension files remain reserved for external installers such as Herdr.

## Local package setup

Replace every `/ABSOLUTE/PATH/TO/pi-plugins` placeholder with your clone path. Local package paths are useful only when developing this repo locally. Aviram's global skills are intentionally not packaged in this repo; external npm packages listed in the profile provide the current structured-question, todo, and web-access tools.
