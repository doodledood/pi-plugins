# simple-statusline

Aviram's ambient custom Pi footer/statusline.

## Cache metric and /cache report

The footer's `cache NN%` token is the **session cache rate**: across the active
session branch so far, the share of input-side prompt traffic that was served
from prompt cache (total cache reads divided by total non-cached input + cache
reads + cache writes over all assistant turns). It converges as the session
progresses instead of bouncing with each turn. The token appears once the
branch has meaningful prompt traffic (≥1024 tokens) and the provider actually
reports cache usage. Cache-write totals live in the `/cache` report, not the
footer.

When the latest turn **breaks** the cache — it reads back less than half of the
prefix established by the previous turn (only checked once that prefix is
≥10k tokens; the first turn is never flagged) — the token turns warning-colored
with a `!` marker, e.g. `cache 42%!`.

Run **`/cache`** for a display-only report (never enters model context) with
per-turn prompt/read/write tokens, hit rates, flagged breaks, and why each
break happened, attributed in two layers:

1. **Session-entry correlation** (works for every turn, including turns from
   before the current process): compaction, model switch, branch/tree
   navigation, probable cache-TTL expiry from idle gaps (5 minutes by default,
   1 hour when `PI_CACHE_RETENTION=long`), or a generic "prefix content
   changed" fallback.
2. **Prefix fingerprinting** (only turns observed in the current process): each
   outgoing provider request's system prompt, tool set, and messages are
   hashed, and when no session-entry cause explains a break, the report names
   the first divergence — e.g. "system prompt changed", "tool set changed", or
   "message #12 changed".

Fingerprint state is **in-memory only and hashes only** — no request content is
retained, nothing is written to disk, and it is bounded to the most recent 500
turns. Turns without a retained fingerprint (from before the current process,
or pruned past that 500-turn window) get entry-correlation-only attribution and
are labeled as such.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/simple-statusline
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/simple-statusline/extensions/simple-statusline.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration and local state

`simple-statusline` does not require its own config file.

It reads `~/.pi/agent/gpt-fast-toggle.json` when present so the footer can show whether the separately installed `gpt-fast-toggle` extension is in priority mode. If that file is absent or invalid, the statusline simply omits the GPT priority indicator.

This is a read-only dependency on local Pi state. Do not commit a live `gpt-fast-toggle.json`; use `packages/extensions/gpt-fast-toggle/config/gpt-fast-toggle.example.json` or `profiles/aviram/configs/gpt-fast-toggle.json` as a safe example.
