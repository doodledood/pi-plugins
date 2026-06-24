# mcp-tool-loadout

Usage-driven MCP tool loadout for Pi: compact catalog, budgeted active schemas, and wake-on-demand.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/mcp-tool-loadout
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.2.1",
      "extensions": ["packages/extensions/mcp-tool-loadout/extensions/mcp-tool-loadout/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration

See `config/` for safe example config and `profiles/aviram/configs/` for Aviram's current non-secret defaults.

## Original extension notes

# mcp-tool-loadout

A Pi extension that stops MCP tool definitions from burning your context window while
keeping the model **fully aware of every available tool**.

## What it does

The `pi-mcp-adapter` registers each `directTools` MCP tool as a full Pi tool (name +
description + JSON schema). With several servers that is ~20–30k tokens of definitions
in your prompt before you type anything. This extension keeps that awareness but trims
the cost:

1. **Always-visible catalog.** Every MCP tool's *name* is injected into the system
   prompt, grouped by server and marked active/·dormant/·proxy. The model never has to
   guess a keyword to discover a tool — it sees the exact callable names. (Active tools
   also appear with full schemas in the normal tool list, so the catalog stays names-only
   to keep it compact.)
2. **Budgeted active set.** Only the highest-value MCP tool *schemas* stay active in the
   prompt, up to a token budget. The rest are deactivated (their schema leaves the
   prompt) but remain one call away.
3. **Usage-driven ranking.** Which tools stay active is decided by recency-weighted
   usage plus a cold-start prior, recomputed once per session. Usage is tiered: this
   repo's own history first; if it has little MCP usage, your pooled **global** usage
   (across all repos); and only then the configured prior. Stats are keyed by **repo
   name**, so all worktrees/clones of a repo share one history.
4. **Wake on demand.** A `load_tools(["name", …])` tool re-activates dormant tools for
   the rest of the session. One-off calls can also go straight through the `mcp` proxy.

Built-in tools (read, bash, edit, grep, …), the `mcp` proxy, and `load_tools` are
**never** gated — only `pi-mcp-adapter` tools are.

## Why it works this way

- **Per-session-static.** Pi prompt-caches the system+tools prefix. Changing the active
  set mid-session invalidates that cache, so the active set is chosen once at
  `session_start` and held stable; `load_tools` wakes are intentional, bounded cache
  misses. The injected catalog is byte-stable within a session for the same reason.
- **Awareness over blind search.** A pure proxy hides tool names and forces keyword
  search. Listing names (≈1–1.5k tokens) is far cheaper than the schemas (~20k+) and
  removes the discovery guesswork.
- **No `mcp.json` change required.** It rides on the adapter's existing `directTools`
  registration via Pi's native `setActiveTools`/`getAllTools`; it does not patch or
  depend on adapter internals.

## Config

Optional file: `~/.pi/agent/mcp-tool-loadout.json`. Missing/partial/malformed → safe
defaults.

| Key | Default | Meaning |
|-----|---------|---------|
| `enabled` | `true` | Master switch. `false` → no gating and no catalog (default Pi behavior). |
| `budgetTokens` | `10000` | Approx token budget for the active MCP-tool schema slice. Heuristic: JSON length ÷ 2.5, calibrated against Anthropic `count_tokens` (tool-schema JSON is ~2.48 chars/token, not the ~4 that holds for prose) so the budget reads in ≈real tokens and lines up with `/context`. |
| `halfLifeDays` | `14` | Recency half-life: a usage event's weight halves every N days. |
| `minProjectEvents` | `5` | MCP-tool usages a repo needs before its own history is trusted; below this, ranking uses pooled global usage. |
| `prior` | (see below) | Cold-start ranking. Keys are a **tool name** (prefixed, e.g. `alpha_get_page`) or a **server name** (e.g. `alpha_mcp`); tool-specific wins over server-level. |
| `alwaysActiveMcpTools` | `[]` | MCP tools that stay active regardless of score/budget. |
| `excludeFromCatalog` | `[]` | Tool names to omit from the injected catalog. |

Default prior is neutral:

```json
{}
```

Put workflow-specific priors in your user config, for example in `~/.pi/agent/mcp-tool-loadout.json` or a profile template.

Scoring: `score(tool) = Σ exp(-ln2 · age / halfLife)` over recent usage `+ prior(tool)`.
The usage events come from this repo when it has `≥ minProjectEvents` MCP-tool usages,
otherwise from pooled global usage across all repos; with no usage anywhere the prior
orders the set, and as you use tools the prior washes out.

## Usage from the model's side

- Active tools: call directly.
- `·dormant` tools: `load_tools(["tool_name"])`, then call it on the next turn — or
  `mcp({ tool: "tool_name", args: "{…}" })` for a single one-off.
- `·proxy` tools (proxy-only servers, never registered as direct tools): call via
  `mcp({ tool, args })`.

## Files & state

- Installed package source location depends on install source: your local package path, Pi's git package cache, or Pi's npm package cache. In this repo, the development package lives at `packages/extensions/mcp-tool-loadout/` and its extension entry is `extensions/mcp-tool-loadout/index.ts`.
- `~/.pi/agent/mcp-tool-loadout.json` — tunables (optional).
- `~/.pi/agent/mcp-tool-loadout-stats.json` — usage events keyed by repo name (auto-created); the global signal is the pool of all repos' buckets.
- Reads `~/.pi/agent/mcp-cache.json` (the adapter's metadata cache) for the full tool universe.

## Failure behavior

Fail-safe: on any error (corrupt cache/stats, empty tool list, thrown handler) the
extension no-ops and leaves the default tool set active — it never disables your tools.
Status shows in the footer as `loadout: N active / M dormant MCP`.

## Activating / disabling

It loads on the next `/reload` or Pi restart. To disable without uninstalling, set
`{"enabled": false}` in `~/.pi/agent/mcp-tool-loadout.json` and `/reload`.

## Development

```bash
cd /path/to/pi-plugins/packages/extensions/mcp-tool-loadout
npm run typecheck   # tsc --noEmit
npm run test        # tsx --test extensions/mcp-tool-loadout/*.test.ts
```

Logic lives in pure modules (`config`, `mcp-detect`, `stats`, `select`, `catalog`,
`compute`, `actions`); `index.ts` is thin event glue. Tests are hermetic (fixtures +
in-memory hosts, no live MCP servers or network).
