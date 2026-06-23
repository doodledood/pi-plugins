# Aviram Pi profile

This is a copy/merge profile for Aviram's Pi setup. It is not a blind overwrite bundle.

## What is included

- `settings.local.example.json`: full extension/theme setup using local paths after cloning this repo. Replace `/ABSOLUTE/PATH/TO/pi-plugins` before use.
- `settings.npm.example.json`: future setup shape after packages are published to npm.
- `mcp.example.json`: MCP setup template with placeholders for local wrapper paths, direct remote MCP URLs, `mcp-remote` command servers, proxy-style MCP URLs, proxy IDs, and API keys.
- `models.example.json`: model override example.
- `AGENTS.md` and `APPEND_SYSTEM.md`: Aviram's global instruction/profile text.
- `configs/`: current non-secret extension config defaults.

## Install/copy flow

1. Clone this repo.
2. Install or configure the packages you want using `settings.local.example.json` or the per-package README files.
3. Merge `AGENTS.md` / `APPEND_SYSTEM.md` into your Pi agent directory if you want Aviram's operating posture.
4. Copy config examples into `~/.pi/agent/` only after reviewing them.
5. Fill MCP placeholders locally; never commit filled-in tokens, OAuth state, private endpoint values, or raw `auth.json`. When you rename placeholder MCP servers, update matching `mcp-tool-loadout` prior keys in `configs/mcp-tool-loadout.json`.

## Local package setup

Replace every `/ABSOLUTE/PATH/TO/pi-plugins` placeholder with your clone path. Local package paths are useful before npm packages exist. Aviram's global skills and skill-providing packages are intentionally not included in this repo/profile.
