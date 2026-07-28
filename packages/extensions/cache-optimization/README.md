# cache-optimization

Prompt-cache efficiency toolkit for Pi. Three duties, one extension:

1. **`/cache` diagnostics** — per-turn cache report with break detection and
   attribution.
2. **Cache keeper** — protects the Anthropic message-history cache span across
   large message bursts by stamping the spare 4th cache breakpoint.
3. **TTL keepalive** — cheap prefix re-reads during long foreground-tool waits
   or idle background-work waits so the 5-minute Anthropic cache doesn't
   expire before the next request; structurally bounded against runaway cost.

Background: Pi places three Anthropic `cache_control` breakpoints (last tool,
system block, last user message). Anthropic's cache lookup walks at most 20
content blocks backward per breakpoint, and the 5-minute TTL refreshes free on
every read. Both properties leak money in agent-heavy sessions — a >20-block
burst (background notifications, parallel tool turns) silently re-bills the
whole history as a cache write, and a >5-minute foreground-tool or background
wait expires the cache (~$5-6 per event at 500k-token contexts). This extension
closes both gaps and explains every other break via `/cache`.

## /cache report

Run **`/cache`** for a display-only report (never enters model context) with
per-turn prompt/read/write tokens, hit-rate bars, per-turn cost, flagged
breaks, and why each break happened. Its mouse wheel uses a process-global
cooperative reporting lease so compatible overlapping Pi overlays can coexist.
Breaks are attributed in two layers:

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
turns.

The ambient footer companion (session cache rate + break flag) lives in the
separately installable `simple-statusline` extension.

## Cache keeper

