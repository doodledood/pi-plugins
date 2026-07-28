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

## Cost metric

The footer's dollar figure is the **whole session tree's lifetime spend**: this
session plus every run it spawned — subagents, advisor consults, goal-checker
audits, panelists, BTW asides — plus billed calls that produce no session of
their own (cache keepalive pings, speech).

Pi itself prices one session file and never aggregates related ones, so its own
footer and `/session` report only this session's turns and will read lower.
That is expected: this figure is the one that answers "what did this cost".

How it is computed: every session reachable from this one is scanned and summed
with Pi's own rules (assistant usage, tool-result usage, compaction and
branch-summary usage) over all entries, not just the active branch. Children are
found two ways — by their location under this session's directory, and by the
`parentSession` link in their header — and each session is counted once no
matter how many ways it is reachable. Scanning is incremental: session files are
append-only, so an unchanged file is never re-read, and the figure refreshes on
session events rather than while the footer paints.

A leading `~` means the total is a **floor rather than an exact number**. Two
things cause it:

- **Priority-tier turns.** With `gpt-fast-toggle` in fast mode, OpenAI bills the
  priority service tier above the standard rate Pi prices from. Set
  `priorityMultiplier` in `~/.pi/agent/gpt-fast-toggle.json` (e.g. `2`) to price
  those turns; until then they are counted at standard rates and marked.
- **Unpriceable models.** A model with no resolvable per-token price — typically
  a `model-aliases` entry whose target Pi does not price — reports real tokens
  at $0. A paid call that says outright it could not be priced counts the same
  way, such as speech with no configured per-character rate.
- **Unreadable session files.** A child session the scan could not read is spend
  missing from the total entirely, so the figure is marked rather than presented
  as exact.

### `/cost`

`/cost` takes the figure apart: lifetime total versus active-branch subtotal (both
by the same accounting rules), per spawned session, per provider/model with token
counts, why the total is approximate when it is, how much scanning the last
refresh actually did, and what it cannot see at all.

Two installed extensions spend money without reporting any usage —
`pi-web-access` (search-answer synthesis and paid search APIs) and
`pi-image-gen` — so their spend is unrecoverable from the session and sits
outside this total. `/cost` names them rather than letting the number read as
every dollar spent.

### Retention

Child sessions live under the parent session's directory
(`<parent-session-file-without-.jsonl>/<kind>/`, i.e. a directory named exactly like the parent session file minus its extension) and are kept for the life of the
parent session: they are the evidence behind the number, and deleting them
lowers it. Removing a parent session's `.jsonl` file and its sibling directory
of the same name removes the whole tree. Pi lists sessions from one directory
non-recursively, so these nested files never appear in `/resume`.

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

It reads `~/.pi/agent/gpt-fast-toggle.json` when present, for two things: whether the separately installed `gpt-fast-toggle` extension is in priority mode (shown as `FAST`), and the optional `priorityMultiplier` used to price priority-tier turns. If that file is absent or invalid, the priority indicator is omitted and priority turns are counted at standard rates with the total marked `~`.

This is a read-only dependency on local Pi state. Do not commit a live `gpt-fast-toggle.json`; use `packages/extensions/gpt-fast-toggle/config/gpt-fast-toggle.example.json` or `setup/configs/gpt-fast-toggle.json` as a safe example.
