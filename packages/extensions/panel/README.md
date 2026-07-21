# pi-panel

`/panel <question>` — consult a panel of independent models in parallel over a fork of your live pi conversation, and get their answers back as attributed hints before your main model responds.

## What it does (and honestly doesn't)

When you run `/panel <question>`:

1. A lineup picker opens (models + effort from your config; see below): segmented `‹ effort ›` control per row, provider column, and a header showing the selected count plus a rough cost estimate for the fork. Enter launches.
2. The active branch's context (compaction applied) is forked and each **panelist** runs your question in its own isolated in-process pi session — full agentic tools, in parallel, independent of each other.
3. A slim **ambient bar** replaces the editor for the duration of the run — your chat transcript stays visible above it — with an animated spinner and one live line per panelist (state glyph, model, elapsed, tokens, cost, current activity). The inspect key (default `ctrl+p`; `i` also works) opens a **drill-in split view**: one bordered column per panelist streaming its transcript, `tab` zooms one panelist to full width, digit keys switch focus, and `esc` returns to the bar (with more than 3 panelists the split degrades to a single zoomed pane with a chip strip). `esc` on the bar cancels the whole panel and restores your question to the editor unsent.
4. When all panelists finish, each final answer is injected into your session **verbatim and attributed**, rendered as a styled collapsed row (state-colored glyph, stats, and a quoted first-line preview of the answer) you can expand to the full text. Your main model then answers with those opinions in hand.

**Honest framing:** this is *independent peer opinions over shared history* — panelists are independent of each other, of any dispatcher-written brief, and of your main model's take on the current question (they answer before it does). It is **not** clean-room re-derivation: the forked history still contains your main model's earlier reasoning. The injected answers are explicitly framed to the main model as fallible opinions of other model entities — hints to weigh, not truths or instructions.

## Isolation model and its flip condition

Panelists run fully agentic in your working directory under **prompt-level guardrails**: treat the tree as read-only, write scratch output only to their own temp dirs, treat shared external systems (staging, DBs) as read-only — unless your panel question explicitly grants writes. This suits the intended use (perspectives, investigations, claim verification), and residual clash risk is accepted.

**Flip condition:** if you start asking panelists to *implement or prototype* things, prompt guardrails stop being enough — that's the point to reinstate structural isolation (extension-created git worktree per panelist). It's an additive upgrade, not a redesign.

## Cost model

Cost ≈ forked context size × number of panelists × effort, per consult, before any tool work the panelists do. The manual trigger is the cost control: reach for `/panel` at junctures (a decision, a review, a stuck point), not per message.

**What prompt caching does and doesn't buy here.** Each panelist pays full input price to ingest the fork once — that is unavoidable: provider caches are per-model (and per key), so no panelist can reuse your main session's cache, and even a same-model panelist can't, because the panelist system prompt and tool set differ from the main session's, which changes the cached prefix from byte zero. What you do get automatically: within each panelist session, pi's normal provider caching (Anthropic cache_control, OpenAI automatic prefix cache) makes the panelist's own subsequent agentic turns read the fork at cache prices — usually the bulk of a multi-turn run. Net: cost scales with fork size and panelist count/effort; caching softens the tool-loop turns, not the first ingestion.

## Config

`~/.pi/agent/panel.json` (respects `PI_CODING_AGENT_DIR`; see `config/panel.example.json`):

```json
{
  "panelists": [
    { "model": "anthropic/claude-fable-5", "thinking": "xhigh" },
    { "model": "openai/gpt-5.6-sol", "thinking": "xhigh" },
    { "model": "google/gemini-3-pro", "thinking": "high" }
  ],
  "preselected": [0, 1],
  "inspectKeybinding": "ctrl+p",
  "timeoutMs": 900000
}
```

- `panelists` — lineup shown in the picker (`model` is any pi model reference; `thinking` is `off|minimal|low|medium|high|xhigh|max`).
- `preselected` — lineup indexes selected by default (default: all).
- `inspectKeybinding` — opens the drill-in inspect view during a run (default `ctrl+p`).
- `timeoutMs` — per-panelist wall-clock budget (clamped 30s–1h; default 15m).

**No config or empty lineup?** The picker shows the built-in default lineup preselected: `anthropic/claude-fable-5` at `xhigh` and `openai/gpt-5.6-sol` at `xhigh`.

## Troubleshooting: Anthropic "Terms of Service" blocks

Panelists receive the conversation as a plain transcript document (never as replayed assistant-role messages), precisely because feeding one model's outputs to another vendor as assistant turns trips anti-distillation screening — Anthropic hard-blocks that shape.

If an Anthropic panelist still reports a ToS block, it is an **account/model-level screening flag on your API key**, not the panel content: keys that accumulated flagged requests (e.g. from panel versions before the transcript fork) can get a sticky per-model restriction where even trivial prompts to that model are blocked while other models on the same key work fine. Verify with `pi -p --no-session -nt --model anthropic/<model> "what is 17*23?"`. Workarounds: use another Anthropic model for that panelist (sonnet/haiku), retry later (flags can decay), or use different credentials; persistent cases are an Anthropic support matter.

## Local files this extension writes

- **Panelist sessions:** each panelist run persists as a normal pi session file (in pi's standard sessions location for the project), seeded with the forked history so it is self-contained — browsable and resumable later. Paths are shown in the collapsed "panel run" metadata row after each run.
- **Panelist scratch:** panelists are instructed to write scratch output only under temp dirs they create (`mktemp -d`); nothing is written to your working tree.
- The extension reads `~/.pi/agent/panel.json` and writes no other state.

## Install

From a local clone:

```bash
git clone git@github.com:doodledood/pi-plugins.git
pi install /path/to/pi-plugins/packages/extensions/panel
```

Or install just this extension from the repo with a Git package filter in your pi settings (tracks `main`):

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/panel/extensions/panel/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Future npm install:

```bash
pi install npm:@doodledood/pi-panel
```

## Development

```bash
npm run typecheck --workspace @doodledood/pi-panel
npm run test --workspace @doodledood/pi-panel
# live smokes (real providers, cheap models only):
PANEL_SMOKE_MODELS="anthropic/claude-haiku-4-5:off,openai/gpt-4.1-mini:off" npm run smoke --workspace @doodledood/pi-panel
npm run smoke:cancel --workspace @doodledood/pi-panel
```
