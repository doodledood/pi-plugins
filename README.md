# pi-plugins

Aviram's portable Pi setup plus the Pi extensions and theme it installs.

The main use case is agentic setup sync: point an agent at this repo and ask it to make a machine's Pi configuration match this setup. The agent should use `setup/` as the source of truth, preserve local/private values as placeholders, and verify the result.

## Quick start for an agent

When a user says “sync my Pi setup from this repo,” do this:

1. **Inspect before editing**
   - Read this README, `setup/README.md`, `setup/settings.example.json`, `setup/configs/*.json`, and `AGENTS.md`.
   - Inspect the target machine's existing `~/.pi/agent/settings.json` if it exists.

2. **Ask only load-bearing questions**
   - Fresh setup or merge into existing config?
   - Use upstream Git packages (`@main`) or local development paths?
   - Apply Aviram's defaults for model/theme/agent instructions, or preserve current local choices?
   - Which local integrations should be enabled: MCP, web search, image generation, browser tools?

   Default to merge when existing settings are present. Replace files only after explicit confirmation or after making timestamped backups.

3. **Install/update packages**
   - Normal setup tracks `git:github.com/doodledood/pi-plugins@main` and external npm helpers listed in `setup/settings.example.json`.
   - Use `setup/settings.local.example.json` only when developing this repo from a local clone.

4. **Copy or merge templates**
   - `setup/settings.example.json` → `~/.pi/agent/settings.json`
   - `setup/configs/*.json` → `~/.pi/agent/`
   - `setup/AGENTS.md` and `setup/APPEND_SYSTEM.md` → merge into `~/.pi/agent/`
   - `setup/auth.example.json` → merge into `~/.pi/agent/auth.json`
   - `setup/mcp.example.json` → `~/.pi/agent/mcp.json`
   - `setup/web-search.example.json` → `~/.pi/web-search.json`
   - `setup/models.example.json` → `~/.pi/agent/models.json` only if a models file is needed

5. **Do not collect secrets in chat**
   - Leave placeholders or env references in copied templates.
   - Tell the user which local files to edit for API keys, MCP endpoints, proxy IDs, OAuth material, and local wrapper paths.
   - Do not commit filled `auth.json`, `mcp.json`, `web-search.json`, runtime state, sessions, caches, logs, or package caches.

6. **Verify**
   - Run `pi list` after installs/updates.
   - Check copied local files for remaining placeholders and tell the user what must be filled.
   - In this repo, run `npm run verify:structure` after setup-template or resource changes.

A good final agent summary says: fresh vs merge, package sources installed, files copied/merged, placeholders still requiring local edits, and verification results.

## Setup defaults

The normal setup template is [`setup/settings.example.json`](setup/settings.example.json). It sets:

```json
{
  "defaultProvider": "openai",
  "defaultModel": "gpt-5.5-1m",
  "defaultThinkingLevel": "xhigh",
  "theme": "deep-focus-pi",
  "pi-image-gen": {
    "defaultModel": "gpt-image-2"
  }
}
```

`openai/gpt-5.5-1m` is provided by the `model-aliases` extension and configured in [`setup/configs/model-aliases.json`](setup/configs/model-aliases.json). The alias routes to `openai/gpt-5.5` with a 1,050,000-token context window. Keep `openai/gpt-5.5` and `openai/gpt-5.5-1m` separate: the normal model remains unchanged, and the 1M-context variant is explicit.

The setup installs these package sources:

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

## Fresh setup commands

Use this only when the user wants this setup to replace the target Pi config.

```bash
git clone git@github.com:doodledood/pi-plugins.git
cd pi-plugins
mkdir -p ~/.pi/agent ~/.pi

for file in settings mcp auth; do
  [ -f ~/.pi/agent/$file.json ] && cp ~/.pi/agent/$file.json ~/.pi/agent/$file.json.bak.$(date +%Y%m%d%H%M%S)
done
[ -f ~/.pi/web-search.json ] && cp ~/.pi/web-search.json ~/.pi/web-search.json.bak.$(date +%Y%m%d%H%M%S)

cp setup/settings.example.json ~/.pi/agent/settings.json
cp setup/configs/*.json ~/.pi/agent/
cp setup/auth.example.json ~/.pi/agent/auth.json
chmod 600 ~/.pi/agent/auth.json
cp setup/mcp.example.json ~/.pi/agent/mcp.json
cp setup/web-search.example.json ~/.pi/web-search.json
```

