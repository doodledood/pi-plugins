# Aviram Pi profile

This is a copy/merge profile for Aviram's Pi setup. It is not a blind overwrite bundle.

## What is included

- `settings.local.example.json`: full extension/theme setup using local paths after cloning this repo, plus external npm helper packages. Replace `/ABSOLUTE/PATH/TO/pi-plugins` before use.
- `mcp.example.json`: MCP setup template with placeholders for local wrapper paths, direct remote MCP URLs, `mcp-remote` command servers, proxy-style MCP URLs, proxy IDs, and API keys. Standalone Tavily MCP is intentionally omitted; use `pi-web-access` instead.
- `web-search.example.json`: `pi-web-access` search-provider template. Copy to `~/.pi/web-search.json`, fill secrets locally, and keep permissions private.
- `models.example.json`: model override example.
- `AGENTS.md` and `APPEND_SYSTEM.md`: Aviram's global instruction/profile text.
- `configs/`: current non-secret extension config overrides. Default-valued fields are intentionally omitted so package defaults continue to apply.

## Install/copy flow

1. Clone this repo.
2. Install or configure the packages you want using `settings.local.example.json` or the per-package README files.
3. Merge `AGENTS.md` / `APPEND_SYSTEM.md` into your Pi agent directory if you want Aviram's operating posture.
4. Copy config examples into `~/.pi/agent/` only after reviewing them. Copy `web-search.example.json` to `~/.pi/web-search.json` if using `pi-web-access` search.
5. Fill MCP and web-search placeholders locally; never commit filled-in tokens, OAuth state, private endpoint values, raw `auth.json`, or real `~/.pi/web-search.json`. When you rename placeholder MCP servers, update matching `mcp-tool-loadout` prior keys in `configs/mcp-tool-loadout.json`.

## Local package setup

Replace every `/ABSOLUTE/PATH/TO/pi-plugins` placeholder with your clone path. Local package paths are useful before npm packages exist. Aviram's global skills are intentionally not packaged in this repo; external npm packages listed in the profile provide the current structured-question, todo, and web-access tools.
