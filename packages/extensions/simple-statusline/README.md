# simple-statusline

Aviram's ambient custom Pi footer/statusline.

## Context metric

The footer shows context usage as a percentage of the active model's context
window plus compact token counts, e.g. `49% 98k/200k`. If Pi reports only token
usage, the statusline computes the percentage from the model window.

At **50%** of the window, the context segment turns warning-colored and appends
`compact at boundary`. This is a display-only planning hint: it does not compact
automatically, does not write session entries, and never enters model context.
The hint refreshes with normal footer state after compaction or branch/tree
navigation.

## Cache metric

The footer's `cache NN%` token is the **session cache rate**: across the active
session branch so far, the share of input-side prompt traffic that was served
from prompt cache (total cache reads divided by total non-cached input + cache
reads + cache writes over all assistant turns). It converges as the session
progresses instead of bouncing with each turn. The token appears once the
branch has meaningful prompt traffic (≥1024 tokens) and the provider actually
reports cache usage.

When the latest turn **breaks** the cache — it reads back less than half of the
prefix established by the previous turn (only checked once that prefix is
≥10k tokens; the first turn is never flagged) — the token turns warning-colored
with a `!` marker, e.g. `cache 42%!`.

Full cache diagnostics — the `/cache` per-turn report, break attribution,
prefix fingerprinting, cache keeper, and TTL keepalive — live in the separately
installable `cache-optimization` extension in this repo. The footer here is the
ambient signal; `/cache` is the on-demand "why".

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
