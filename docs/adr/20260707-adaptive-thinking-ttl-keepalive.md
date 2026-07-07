# ADR: Use captured-provider-payload replay for adaptive-thinking TTL keepalive

## Status
Accepted

## Context
The `cache-optimization` extension originally treated all thinking-enabled Anthropic payloads as unpingable. That was safe but too narrow for modern Claude usage: Fable 5, Opus 4.6/4.7/4.8, and Sonnet 5 use adaptive thinking (`thinking: { type: "adaptive" }`) rather than budget-style `thinking.enabled` with `budget_tokens`.

Live direct-Anthropic probes on 2026-07-07 showed that adaptive-thinking requests can refresh the 5-minute prompt cache using a streaming request with `max_tokens: 1`, cancelled after the `message_start` event. A full TTL test on `claude-sonnet-5` wrote a 54,025-token 5-minute cache entry, refreshed it after about 4.5 minutes with `cache_read_input_tokens: 54025` and `cache_creation_input_tokens: 0`, then read the same cache again about 9 minutes after the original write. A no-refresh control at the same age rewrote instead. Immediate seed/read probes also passed on `claude-opus-4-6`, `claude-opus-4-7`, and `claude-opus-4-8`.

The same probes also showed why static model trust is insufficient: `claude-fable-5` read cache on smaller non-refusing prompts, but one large synthetic repetitive prompt produced a refusal and the attempted refresh wrote again. Budget-style thinking remains unsafe: `claude-opus-4-5` with `thinking: { type: "enabled", budget_tokens: 1024 }` and `max_tokens: 1` returned a 400 because `max_tokens` must be greater than the thinking budget.

The critical design question is whether a keepalive should fork/rebuild the current Pi conversation or replay the provider payload captured by the extension. Provider cache identity depends on rendered provider request shape and selected request parameters. Rebuilding from Pi session state risks changing system/context/tool state, extension mutations, loaded tool schemas, branch state, or future provider-body fields.

## Decision
Implement adaptive-thinking TTL keepalive by replaying the exact provider body captured from Pi's `before_provider_request` hook, not by forking or rebuilding the Pi conversation.

For direct Anthropic plain API-key requests only (not OAuth-looking `sk-ant-oat...` tokens), classify payloads by provider-body shape:

- no thinking or `thinking: { type: "disabled" }` → existing standard 5-minute keepalive path;
- `thinking: { type: "adaptive" }` with 5-minute cache markers → adaptive streaming refresh path;
- `thinking: { type: "enabled", budget_tokens: ... }`, 1-hour TTL markers, non-Anthropic providers, custom/proxy routes, OAuth/non-api-key auth, Anthropic `auth.json` entries or provider/model request auth overrides, and unknown cache-marker shapes → excluded.

For adaptive refresh, preserve the captured provider body opaquely and change only:

```json
{
  "max_tokens": 1,
  "stream": true
}
```

The extension must parse Anthropic server-sent events through `message_start`, cancel/abort the stream after usage is observed, and count success only when provider usage proves a cache read and no write:

```text
cache_read_input_tokens > 0
cache_creation_input_tokens == 0
```

A 200 response, missing usage, zero cache read, or positive cache creation is not a successful keepalive. The gap is abandoned so repeated pings cannot accidentally write cold cache entries at full price.

Keep GPT/OpenAI out of this mechanism. OpenAI uses a different prompt-cache and retention model; any OpenAI optimization belongs in a separate provider strategy.

## Alternatives Considered
- **Continue excluding all thinking-enabled payloads.** Safe but misses the dominant modern Claude usage path and contradicts live evidence for adaptive thinking.
- **Fork or rebuild the current Pi conversation for refresh.** Rejected because it can change cache-significant provider request shape and risks creating side-session state. Captured-provider-payload replay is simpler and closer to cache identity.
- **Allow every Anthropic thinking payload.** Rejected because budget-style `thinking.enabled` is invalid with `max_tokens: 1`, and changing budget parameters invalidates message cache.
- **Trust model names.** Rejected because support varies by payload behavior; live Fable probes showed HTTP success can still be a cache write rather than a read. Usage telemetry is the authority.
- **Adopt Anthropic 1-hour TTL instead.** Still rejected as the default because 1-hour writes cost 2× input on every write. A 5-minute cache read costs 0.1× and only fires during bounded long gaps.

## Consequences

### Positive
- Extends bounded 5-minute TTL keepalive to the adaptive-thinking Claude path used by modern Fable/Opus/Sonnet models.
- Preserves future provider-body fields automatically because the replay body is opaque.
- Keeps cache correctness tied to provider usage telemetry rather than assumptions.
- Maintains existing route/auth/runaway boundaries.

### Negative
- Still does not support OAuth, proxies, Bedrock, Vertex, Anthropic auth.json/provider-key overrides, or budget-style thinking.
- Streaming SSE parsing adds implementation complexity.
- Provider behavior can drift; the usage-proven success criterion and fail-closed miss handling are mandatory.

## Verification
- Live direct-Anthropic probes recorded in `/Users/aviram.kofman/.manifest-dev/logs/figure-out-log-20260707-133032.md`.
- Unit tests cover adaptive classification, exact opaque replay, SSE `message_start` usage parsing, cache-read success, cache-creation/miss disarm, error/missing-message-start failure, budget-style rejection, GPT/OpenAI exclusion, direct-route guards, and existing standard keepalive behavior.