On every outgoing Anthropic request the keeper remembers where the previous
request's tail cache marker sat. When the new tail marker lands more than 15
content blocks past it (Anthropic's lookback window is 20), the keeper stamps
the spare 4th `cache_control` breakpoint on the block at the previous position
— a guaranteed cache hit no matter how many blocks were appended. Breakpoints
are free, so the stamp costs nothing when it isn't needed.

Safety rules: never stamps when 4 breakpoints already exist (e.g. OAuth mode's
dual system blocks), never touches non-Anthropic payloads, never marks
non-cacheable block types (thinking), resets its anchor on branch switches, and
copies Pi's own TTL shape onto the stamped marker.

## TTL keepalive

While a foreground tool is still running, or while the main agent is idle but
waiting on background work that will wake a later request, the keepalive
re-reads the prefix (`max_tokens: 1`) after ~4.5 minutes — a read at 0.1× input
price (~12.5× cheaper than the rewrite it prevents) that refreshes the
5-minute TTL for free.

Background-work detection is deliberately **package-agnostic**. Any tool call
whose arguments carry a truthy `run_in_background`-style flag (for example
`run_in_background`, `runInBackground`, or `background_work`) counts as a
background launch, regardless of the tool name or extension that provided it.
No companion extension is required; cache-optimization can be installed on its
own and still keeps the cache alive when other extensions follow the convention.
Pending background work is armed after the current agent turn ends, consumed by
the next real provider-request wake, cleared on branch/tree navigation or
shutdown, and dropped by a fail-safe expiry that only removes stale work (never
extends pinging).

Runaway is prevented structurally, not by tuning:

- **Work-only**: pings fire only while a foreground tool execution is in flight
  or while there is armed pending background work. Idle at the prompt with no
  pending work (you walked away) = zero pings, ever.
- **Per-gap budget**: at most 6 pings between real requests (~0.5× the rewrite
  cost the pings try to prevent), then silence.
- **Daily dollar cap** (default $3.00, estimated from read pricing) — sized to
  fit one full gap budget at 500k-token scale so the per-gap cap is the
  operating bound; the dollar cap is the backstop.
- **Activation floor**: no pings below 100k prompt tokens.
- **Anthropic 5m-TTL only**: payloads carrying 1h markers
  (`PI_CACHE_RETENTION=long`) or non-Anthropic payloads are never pinged.
- **Thinking-safe payloads only**: no-thinking and Pi's explicit
  `thinking: { type: "disabled" }` marker use the cheap non-streaming
  1-token read. Modern Anthropic adaptive-thinking payloads
  (`thinking: { type: "adaptive" }`, plus `output_config.effort` when present)
  use a stricter streaming refresh: the exact captured provider body is
  replayed opaquely with only `max_tokens: 1` and `stream: true` changed, the
  stream is cancelled after Anthropic's `message_start`, and success is counted
  only when usage proves a cache read (`cache_read_input_tokens > 0` and no
  cache creation). Budget-style extended thinking
  (`thinking: { type: "enabled", budget_tokens: ... }`) remains excluded because
  `max_tokens: 1` is invalid and changing the budget changes the message-cache
  parameters. GPT/OpenAI is never part of this path.
- **Same-route only**: pings fire only when the session itself talks to the
  default Anthropic Messages API through the same plain process
  `ANTHROPIC_API_KEY` the keepalive will use (provider `anthropic`, API adapter
  `anthropic-messages`, default baseUrl, API key is not an OAuth-looking
  `sk-ant-oat...` token, no Anthropic entry
  in `auth.json`, no provider/model API-key or auth-header override, no
  `ANTHROPIC_OAUTH_TOKEN` in the environment, no CLI `--api-key` runtime
  override — an override's key can't be compared, so its presence disables
  pings). Anthropic caches are isolated per org/workspace, so a ping through a
  different identity or URL would refresh nothing the session reads.

Load-order assumption: the keepalive replays the provider body exactly as *this
extension* observed it in `before_provider_request`; it never forks or rebuilds
the Pi conversation. If another payload-rewriting extension is loaded after
cache-optimization, the actual request may differ from the replayed one; load
cache-optimization last among payload-rewriting extensions (this repo's root
manifest and setup templates already order it last).

Worst case ever: one hung tool costs ~half of one rewrite in pings and then the
rewrite anyway — bounded at ~1.5× one break, once. **For Anthropic**,
`PI_CACHE_RETENTION=long` was evaluated and rejected in favor of this
keepalive: the 1h tier doubles every cache write (2× input price vs 1.25×),
which roughly eats the savings, while keepalive reads cost 0.1× and only fire
when needed. (OpenAI is a different story — its 24h retention carries no write
premium and can be adopted per-provider via auth.json env scoping; see
`docs/adr/20260706-cache-optimization-extension.md`.)

Keepalive activity stays auditable: the `/cache` report ends with a status
line (pings today, estimated spend, last-ping failure flag). The daily cap is
per pi process — N concurrent sessions can each spend up to the cap.

Tunables (constants at module top): cadence, per-gap cap, daily cap,
background-work expiry, and activation floor in
`extensions/cache-optimization/keepalive.ts`; the scheduler tick interval in
`extensions/cache-optimization.ts`.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/cache-optimization
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/cache-optimization/extensions/cache-optimization.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration, environment, and local state

No config file. Runtime behavior:

- Reads `ANTHROPIC_API_KEY` from the environment for keepalive pings; without
  it the keepalive is inert. Pings go only to `https://api.anthropic.com/v1/messages`.
- Reads `PI_CACHE_RETENTION` to label TTL-expiry attribution in `/cache`. The
  keepalive's long-retention guard is payload-based, not env-based: requests
  whose `cache_control` markers carry `ttl: "1h"` are never pinged, which also
  covers provider-scoped retention settings the process env can't see.
- Keeps fingerprint hashes, the keeper anchor, and keepalive budgets in-memory
  only; no request content is persisted anywhere.
- Writes one `pi-cost-record` entry to the session per **billed** keepalive ping:
  the usage the provider reported, priced with pi's own model rates. A keepalive
  ping is a real Anthropic request that no session records, so without this its
  spend is invisible; the `simple-statusline` cost surfaces read these records
  into the session-tree total and `/cost` shows them as a keepalive bucket.
  These are custom entries, which are durable but excluded from LLM context, and
  they carry only model, token counts, cost, and an id — never request content.
  A ping that failed, was skipped, or reported no usage records nothing rather
  than an estimate.
