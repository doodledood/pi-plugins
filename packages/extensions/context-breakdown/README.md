# context-breakdown

Claude-Code-style /context command for Pi showing context-window usage by category.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/context-breakdown
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/context-breakdown/extensions/context-breakdown.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration and local state

`context-breakdown` works without package-specific config. Requires Pi 1.4.0 or newer.

The reserve it shows is Pi's effective compaction reserve for the current model —
`compaction.reserveTokens`, a `compaction.modelOverrides["provider/model"]` entry when
there is one, and zero when `compaction.enabled` is `false` — read from Pi's merged
settings, so it matches what Pi itself will compact at.

For Anthropic models, it can call Anthropic's `count_tokens` API for exact token accounting. Set these environment variables locally when you want exact counts:

- `ANTHROPIC_API_KEY` — required for exact Anthropic token counts.
- `ANTHROPIC_BASE_URL` — optional; defaults to wherever Pi routes the `anthropic` provider, else `https://api.anthropic.com`.

## What the numbers describe

The breakdown is the last request Pi sent for the current model, counted whole —
including Pi 1.4's mid-conversation system messages, such as tools added during the
session, which count under Messages. The request's beta features are passed on to
`count_tokens`. Pi's `__pi_deferred_placeholder__` tool counts as one of Pi's own tools,
not as an MCP server.

`/compact`, `/tree` and switching model change what the next request will hold without
sending one. Until the next request, the system prompt and tools are measured live and
the messages part is Pi's own estimate from the session, and the source line says so.

On other providers the total is Pi's own context usage; the split between categories is
estimated with calibrated chars-per-token ratios, and Messages takes the remainder. Every
estimate counts an image as Pi does (a fixed size per image), not as text.

When the active model is not Anthropic, or when `ANTHROPIC_API_KEY` is absent, or
`count_tokens` fails, the breakdown is labelled as estimated. Do not commit API keys in
repo/setup files.
