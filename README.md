# pi-plugins

Aviram's Pi extensions, theme, and setup profiles.

This repo has two jobs:

1. **Shareable Pi resources** — extensions and theme under `packages/`, each packaged so it can be installed separately. Global skills are intentionally not included.
2. **Aviram setup profile** — `profiles/aviram/`, a merge-oriented profile with settings examples, extension configs, and prompt/context instructions.

## What's included

### Extensions

- `cache-optimization` — prompt-cache efficiency toolkit: `/cache` diagnostics with break attribution, Anthropic 4th-breakpoint cache keeper, and a runaway-proof foreground/background TTL keepalive.
- `goal-controller` — checker-only long-running goal controller.
- `mcp-tool-loadout` — compact MCP catalog, budgeted active tool schemas, and cache-safe schema loading for dormant tools.
- `context-breakdown` — `/context` command for context-window usage breakdown.
- `gpt-fast-toggle` — OpenAI GPT priority service-tier toggle.
- `managed-chrome-devtools` — managed Chrome DevTools MCP wrapper/profile.
- `model-aliases` — configurable selector-visible model aliases that map back to existing upstream model IDs.
- `message-stash` — single-slot input draft stash.
- `simple-statusline` — ambient custom Pi footer/statusline with context pressure, compact-at-boundary hint, session cache rate, and cache-break flag (full `/cache` diagnostics live in `cache-optimization`).
- `skill-argument-hints` — phantom argument hints for skill commands.
- `tool-activity-renderer` — compact rendering wrappers for built-in tools.


### Skills

Global skills are intentionally not included in this repo.

### Theme

- `deep-focus-pi`

## Install all resources from the Git repo

The root package lists all included resources. Installing it without filters loads every extension and theme declared in `package.json`:

```bash
pi install git:github.com/doodledood/pi-plugins@main
```

Use this only when you want the full curated resource set.

## Install one resource from the Git repo

Pi's documented Git install target is the repository package. To load a single resource from this repo, use package filters in `~/.pi/agent/settings.json`.

Extension example:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
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
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": [],
      "prompts": [],
      "themes": ["packages/themes/deep-focus-pi/themes/deep-focus-pi.json"]
    }
  ]
}
```

Do not rely on undocumented Git subdirectory install syntax. The examples track the `@main` branch so installs always follow the latest version. Pin a release tag (`@vX.Y.Z`, auto-created on every version bump) only when you intentionally want a frozen snapshot.

## Install one package from a local clone

```bash
git clone git@github.com:doodledood/pi-plugins.git
pi install /path/to/pi-plugins/packages/extensions/goal-controller
pi install /path/to/pi-plugins/packages/themes/deep-focus-pi
```

## Install/copy Aviram's full Pi profile

See [`profiles/aviram/README.md`](profiles/aviram/README.md). The profile is a merge guide, not a blind overwrite bundle.

Use this when you want the whole working setup: this repo's extensions/theme, external Pi packages, theme and model settings, extension configs, MCP template, web-search template, and optional prompt/profile files.

### What the full profile installs

`profiles/aviram/settings.upstream.example.json` is the normal live-install template. Its `packages` list installs:

```json
[
  "npm:pi-mcp-adapter",
  "npm:@gotgenes/pi-subagents",
  "git:github.com/doodledood/manifest-dev@main",
  "git:github.com/doodledood/pi-plugins@main",
  "npm:@juicesharp/rpiv-ask-user-question",
  "npm:@juicesharp/rpiv-todo",
  "npm:pi-web-access",
  "npm:@amaster.ai/pi-image-gen"
]
```

The `git:github.com/doodledood/pi-plugins@main` package is this repo. The other entries are external packages installed alongside it.

The same settings template also enables the theme and package defaults:

```json
{
  "theme": "deep-focus-pi",
  "pi-image-gen": {
    "defaultModel": "gpt-image-2"
  }
}
```

### Fresh profile: copy the full setup

Use this path for a new machine/profile, or when you intentionally want to replace your current Pi settings with Aviram's profile.

```bash
# 1. Clone the profile repo.
git clone git@github.com:doodledood/pi-plugins.git
cd pi-plugins

