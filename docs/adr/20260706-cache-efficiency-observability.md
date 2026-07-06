# ADR: Layered cache-efficiency observability (footer signal + /cache attribution)

## Status
Accepted

## Context
`simple-statusline` showed only the latest assistant turn's cache hit rate (`cacheRead / (input + cacheRead + cacheWrite)` for the most recent message). The owner's actual goal is understanding cache inefficiency: an aggregate session-level efficiency signal that converges over time, plus the ability to know when and why prompt cache broke.

Constraints and facts that shaped the decision:

- The footer is deliberately ambient and low-hierarchy (design goal stated at the top of `simple-statusline.ts`); it should carry trend and alarm, not diagnosis.
- Pi exposes per-assistant-message usage with separable `input` (non-cached), `cacheRead`, and `cacheWrite` fields, verified against provider mappings (OpenAI Responses/Completions, Anthropic).
- Session entries record the dominant cache-breaking events: `compaction`, `model_change`, `branch_summary` (tree navigation), and message timestamps (TTL-expiry inference). Default cache retention is short; `PI_CACHE_RETENTION=long` extends it (1h Anthropic / 24h OpenAI).
- Some cache breaks leave no session entry: extension `context`-event message mutations (ephemeral), `message_end` replacements, per-turn system-prompt changes, and tool-set changes. These are only observable at the provider payload level via `before_provider_request`.

## Decision
Build cache-efficiency observability in two surfaces with a layered attribution model:

1. **Footer (simple-statusline)**: replace the latest-turn percentage with the **session cache rate** — `Σ cacheRead / Σ (input + cacheRead + cacheWrite)` over assistant messages in the active branch (`getBranch()`, same scope as the existing token/cost totals) — plus a visible **break flag** when the latest turn's cache reads fall far below what the established prefix predicts (large prompt, low reads, typically a `cacheWrite` spike).
2. **`/cache` command**: on-demand per-turn cache history with attributed causes.
3. **Layered attribution**:
   - *Session-entry correlation* (works for any turn, including historical ones): compaction → full break; `model_change` → per-model cache; `branch_summary` → prefix rewritten; large wall-clock gap → TTL expiry; otherwise re-prime signature → prefix content changed.
   - *Live prefix fingerprinting* (works for turns observed in the current process): hash the system prompt, tools block, and each serialized message in `before_provider_request`; keep the previous turn's hashes in memory; on a break, report the first divergence point (system prompt / tools / specific message index). Hashes only — no payload content retention.

## Alternatives Considered
- **Footer shows both session % and latest % always**: More info at a glance — rejected as noisier while still not explaining why breaks happen.
- **Inline break notifications with best-guess cause**: Immediate "why" — rejected because notifications interrupt flow and single-guess attribution risks being wrong; kept as a fallback if cause-at-a-glance proves necessary.
- **Everything on-demand via `/cache` only**: Zero footer noise — rejected because breaks would go unnoticed as they happen.
- **Entry correlation only (no fingerprinting)**: Simplest — rejected after pressing "will we know when prior messages changed?": ephemeral context mutations, system-prompt and tool-set changes leave no session entry, so all such breaks would land in an unexplained re-prime bucket.
- **Full payload capture/diffing instead of hashing**: Exact diffs — rejected for memory weight and the risk of retaining sensitive prompt content.

## Consequences

### Positive
- Session cache rate converges over the session, matching the aggregate-efficiency mental model.
- Cache breaks are visible the moment they happen without making the footer noisy.
- `/cache` explains most breaks: entry correlation covers the dominant causes across the whole session; fingerprinting pinpoints exact prefix divergence for in-process turns.
- Footer stays ambient, consistent with its stated design goal and the spirit of `20260624-keep-goal-statusline-separate`.

### Negative
- Two surfaces (footer + command) and an event hook to maintain instead of one render function.
- Fingerprinting cannot attribute turns from before the current process started; those fall back to coarser entry correlation.
- The break-flag heuristic needs threshold tuning to avoid false alarms on small prompts or legitimate first turns.
- Per-turn in-memory hash state is new mutable state in an otherwise stateless renderer domain.

## Source
- Session: figure-out investigation, log at `~/.manifest-dev/logs/figure-out-log-20260706-111449.md`
- Related: 20260624-keep-goal-statusline-separate
