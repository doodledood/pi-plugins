# pi-plugins

Aviram's Pi extensions, theme, and setup profiles.

This repo has two jobs:

1. **Shareable Pi resources** — extensions and theme under `packages/`, each packaged so it can be installed separately. Global skills are intentionally not included.
2. **Aviram setup profile** — `profiles/aviram/`, a merge-oriented profile with settings examples, extension configs, and prompt/context instructions.

## What's included

### Extensions

- `goal-controller` — checker-only long-running goal controller.
- `mcp-tool-loadout` — compact MCP catalog plus budgeted active tool schemas.
- `context-breakdown` — `/context` command for context-window usage breakdown.
- `gpt-fast-toggle` — OpenAI GPT priority service-tier toggle.
- `managed-chrome-devtools` — managed Chrome DevTools MCP wrapper/profile.
- `message-stash` — single-slot input draft stash.
- `simple-statusline` — ambient custom Pi footer/statusline.
- `skill-argument-hints` — phantom argument hints for skill commands.
- `tool-activity-renderer` — compact rendering wrappers for built-in tools.


### Skills

Global skills are intentionally not included in this repo.

### Theme

- `deep-focus-pi`

## Install all resources from the Git repo

The root package lists all included resources. Installing it without filters loads every extension and theme declared in `package.json`:

```bash
pi install git:github.com/doodledood/pi-plugins@v0.2.0
```

Use this only when you want the full curated resource set.

## Install one resource from the Git repo

Pi's documented Git install target is the repository package. To load a single resource from this repo, use package filters in `~/.pi/agent/settings.json`.

Extension example:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.2.0",
      "extensions": ["packages/extensions/message-stash/extensions/message-stash.ts"],
      "prompts": [],
      "themes": []
    }
  ]
}
```


Theme example:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.2.0",
      "extensions": [],
      "prompts": [],
      "themes": ["packages/themes/deep-focus-pi/themes/deep-focus-pi.json"]
    }
  ]
}
```

Do not rely on undocumented Git subdirectory install syntax. The examples use the pinned `@v0.2.0` release tag. Use `@main` only when you intentionally want the latest development version.

## Install one package from a local clone

```bash
git clone git@github.com:doodledood/pi-plugins.git
pi install /path/to/pi-plugins/packages/extensions/goal-controller
pi install /path/to/pi-plugins/packages/themes/deep-focus-pi
```

## Copy Aviram's setup

See [`profiles/aviram/README.md`](profiles/aviram/README.md). The profile is a merge guide, not a blind overwrite bundle.

It includes:

- local-path settings examples for extensions/theme
- MCP and model templates
- extension config examples/overrides
- Aviram's `AGENTS.md` / `APPEND_SYSTEM.md`

## Security

Pi extensions execute with local user permissions, and skills can instruct the model to take actions. Review before installing.

Do not commit live local state: credentials, OAuth state, sessions, caches, logs, raw `auth.json`, filled-in MCP proxy URLs, API keys, or generated `node_modules` directories. Templates/examples should use placeholders.

See [`docs/security.md`](docs/security.md).

## Development

```bash
npm install
npm run verify:structure
npm run typecheck
npm test
```

`npm run verify` runs structure checks, typechecks, and the mature package test suites.
