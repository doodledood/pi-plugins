# pi-plugins

Aviram's portable Pi setup plus the Pi extensions and theme it installs.

The main use case is agentic setup sync: point an agent at this repo and ask it to make a machine's Pi configuration match this setup. The agent should use `setup/` as the source of truth, preserve local/private values as placeholders, and verify the result.

## Replicate this setup with an agent

Give an agent this repo and ask: **“Configure Pi on this computer from this repository. Default to the full portable setup, but first inspect what is already installed and ask me which parts to keep, omit, or customize. Apply the result safely and verify it.”**

The agent's completion contract is:

- the target machine has the selected subset of Aviram's Pi defaults, packages, extension configs, agent definitions, and operating instructions;
- unrelated existing settings and credentials remain intact unless the user explicitly chose replacement;
- private values stay local—nothing secret is copied from another machine, printed in chat, or committed;
- the agent verifies the effective installation and reports what changed, what was preserved, and what still needs local input.

Unless the user asks for a narrower scope, default to a **full portable sync**: settings defaults, package list, bundled extensions/theme, non-secret extension configs, agent definitions, and portable operating instructions. On a machine with existing config, full sync still means merge-and-preserve—not blind replacement. Authentication, private endpoints, credentials, and machine-specific paths always require local choices. Every part can be excluded or customized during questioning.

### Guided agent workflow

1. **Inspect before asking or editing**
   - Read this README, `setup/README.md`, `setup/settings.example.json`, and the repo-root `AGENTS.md`. Inspect the available filenames under `setup/configs/`, `setup/agents/`, and `setup/skills/`; after scope is chosen, read the selected files. Read `setup/AGENTS.md` and `setup/CODING_CONVENTIONS.md` before explaining the agent-behavior option.
   - Check `node --version`, `npm --version`, `git --version`, and `pi --version`. If Pi is missing, ask before installing it with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
   - Detect existing target files under `~/.pi/agent/` and `~/.pi/`. Inspect ordinary JSON and instruction files as needed. **Do not use raw file reads, `cat`, `grep`, or similar content-printing commands on `auth.json`, `mcp.json`, or `web-search.json`.** Inspect only structural key paths with a targeted script such as the one below.
   - Discover whether this is fresh or existing setup; do not ask questions the filesystem already answers.

   ```bash
   node <<'NODE'
   const fs = require("node:fs");
   const os = require("node:os");
   const path = require("node:path");
   const files = {
     "auth.json": path.join(os.homedir(), ".pi/agent/auth.json"),
     "mcp.json": path.join(os.homedir(), ".pi/agent/mcp.json"),
     "web-search.json": path.join(os.homedir(), ".pi/web-search.json"),
   };
   function keyPaths(value, prefix = "", out = []) {
     if (Array.isArray(value)) { out.push(`${prefix}[]`); return out; }
     if (value && typeof value === "object") {
       for (const key of Object.keys(value)) keyPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
     } else if (prefix) out.push(prefix);
     return out;
   }
   for (const [label, file] of Object.entries(files)) {
     if (!fs.existsSync(file)) continue;
     const shape = keyPaths(JSON.parse(fs.readFileSync(file, "utf8")));
     console.log(`${label}: ${shape.join(", ")}`);
   }
   NODE
   ```