# 2. Make Pi config directories.
mkdir -p ~/.pi/agent ~/.pi

# 3. Back up any existing local settings/config first.
[ -f ~/.pi/agent/settings.json ] && cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak.$(date +%Y%m%d%H%M%S)
[ -f ~/.pi/agent/mcp.json ] && cp ~/.pi/agent/mcp.json ~/.pi/agent/mcp.json.bak.$(date +%Y%m%d%H%M%S)
[ -f ~/.pi/web-search.json ] && cp ~/.pi/web-search.json ~/.pi/web-search.json.bak.$(date +%Y%m%d%H%M%S)

# 4. Install the full package/settings profile.
cp profiles/aviram/settings.upstream.example.json ~/.pi/agent/settings.json

# 5. Copy non-secret extension configs.
cp profiles/aviram/configs/*.json ~/.pi/agent/

# 6. Copy local templates that must be reviewed and filled in.
cp profiles/aviram/mcp.example.json ~/.pi/agent/mcp.json
cp profiles/aviram/web-search.example.json ~/.pi/web-search.json
```

Then edit the local templates before relying on those integrations:

```bash
$EDITOR ~/.pi/agent/mcp.json
$EDITOR ~/.pi/web-search.json
```

Important local edits:

- `~/.pi/agent/mcp.json`: replace placeholder MCP hosts, proxy IDs, API keys, and wrapper paths. For Chrome DevTools, the managed wrapper is normally `~/.local/bin/chrome-devtools-mcp-managed`; run `/managed-chrome doctor` or call `managed_chrome_status({"start": true})` inside Pi if you need the exact setup snippet for the machine.
- `~/.pi/web-search.json`: replace `<TAVILY_API_KEY>` or change the provider config for your own web-search setup.

Finally, install/reconcile the package sources listed in the profile:

```bash
for pkg in \
  npm:pi-mcp-adapter \
  npm:@gotgenes/pi-subagents \
  git:github.com/doodledood/manifest-dev@main \
  git:github.com/doodledood/pi-plugins@main \
  npm:@juicesharp/rpiv-ask-user-question \
  npm:@juicesharp/rpiv-todo \
  npm:pi-web-access \
  npm:@amaster.ai/pi-image-gen
do
  pi install "$pkg"
done

pi list
```

Later, use `pi update --extensions` to reconcile installed package checkouts to the latest `main` without changing the configured refs.

### Existing profile: install the same plugins without overwriting settings

If you already have a `~/.pi/agent/settings.json` you care about, do not copy `settings.upstream.example.json` over it. Install the same packages into your current settings instead:

```bash
pi install npm:pi-mcp-adapter
pi install npm:@gotgenes/pi-subagents
pi install git:github.com/doodledood/manifest-dev@main
pi install git:github.com/doodledood/pi-plugins@main
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:@juicesharp/rpiv-todo
pi install npm:pi-web-access
pi install npm:@amaster.ai/pi-image-gen
```

Then manually merge the non-package settings you want from `profiles/aviram/settings.upstream.example.json`, especially:

```json
{
  "theme": "deep-focus-pi",
  "pi-image-gen": {
    "defaultModel": "gpt-image-2"
  }
}
```

Copy the optional profile files with interactive overwrite prompts:

```bash
cp -i profiles/aviram/configs/*.json ~/.pi/agent/
cp -i profiles/aviram/mcp.example.json ~/.pi/agent/mcp.json
cp -i profiles/aviram/web-search.example.json ~/.pi/web-search.json
```

### Optional prompt/profile files

If you want Aviram's operating posture too, merge these files into your own copies instead of blindly overwriting them:

```text
profiles/aviram/AGENTS.md        -> ~/.pi/agent/AGENTS.md
profiles/aviram/APPEND_SYSTEM.md -> ~/.pi/agent/APPEND_SYSTEM.md
```

Use `profiles/aviram/settings.local.example.json` only when developing this repo from a local clone; it points at local package paths under `/ABSOLUTE/PATH/TO/pi-plugins` instead of the `@main`-tracking Git package.

### For agents helping a user configure this profile

If you are an agent reading this README to set up a user's Pi environment, do not blindly copy Aviram's files over the user's existing configuration. First establish whether the user wants a fresh clone of Aviram's profile or a merge into their current setup. Ask only the questions that materially change the install plan, and prefer safe defaults when the user does not care.

Recommended probing questions:

1. **Fresh install or merge?**
   - "Do you want to replace your Pi settings with Aviram's profile, or merge the profile into your existing `~/.pi/agent/settings.json`?"
   - Default: merge if the user already has settings; replace only with explicit confirmation.

2. **Pinned release or local development?**
   - "Should the `pi-plugins` resources come from the upstream Git source `git:github.com/doodledood/pi-plugins@main`, or from a local clone you plan to edit?"
   - Default: the `@main` Git source for normal use; local paths only for development.

3. **External package set?**
   - "Do you want the full external package set from Aviram's profile — MCP adapter, subagents, manifest skills, ask-user-question, todo, web access, and image generation — or only a subset?"
   - Default: install the full set when the user asked for Aviram's profile.

4. **Theme and visual defaults?**
   - "Should I set the active Pi theme to `deep-focus-pi`?"
   - Default: yes for the full profile; preserve the user's current theme when merging unless they opt in.

5. **Model/provider defaults?**
   - "Which default provider/model should Pi use, and do you have access to the enabled models listed in the profile?"
   - Default: copy the profile values for a fresh setup; preserve current provider/model when merging unless the user asks for Aviram's defaults.

6. **Image generation?**
   - "Do you want `@amaster.ai/pi-image-gen` installed, and should its default model be `gpt-image-2`?"
   - Default: yes for the full profile. Do not ask the user to paste API keys into chat; tell them to configure provider credentials locally.

7. **Web search provider?**
   - "Do you want `pi-web-access` configured with Tavily as in `profiles/aviram/web-search.example.json`, or a different search provider?"
   - Default: copy the template, then have the user fill `~/.pi/web-search.json` locally.

8. **MCP servers?**
   - "Which MCP servers should be enabled: Chrome DevTools, direct remote MCP URLs, `mcp-remote` command servers, proxy MCP servers, or only a subset?"
   - Default: copy `profiles/aviram/mcp.example.json` as a template, then remove unused placeholder servers and fill real local/private values outside the repo.

9. **Chrome DevTools MCP?**
   - "Do you want managed Chrome DevTools MCP enabled on this machine?"
   - Default: yes if the user wants browser tools. Use the managed wrapper path `~/.local/bin/chrome-devtools-mcp-managed`; if unsure, ask the user to run `/managed-chrome doctor` inside Pi after installing.

10. **Prompt/profile posture?**
    - "Do you want Aviram's `AGENTS.md` and `APPEND_SYSTEM.md` behavior profile merged into your agent instructions?"
    - Default: ask before merging. These files affect agent behavior and should not be silently overwritten.

11. **Secrets and private endpoints?**
    - "Which required values will you fill locally — API keys, MCP hosts, proxy IDs, OAuth material, or local wrapper paths?"
    - Default: never collect secrets in chat. Leave placeholders in copied templates and tell the user exactly which files to edit locally.

12. **Verification expectation?**
    - "After setup, should I run package verification commands such as `pi list` and inspect copied config files for remaining placeholders?"
    - Default: yes. At minimum, confirm packages are listed and call out any placeholders still needing user input.

A good agent output after asking these questions should include:

- whether the setup is fresh or merged;
- the exact package sources installed;
- which files were copied or edited;
- which local placeholders remain for the user;
- verification performed, usually `pi list` plus a check for obvious placeholder strings in `~/.pi/agent/mcp.json` and `~/.pi/web-search.json`.

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
