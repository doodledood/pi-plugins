# ADR: cache-optimization extension (keeper + keepalive) and head-stable goal reminders

## Status
Accepted

## Context
A forensic pass over 14 days of Pi session files (~$4,700 spend, 1,359 sessions; investigation log `~/.manifest-dev/logs/figure-out-log-20260706-133500.md`) attributed ~$609 of modeled avoidable waste to named prompt-cache break mechanisms:

- Pi places exactly three Anthropic `cache_control` breakpoints — last tool, system block, last user message (`pi-ai` `anthropic-messages.js`). Anthropic allows four, its cache lookup walks at most **20 content blocks** backward per breakpoint, and its 5-minute TTL refreshes free on every read (Anthropic prompt-caching docs).
- **>20-block bursts** (subagent notification floods, parallel tool turns) push the previous cache write out of the lookback window: the whole message history re-bills as a cache write (observed: read 36k of 568k, ~$6/hit at 500k contexts).
- **TTL expiry during long in-flight tool waits** (verifier subagents, builds) cost ~$131/14d on Anthropic alone; each expiry rewrites the full prefix at 1.25× input price.
- **goal-controller appended goal state to the system prompt** (`index.ts` `before_agent_start`), so every goal lifecycle transition invalidated system + messages caches (~$30/14d; tools-only cache hits observed at exactly the tools-segment size).
- The `/cache` diagnostics that discovered all this lived inside `simple-statusline`, whose stated design goal is an ambient footer, not a cache toolkit.

## Decision
1. **New `cache-optimization` extension package** owning all prompt-cache efficiency tooling; `simple-statusline` keeps only the ambient footer signal (session cache rate + break flag). The full analytics module (report, attribution, fingerprinting) moves wholesale; the statusline retains a slimmed copy of the pure stats it needs, accepting ~100 lines of duplication to preserve the repo's each-package-standalone install policy.
2. **Cache keeper**: on each outgoing Anthropic request, remember the previous request's tail-marker block position; when the new tail marker is >15 blocks past it, stamp the spare 4th `cache_control` breakpoint at the previous position (guaranteed lookback hit). Never stamps at 4 existing markers (OAuth dual-system shape), on non-Anthropic payloads, or on non-cacheable block types; re-anchors on branch switches; copies Pi's TTL shape.
3. **TTL keepalive**: while a tool execution is in flight and the last Anthropic request is ≥4.5 minutes old with a ≥100k-token prompt, re-read the prefix with `max_tokens: 1` (0.1× input price, ~12.5× cheaper than the rewrite it prevents). Runaway-proof by construction: in-flight-only (idle at the prompt = zero pings), per-gap cap of 6 pings (~0.5× one rewrite), daily $-estimate cap ($3.00, sized to fit one full gap budget at 500k scale so the per-gap cap binds first), 5m-TTL Anthropic payloads only, direct API-key path only (`api.anthropic.com`). Original correctness guards kept all extended-thinking payloads out because budget-style thinking cannot be reproduced with a 1-token ping. `20260707-adaptive-thinking-ttl-keepalive.md` later narrowed that rule: adaptive-thinking payloads may be refreshed by exact captured-provider-payload replay with streaming cache-read usage proof, while budget-style `thinking.enabled` remains excluded. Pings still ride only the session's own route (provider `anthropic`, default baseUrl, plain API-key auth — caches are isolated per org/workspace, so a different identity refreshes nothing the session reads).
4. **goal-controller head stability**: the active-goal reminder is delivered as a persistent appended context message (`before_agent_start` `message` return), injected once per (goal, activation), re-injected on resume transitions and after `/goal_edit` or compaction (compaction is a full cache reset, so the re-inject is free), retracted via a small appended message on terminal transitions (complete/blocked/budget-limited/cleared), and recovered from the session on reload — never a `systemPrompt` override.
5. **`PI_CACHE_RETENTION=long` split by provider: rejected for Anthropic, adopted for OpenAI only.** Anthropic: 1h writes cost 2× input (vs 1.25×); corrected counterfactual math over the 14-day window nets only ~+$21–26, and the keepalive captures the same in-flight gaps at 0.1× with no premium on every write — so Anthropic stays on the 5-minute default. OpenAI: adopted — `long` maps to 24h `prompt_cache_retention` with no write premium in OpenAI's pricing model. Scoping is done via provider-scoped env in `~/.pi/agent/auth.json` (`openai.env.PI_CACHE_RETENTION = "long"`, mirrored secret-free in `setup/auth.example.json`); the process environment stays unset so Anthropic is unaffected. Note: OpenAI's remaining sporadic misses (~1.9% of turns, single-turn recoveries) are provider-side best-effort routing noise that no client setting fixes — Pi already sends `prompt_cache_key` — so retention helps only the idle-gap class of OpenAI breaks.

## Alternatives Considered
- **Global `PI_CACHE_RETENTION=long` (both providers) instead of keepalive**: simpler (one env var) — rejected; on Anthropic the 2× premium applies to every write while keepalive pays only when a gap actually needs bridging, and the corrected math made Anthropic long retention marginal at best. Kept only as the OpenAI-scoped auth.json entry, where retention is premium-free.
- **Keepalive pinging whenever idle (including waiting for user)**: more coverage — rejected as the runaway scenario (a forgotten terminal pinging ~$0.55 every 4.5 minutes all day); idle-at-prompt gaps are unbounded, in-flight tool gaps are not.
- **Fixing notification bursts upstream in pi-subagents (batching)**: addresses one burst source — deferred; the keeper covers all >20-block bursts generically, upstream batching remains a nice-to-have.
- **Keeping `/cache` in simple-statusline**: no migration — rejected; payload mutation (keeper) and outbound network calls (keepalive) do not belong in an ambient statusline, and the toolkit should be installable without the footer.
- **Goal reminder re-injected every turn as a message**: stronger reinforcement — rejected as context pollution; once per activation plus checker continuation prompts carries the same information.

## Consequences

### Positive
- The two most expensive systematic Anthropic break mechanisms (lookback misses, in-flight TTL expiry) are closed for roughly zero marginal cost, with hard structural spend bounds.
- Goal lifecycle transitions no longer invalidate the head of the prompt cache.
- Cache tooling is independently installable and testable; the statusline returns to its ambient design goal.

### Negative
- ~100 lines of pure stats code duplicated between simple-statusline and cache-optimization (accepted trade-off T-1).
- The keeper mutates outgoing provider payloads — a class of risk the statusline never carried; mitigated by never-mutate-on-unrecognized-shape rules and payload-fixture tests.
- Keepalive pings are invisible spend (bounded, but real); the daily cap and /cache visibility keep them auditable.
- statusline users lose `/cache` unless they also install cache-optimization (READMEs cross-reference).

## Related
- `docs/adr/20260706-cache-efficiency-observability.md` — the observability layer (session cache rate, break attribution, fingerprinting) this extension inherits and relocates.
- `docs/adr/20260624-keep-goal-statusline-separate.md` — the ambient-footer principle that pushed the toolkit out of simple-statusline.