2. **Guide the user through full vs. partial sync**
   First summarize what was discovered on the target machine and make a recommendation:

   - recommend **full portable sync** when Pi is fresh or the user wants this machine to match Aviram's setup closely;
   - recommend **partial sync** when the target already has intentional model, theme, agent, or integration choices, or the user wants only specific capabilities;
   - offer **dry run** when the user wants to inspect the proposed delta before anything changes.

   Never ask “full or partial?” without explaining what that choice would change on this machine. Ask the smallest useful set of grouped questions, skipping choices the user already answered. When partial sync is plausible, include the part selection with the scope question when the interface supports it; otherwise ask one focused follow-up:

   - **Change strategy:** merge and preserve existing values (recommended when config exists), replace selected files after timestamped backups, or dry run only.
   - **Sync scope:** full portable sync (default), or choose parts. In a full sync, ask what to opt out of rather than forcing the user to select every item.
   - **Existing conflicts:** for each selected part whose target differs, apply Aviram's portable default, preserve the current value, or customize it.
   - **Agent behavior:** apply `setup/AGENTS.md` with its `CODING_CONVENTIONS.md` companion and the Luna-backed `Explore` override; preserve current behavior; or choose these individually.
   - **Optional integrations:** configure web search, MCP servers, browser tools, image generation, or none. Preserve working local integrations by default.

   When the user chooses parts, explain and offer these independently:

   - **Pi defaults** — default provider/model, thinking level, enabled model cycle, theme, telemetry, and message delivery behavior.
   - **Packages and resources** — the installed helper packages plus this repo's extensions and `deep-focus-pi` theme.
   - **Extension tuning** — non-secret settings such as subagent concurrency, rendering mode, GPT fast mode, aliases, and MCP tool-catalog behavior.
   - **Agent behavior** — global operating instructions, appended system guidance, and the read-only Explore agent on GPT-5.6 Luna with medium thinking.
   - **Integrations** — web search, MCP/browser connections, and image generation; these may require target-local paths, login, or secrets.

   If the user chooses a category rather than full sync, continue to the individual items in that category and use the descriptions under [Resources included](#resources-included) to explain their purpose. Do not force all extensions or configs in a selected category.

   Default normal installs to Git package sources tracking `@main`. Ask about local development paths only when the user is working from a local clone. Preserve existing authentication; if none is usable, guide the user to provider `/login` or local environment-variable authentication. Never ask for a raw credential in chat.

3. **Translate the answers into an explicit plan**
   - Name every target file that will be created, merged, replaced, or left alone.
   - Name every package that will be installed or updated.
   - Explain any unresolved placeholder or machine-specific path before applying it.
   - Pause only for destructive replacement, credential/authentication work performed as the user, or another genuinely external side effect. Reversible merges and package preparation may proceed after the choices are clear.

4. **Apply the selected profile safely**
   - Before changing an existing file, create a timestamped backup beside it.
   - For `settings.json`, preserve unknown keys, merge nested objects, and union package entries by package identity instead of duplicating them. Apply model, thinking, theme, telemetry, and delivery defaults only when selected.
   - For files under `setup/configs/`, merge or replace per file; do not assume every extension config is wanted in a custom profile.
   - Copy selected agent definitions to `~/.pi/agent/agents/`. Merge instruction files semantically so existing rules are not duplicated.
   - Copy selected global skills to `~/.agents/skills/`; each skill is a directory containing `SKILL.md`.
   - Do not overwrite working `auth.json`, `mcp.json`, or `web-search.json`. Start from an example only when the integration is selected and no usable local file exists.

| Portable source | Target | Apply when |
| --- | --- | --- |
| `setup/settings.example.json` | `~/.pi/agent/settings.json` | Normal installed setup; merge selected defaults when a file exists |
| `setup/settings.local.example.json` | `~/.pi/agent/settings.json` | Local development only, after replacing the absolute-path placeholders |
| `setup/configs/*.json` | `~/.pi/agent/` | The matching extension/config is selected |
| `setup/agents/*.md` | `~/.pi/agent/agents/` | The matching agent override is selected |
| `setup/skills/*` | `~/.agents/skills/` | The matching global skill is selected |
| `setup/AGENTS.md` | `~/.pi/agent/AGENTS.md` | Aviram's operating posture is selected |
| `setup/CODING_CONVENTIONS.md` | `~/.pi/agent/CODING_CONVENTIONS.md` | Always, whenever `AGENTS.md` is copied — it references this file by name |
| `setup/auth.example.json` | `~/.pi/agent/auth.json` | API-key-via-environment auth is selected and no auth file should be preserved |
| `setup/mcp.example.json` | `~/.pi/agent/mcp.json` | MCP/browser integration is selected; fill placeholders locally |
| `setup/web-search.example.json` | `~/.pi/web-search.json` | Web search is selected; fill the provider secret locally |
| `setup/models.example.json` | `~/.pi/agent/models.json` | A custom provider override is actually needed; the current full profile intentionally keeps this template empty |

5. **Install and reconcile packages**
   - Use the package list in `setup/settings.example.json` as the normal source of truth.
   - Install missing packages with `pi install <source>` and reconcile installed Git packages with `pi update --extensions` when appropriate.
   - Package installation does **not** copy the files under `setup/`; perform both the package and file-merge steps.

6. **Verify the effective setup**
   - Parse every JSON file changed without printing credential-bearing contents.
   - Run `pi list` and compare package identities with the selected package list.
   - Run `pi --list-models`; for the full profile confirm `anthropic/claude-opus-5`, `anthropic/claude-fable-5`, `openai/gpt-5.6-sol`, and `openai/gpt-5.6-luna` are available. Confirm the configured model cycle contains only Sol at xhigh, Opus 5 at xhigh, Luna at max, and Fable at medium; both OpenAI models report 272K context and both Anthropic models report 500K, and `model-aliases.json` gives the OpenAI models a 1,050,000-token target window and the Anthropic models a 1,000,000-token one.
   - Confirm each selected config, instruction, and agent file exists at its target path. For the goal-controller profile, confirm `checker.model: openai/gpt-5.6-sol` and `checker.thinking: xhigh`; for the Explore override, confirm `model: openai/gpt-5.6-luna` and `thinking: medium` without displaying unrelated local content.
   - Search copied files for unresolved markers such as `<...>` and `/ABSOLUTE/PATH/TO`; report them rather than inventing values.
   - Restart Pi or run `/reload` after changing settings, instruction files, or agent definitions.
   - When editing this repository itself, also run `npm run verify:structure` and the secret-safety scans from the `sync-pi-setup` skill.

The final report must state: selected strategy/profile/integrations, packages installed or preserved, files created/merged/replaced plus backup paths, defaults applied or preserved, unresolved local placeholders, and verification results.

## Setup defaults

The normal setup template is [`setup/settings.example.json`](setup/settings.example.json). It sets:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-opus-5",
  "defaultThinkingLevel": "xhigh",
  "enabledModels": [
    "openai/gpt-5.6-sol:xhigh",
    "anthropic/claude-opus-5:xhigh",
    "openai/gpt-5.6-luna:max",
    "anthropic/claude-fable-5:medium"
  ],
  "theme": "deep-focus-pi",
  "pi-image-gen": {
    "defaultModel": "gpt-image-2"
  }
}
```

The setup makes `anthropic/claude-opus-5` the default at xhigh thinking. The model cycle contains only Sol at xhigh, Opus 5 at xhigh, Luna at max, and Fable at medium. [`setup/configs/model-aliases.json`](setup/configs/model-aliases.json) keeps Sol and Luna as dual-window aliases: Pi displays and enforces a 272,000-token operating window for both. With Pi's default 16,384-token response reserve, automatic compaction starts after 255,616 context tokens; if one tool loop reaches the visible edge first, the aliases trigger native compact-and-retry. Delegated provider calls and Pi-owned summaries retain the 1,050,000-token target window.

[`setup/configs/goal-controller.config.json`](setup/configs/goal-controller.config.json) pins Aviram's goal checker to `openai/gpt-5.6-sol` at `xhigh`, regardless of the active session model. This is a setup-specific override; the goal-controller package still defaults both checker fields to `inherit`.

The installed `@gotgenes/pi-subagents` package hardcodes its built-in `Explore` agent to Claude Haiku. [`setup/agents/Explore.md`](setup/agents/Explore.md) is the portable same-name override: it keeps Explore read-only, uses `openai/gpt-5.6-luna` with medium thinking, and asks for conclusion-first, evidence-backed findings.

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

## Reference recipe: fresh full profile

Use this recipe only after the user selects the full profile and inspection confirms there is no Pi setup to preserve. HTTPS cloning is the portable default; use SSH only when the target already has GitHub SSH access.

```bash
set -euo pipefail
command -v pi >/dev/null || { echo "Pi is not installed; return to the prerequisite step." >&2; exit 1; }
if { [ -d "$HOME/.pi/agent" ] && [ -n "$(find "$HOME/.pi/agent" -mindepth 1 -maxdepth 2 -type f -print -quit 2>/dev/null)" ]; } || [ -e "$HOME/.pi/web-search.json" ]; then
  echo "Existing Pi state detected; stop and use the merge recipe." >&2
  exit 1