Then have the user fill local placeholders and credentials locally. Do not ask them to paste secrets into chat.

```bash
$EDITOR ~/.pi/agent/mcp.json
$EDITOR ~/.pi/web-search.json
```

`setup/auth.example.json` expects `OPENAI_API_KEY` to be provided in the local environment; keep the real key out of the repo and chat transcript.

Install/reconcile packages:

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

Later, `pi update --extensions` reconciles installed Git checkouts to their configured refs.

## Merge into an existing setup

When `~/.pi/agent/settings.json` already exists and the user wants to keep it, install packages first:

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

Then merge the portable defaults the user wants from `setup/settings.example.json`, especially:

- `defaultProvider: "openai"`
- `defaultModel: "gpt-5.5-1m"`
- `defaultThinkingLevel: "xhigh"`
- `enabledModels`
- `followUpMode` / `steeringMode`
- `theme: "deep-focus-pi"`
- `pi-image-gen.defaultModel: "gpt-image-2"`

Copy optional setup files with interactive prompts:

```bash
cp -i setup/configs/*.json ~/.pi/agent/
cp -i setup/auth.example.json ~/.pi/agent/auth.json
chmod 600 ~/.pi/agent/auth.json
cp -i setup/mcp.example.json ~/.pi/agent/mcp.json
cp -i setup/web-search.example.json ~/.pi/web-search.json
```

Merge instruction files only after the user confirms they want Aviram's operating posture:

```text
setup/AGENTS.md        -> ~/.pi/agent/AGENTS.md
setup/APPEND_SYSTEM.md -> ~/.pi/agent/APPEND_SYSTEM.md
```

## Local development setup

Use [`setup/settings.local.example.json`](setup/settings.local.example.json) only when editing this repo locally. Replace every `/ABSOLUTE/PATH/TO/pi-plugins` placeholder with the clone path. Normal installed setups should use the upstream Git source from `setup/settings.example.json`.

## Resources included

### Extensions

- `advisor-consult` — independent second-opinion advisor tool.
- `cache-optimization` — prompt-cache diagnostics and TTL keepalive.
- `context-breakdown` — `/context` command for context-window usage breakdown.
- `goal-controller` — checker-only long-running goal controller.
- `gpt-fast-toggle` — OpenAI GPT priority service-tier toggle.
- `managed-chrome-devtools` — managed Chrome DevTools MCP wrapper/profile.
- `mcp-tool-loadout` — compact MCP catalog and cache-safe schema loading.
- `message-stash` — single-slot input draft stash.
- `model-aliases` — selector-visible model aliases such as `openai/gpt-5.5-1m`.
- `openai-max-output-floor` — prevents OpenAI min-output-token 400s near context limits.
- `openai-tts` — local OpenAI Speech API text-to-speech tool.
- `simple-statusline` — compact Pi footer/statusline.
- `skill-argument-hints` — argument hints for skill commands.
- `tool-activity-renderer` — compact rendering wrappers for built-in tools.

### Theme

- `deep-focus-pi`

Global skills are intentionally not packaged as installable Pi resources. This repo does include a project-local maintenance skill, [`sync-pi-setup`](.agents/skills/sync-pi-setup/SKILL.md), for syncing current local Pi setup changes back into `setup/`. It is also symlinked into `.claude/skills/` for harnesses that discover Claude-style project skills.

## Installing individual resources

Install the root bundle when you want all included extensions and the theme:

```bash
pi install git:github.com/doodledood/pi-plugins@main
```

To load only one resource from the Git repo, use package filters in `~/.pi/agent/settings.json`:

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

Theme-only example:

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

Do not rely on undocumented Git subdirectory install syntax. Examples track `@main` so installs follow the latest version. Pin release tags only when intentionally using a frozen snapshot.

## Security

Pi extensions execute with local user permissions, and skills can instruct the model to take actions. Review packages and skills before installing or invoking them.

Do not commit live local state: credentials, OAuth state, sessions, caches, logs, raw `auth.json`, filled MCP URLs, API keys, generated package caches, or `node_modules`. Templates/examples should use placeholders or environment-variable references.

See [`docs/security.md`](docs/security.md).

## Development

```bash
npm install
npm run verify:structure
npm run typecheck
npm test
```

`npm run verify` runs structure checks, typechecks, and the mature package test suites.
