# Pi setup

This directory is Aviram's portable Pi setup source of truth. It is a merge/copy template set, not a blind overwrite bundle.

For agent-guided replication onto another computer—including target inspection, the customization questions, merge policy, authentication choices, and completion checks—follow [the root README](../README.md#replicate-this-setup-with-an-agent). The flow below assumes those choices have already been made.

## Files

- `settings.example.json` — normal installed setup. It tracks `git:github.com/doodledood/pi-plugins@main`, installs external helper packages, defaults to `anthropic/claude-opus-5` at high thinking, and limits the model cycle to Sol at high, Opus 5 at high, Luna at max, and Fable 5.1 at high, plus unrestricted `claude-opus-5-full` and `claude-fable-5-1-full` variants at high for deliberate full-window sessions. Sol and Luna use 240K visible / 1.05M target dual-window aliases, Opus 5 and Fable 5.1 use 350K visible / 1M target ones, and the `-full` variants expose the whole 1M window, the setup enables `deep-focus-pi`, and image generation uses `gpt-image-2`.
- `settings.local.example.json` — local development setup. Replace `/ABSOLUTE/PATH/TO/pi-plugins` with the clone path before use. It lists each local extension package—including BTW—and the theme separately, replacing rather than duplicating the root Git bundle.
- `configs/` — non-secret per-extension configs. Copy files you use to `~/.pi/agent/` with the same basename. In particular, `configs/goal-controller.config.json` pins this setup's checker to `openai/gpt-5.6-luna` at `high`, regardless of the active session model; the extension itself still defaults to `inherit`.
- `agents/` — portable global agent overrides. Copy `agents/Explore.md` to `~/.pi/agent/agents/Explore.md` to replace `@gotgenes/pi-subagents`' hardcoded Haiku explorer with the read-only `openai/gpt-5.6-luna` profile at medium thinking.
- `skills/` — portable global skills. Copy a skill directory such as `skills/deletion-pass/` to `~/.agents/skills/deletion-pass/` to install it at the user level (harness-agnostic home; Pi also discovers `~/.pi/agent/skills/`). `deletion-pass` is an audit-only "deletion pass" over a plan/design/architecture/process — it reports what to cut and question, never rewrites.
- `mcp.example.json` — MCP template with placeholders for local wrapper paths, remote MCP hosts, proxy URLs, proxy IDs, and API keys.
- `web-search.example.json` — `pi-web-access` template. Copy to `~/.pi/web-search.json` and fill provider secrets locally.
- `configs/hq.json` — HQ's mechanical settings: the small model that titles the board and the
  cap on live workers. Everything else HQ runs on lives in doctrine's Meta section, in
  `hq/doctrine.global.md` below. Add `judgmentModel` / `judgmentThinking` only to pin HQ's
  triage and drill workers to a fixed model instead of following the seat's own.
- `hq/doctrine.global.md` — the live HQ doctrine: the standing rules HQ decides by. Kept in
  sync with `~/.pi/hq/doctrine/global.md` by `npm run sync:doctrine`, so ratifying a rule on
  one machine carries to the next one without anyone remembering to copy it.
  `npm run sync:doctrine --install` writes it to a machine that has no doctrine yet and
  never touches one that does. Project doctrine under `~/.pi/hq/doctrine/projects/` stays
  local, and so does the rest of `~/.pi/hq`: rulings, decisions, logs and session state.
- `models.example.json` — empty model-provider template. The full profile keeps every dual-window alias — Sol, Luna, Opus 5, and Fable 5.1 — in `configs/model-aliases.json` instead of using model-provider overrides.
- `auth.example.json` — secret-free template for `~/.pi/agent/auth.json`. It uses `$OPENAI_API_KEY` env indirection and scopes `PI_CACHE_RETENTION=long` to the built-in OpenAI provider.
- `CODING_CONVENTIONS.md` — the coding conventions on their own: designing against a class of bugs, what counts as verified, and how commits and pull requests are shaped. Split out of `AGENTS.md` because they are the half worth sharing with a project rather than a machine — a repo can adopt them without taking on the operating posture. Copy it beside `AGENTS.md`, which references it by name.
- `AGENTS.md` — Aviram's portable operating posture for the agent, in one file. It used to be split between `AGENTS.md` and an `APPEND_SYSTEM.md` appended to Pi's system prompt; both halves are merged here, so the same posture reaches every harness that reads a global agent-instructions file. Employer-specific workflows and machine-specific paths are deliberately left out of this template.

## Sync flow

1. Back up existing local files before replacing anything.
2. Use `settings.example.json` for normal installs and `settings.local.example.json` only while developing this repo. The normal root Git bundle already includes BTW; do not add a duplicate BTW source there.
3. Do not copy `models.example.json` for the normal full profile; it is intentionally empty. Remove obsolete Sol or Luna context overrides from an existing `models.json` while preserving unrelated providers and overrides.
4. Run `npm run sync:doctrine -- --install` to place HQ doctrine on a machine that has none;
   it leaves an existing one alone. Copy or merge `configs/*.json` into `~/.pi/agent/` after
   reviewing them. The Sol and Luna entries in `configs/model-aliases.json` enforce a 240K operating boundary through Pi's automatic compaction and native compact-and-retry paths while delegating allowed requests with a 1.05M target window; the Opus 5 and Fable 5.1 entries do the same at a 350K boundary against their 1M target window, and the `claude-opus-5-full` / `claude-fable-5-1-full` aliases leave the full 1M window unrestricted for sessions that deliberately want it. The Anthropic aliases carry no `apiKey`, so they use whatever auth that provider already has, falling back to `$ANTHROPIC_API_KEY`. The two Fable 5.1 aliases additionally spell out `api`, `baseUrl`, `reasoning`, `input`, `maxTokens`, `cost`, and `compat` because Pi's shipped model catalog does not yet contain `claude-fable-5-1` for the alias to inherit from; every one of those fields is load-bearing until it does, and once the catalog picks the model up they can all be deleted. The goal-controller config deliberately overrides only checker model and thinking, leaving all other controller settings on package defaults.
5. Copy or merge `agents/*.md` into `~/.pi/agent/agents/`; same-name files override `@gotgenes/pi-subagents` defaults. Copy or merge skill directories from `skills/` into `~/.agents/skills/`, backing up any same-named skill first.
6. Copy or merge `auth.example.json` into `~/.pi/agent/auth.json`, keep it `0600`, and provide the real `OPENAI_API_KEY` through the local environment rather than in this repo.
7. Merge `AGENTS.md` only when the user wants Aviram's agent behavior, and copy `CODING_CONVENTIONS.md` beside it — `AGENTS.md` points at it by name, so the reference dangles without it. Delete any leftover `~/.pi/agent/APPEND_SYSTEM.md` from an earlier sync once its content is folded in.
8. Copy `mcp.example.json` and `web-search.example.json` as local templates, then fill placeholders in local files. Do not ask the user to paste secrets into chat.
9. If local MCP server names are changed, update matching `mcp-tool-loadout` prior keys in `configs/mcp-tool-loadout.json` before copying that config.
10. If a previous machine used `models.json` or `model-aliases.json` for an older model profile, remove obsolete overrides and aliases before merging the current alias set.

## Secret handling

Never commit filled local values. Keep raw API keys, OAuth state, tokens, cookies, sessions, caches, logs, generated package repos, raw `auth.json`, filled `mcp.json`, and real `web-search.json` outside this repo. Templates here should use placeholders or environment-variable references only.