fi

git clone https://github.com/doodledood/pi-plugins.git
cd pi-plugins
mkdir -p ~/.pi/agent/agents ~/.pi ~/.agents/skills

cp setup/settings.example.json ~/.pi/agent/settings.json
cp setup/configs/*.json ~/.pi/agent/
cp setup/agents/*.md ~/.pi/agent/agents/
cp -R setup/skills/* ~/.agents/skills/
cp setup/AGENTS.md ~/.pi/agent/AGENTS.md
cp setup/CODING_CONVENTIONS.md ~/.pi/agent/CODING_CONVENTIONS.md
```

Choose authentication rather than assuming it:

- For provider subscription auth, start Pi and use `/login`; do not create `auth.json` from the API-key example.
- For environment-based OpenAI auth, copy `setup/auth.example.json` to `~/.pi/agent/auth.json`, set mode `0600`, and have the user provide `OPENAI_API_KEY` in their local environment.
- Copy `mcp.example.json` and `web-search.example.json` only for integrations the user selected. Their placeholders must be filled locally before those integrations can work.
- Do not copy `models.example.json` for the normal full profile; it is intentionally empty. Sol and Luna's dual-window behavior comes from `configs/model-aliases.json`.

Install the selected packages:

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

## Reference recipe: merge into an existing setup

Merge is the default when target configuration exists. Do not run the fresh-profile copy block over an existing machine.

1. Back up each file that the selected plan will touch, using a shared timestamp. At minimum, back up `settings.json` before any `pi install` command because package installation updates that file.
2. Merge selected settings structurally. Preserve unknown keys and current defaults that the user chose to keep; union the package list without duplicate npm package names, Git repository identities, or local paths. Remove obsolete `models.json` context-window overrides for Sol or Luna when adopting the full profile; the selected `model-aliases.json` config now owns their dual-window behavior.
3. Install only missing selected packages. `pi install` updates the package entry while preserving unrelated settings.
4. Compare each selected `setup/configs/*.json` file with its target and merge extension settings intentionally. When MCP server names differ, update the matching `prior` keys in `mcp-tool-loadout.json`.
5. Copy the Explore definition only if the user selected the Luna-backed override. Copy selected global skills from `setup/skills/` to `~/.agents/skills/` as whole skill directories, backing up any same-named skill first. Merge `AGENTS.md` by concept rather than blindly appending duplicate rules, and copy `CODING_CONVENTIONS.md` alongside it so its reference resolves. If the target machine still has a `~/.pi/agent/APPEND_SYSTEM.md` from an earlier sync, fold anything it still carries into `AGENTS.md` and remove it — the posture now lives in one file.
6. Preserve existing auth and private integration files. If a selected integration is absent, create its local file from the example and leave unresolved private values for the user to fill locally.

The full-profile defaults available for an explicit merge are:

- `defaultProvider: "anthropic"`
- `defaultModel: "claude-opus-5"`
- `defaultThinkingLevel: "xhigh"`
- the `enabledModels` list from `setup/settings.example.json`
- `enableInstallTelemetry: false`
- `followUpMode: "all"` and `steeringMode: "all"`
- `theme: "deep-focus-pi"`
- `pi-image-gen.defaultModel: "gpt-image-2"`
- the non-secret extension configs under `setup/configs/`
- the agent behavior files selected during questioning

## Local development setup

Use [`setup/settings.local.example.json`](setup/settings.local.example.json) only when editing this repo locally. Replace every `/ABSOLUTE/PATH/TO/pi-plugins` placeholder with the clone path. Normal installed setups should use the upstream Git source from `setup/settings.example.json`.

## Resources included

Use these descriptions when guiding a partial sync. The user may select individual packages/resources; dependencies required by a selected feature should be included automatically and explained.

### External helper packages

- `pi-mcp-adapter` — connects configured MCP servers to Pi.
- `@gotgenes/pi-subagents` — foreground/background specialized agents with custom agent definitions.
- `doodledood/manifest-dev` — figure-out, planning, execution, review, and PR workflow skills.
- `@juicesharp/rpiv-ask-user-question` — structured question UI for guided decisions.
- `@juicesharp/rpiv-todo` — persistent task-list tooling for multi-step work.
- `pi-web-access` — web search, content fetching, and source-backed library research.
- `@amaster.ai/pi-image-gen` — image generation and image editing.
- `doodledood/pi-plugins` — this repo's extension and theme bundle listed below.

### Agents

- `Explore` — setup-only global override for `@gotgenes/pi-subagents`; read-only exploration on `openai/gpt-5.6-luna` with medium thinking and evidence-oriented reporting. Copy it from `setup/agents/Explore.md` to `~/.pi/agent/agents/Explore.md`.

### Extensions

- `advisor-consult` — independent second-opinion advisor tool.
- `btw` — `/btw` side conversations with separate child history and a shared project workspace; the aside persists under the parent session so its spend stays countable.
- `cache-optimization` — prompt-cache diagnostics and TTL keepalive.
- `context-breakdown` — `/context` command for context-window usage breakdown.
- `goal-controller` — checker-only long-running goal controller; Aviram's portable config pins its checker to `openai/gpt-5.6-sol` at `xhigh` while the extension default remains `inherit`.
- `hq` — `/hq` decision-queue supervision of delegated sessions: headless workers stop, stops are triaged against ratified doctrine, and whatever needs you arrives as a self-contained packet you rule on without opening the session; `/fleet` shows the board.
- `gpt-fast-toggle` — OpenAI GPT priority service-tier toggle; records the billing tier so priority-tier turns can be priced.
- `mcp-tool-loadout` — compact MCP catalog and cache-safe schema loading.
- `message-stash` — single-slot input draft stash.
- `model-aliases` — selector-visible custom model aliases with separate visible and provider-target context windows; dual-window aliases enforce the visible edge through Pi's native compact-and-retry path. The portable setup defines Sol and Luna as 272K/1.05M aliases, and Opus 5 and Fable 5 as 500K/1M ones.
- `openai-max-output-floor` — prevents OpenAI min-output-token 400s near context limits.
- `openai-tts` — local OpenAI Speech API text-to-speech tool.
- `panel` — `/panel` parallel multi-model consultation: independent panelists answer over a fork of the live conversation, returned as attributed fallible opinions.
- `simple-statusline` — compact Pi footer/statusline, including whole-session-tree cost (this session plus every run it spawned) and the `/cost` breakdown.
- `skill-argument-hints` — argument hints for skill commands.
- `tool-activity-renderer` — compact rendering wrappers for built-in tools.

### Theme

- `deep-focus-pi`

### Skills

- `deletion-pass` — portable global audit skill. Runs an ordered "deletion pass" (question requirements, delete or absorb parts, simplify only what survives, accelerate/automate last) over a plan, design, architecture, or process and reports what to cut and what to question — audit only, it never rewrites the artifact. Ships as a setup template; copy `setup/skills/deletion-pass/` to `~/.agents/skills/deletion-pass/` to install it at the user level.

Global skills are intentionally not packaged as installable Pi *package* resources (no `packages/skills`, no `pi.skills`). Portable global skills instead ship under `setup/skills/` and are copied to the user level during replication, exactly like `setup/agents/`. This repo also includes project-local maintenance skills: [`sync-pi-setup`](.agents/skills/sync-pi-setup/SKILL.md), for syncing current local Pi setup changes back into `setup/`, and [`sync-manifest-dev`](.agents/skills/sync-manifest-dev/SKILL.md), for pulling the `manifest-dev` plugins' agents/hooks/skills into this repo. Both are symlinked into `.claude/skills/` for harnesses that discover Claude-style project skills, and so are the synced skills themselves: their content lives under `.agents/skills/` and is symlinked into `.claude/skills/`, so Claude-style and non-Claude agents read the same files. That is the reverse of how the other repos `sync-manifest-dev` serves are laid out; the skill handles both.

## Prime Agent setup

[Prime Agent](https://app.primeintellect.ai/prime-agent) is an independently developed fork of Pi's codebase — it still carries the inherited `@earendil-works/pi-*` package identifiers — with its own CLI (`prime-agent`), config dir (`~/.prime/agent`), and package commands. The extensions in this repo load in it unchanged; what differs is how sources are declared and updated.

This section documents the Prime Agent setup actually in use, not a second full portable sync. For the wider profile (models, theme, agents, integrations) follow the Pi guidance above and translate `~/.pi/agent/` to `~/.prime/agent/`.

Install Prime Agent itself with `curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh`.

### What this setup installs

`manifest-dev` whole, and only two extensions from this repo — the statusline and the cache work — rather than the full bundle:

```json
{
  "packages": [
    "git:github.com/doodledood/manifest-dev",
    {
      "source": "git:github.com/doodledood/pi-plugins",
      "extensions": [
        "packages/extensions/simple-statusline/extensions/simple-statusline.ts",
        "packages/extensions/cache-optimization/extensions/cache-optimization.ts"
      ],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

```bash
prime-agent package install git:github.com/doodledood/manifest-dev
prime-agent package install git:github.com/doodledood/pi-plugins   # then narrow it with the filter above
prime-agent package list
```

### Git sources must be ref-less

Write `git:github.com/doodledood/pi-plugins`, not `...@main` — the opposite of the Pi snippets elsewhere in this README. Prime Agent 0.7.0 parses any ref as `pinned: true` and skips pinned sources in both `package update` and the startup update notice, so a `@main` source silently never updates while `package update` still prints `Updated packages`. A ref-less source tracks the default branch and reconciles normally.

Pi is not affected the same way: its update path deliberately includes pinned git refs, so `@main` keeps working there. Only Pi's startup "packages have updates" notice skips them, which is why `setup/settings.example.json` can keep its `@main` entries.

### Updating

In 0.7.0 the two halves are separate commands — the top level is self-only and rejects package targets:

```bash
prime-agent package update      # extensions/packages only
prime-agent update              # Prime Agent itself; restarts the daemon and resumes live sessions
```

Run packages first, because a self-update restarts the background daemon and ends the command. Run `package update` from a neutral working directory, never `$HOME`: Prime Agent's project config path (`.prime/agent/settings.json`) resolves to the global settings file when the cwd is the home directory, so every package is collected twice and the concurrent git checkouts race on `.git/index.lock`.

A wrapper that gets both halves right:

```zsh
upgrade-prime-agent() {
  local rc=0
  (cd -q / && prime-agent package update) || rc=$?
  prime-agent update "$@" || rc=$?
  return $rc
}
```

## Installing individual resources

Install the root bundle when you want all included extensions and the theme:

```bash
pi install git:github.com/doodledood/pi-plugins@main
```

To load only one resource from the Git repo, use package filters in `~/.pi/agent/settings.json`. For example, BTW's package-root entry is:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/btw/index.ts"],
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

Do not rely on undocumented Git subdirectory install syntax. These Pi examples track `@main` so installs follow the latest version. Pin a specific commit only when intentionally using a frozen snapshot. Prime Agent is the exception — drop the ref entirely there, see [Prime Agent setup](#prime-agent-setup).

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

`npm run verify` runs structure checks, typechecks, and package test suites, including BTW's deterministic child-runtime and TUI coverage.

`npm run sync:doctrine` copies the live HQ doctrine (`~/.pi/hq/doctrine/global.md`) into `setup/hq/doctrine.global.md`, so the rules HQ decides by are versioned with the rest of the setup; `npm run sync:doctrine -- --install` puts it on a machine that has none and leaves an existing one alone.
