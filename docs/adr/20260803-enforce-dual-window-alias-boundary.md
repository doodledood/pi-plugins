# ADR: enforce the dual-window alias boundary before provider requests

## Status
Accepted

## Context

`model-aliases` can expose one context window to Pi while delegating requests with
a larger target window. The portable Sol profile uses a 372,000-token visible
operating window and a 1,050,000-token provider target.

The split fixed output-token clamping near the artificial boundary, but it did
not fully enforce the operating window during long tool loops:

- Pi 0.83 checks its normal compaction threshold after an entire agent run.
- One agent run can contain many provider responses and tool batches.
- The target model accepts requests above 372K, so a long run can continue toward
  1.05M before Pi reaches its post-run check.
- Recorded Sol sessions confirmed the mechanism: individual runs made dozens of
  tool-driven requests above 372K and reached 500K–733K before stopping.

The visible model metadata was correct. The missing behavior was a provider-call
boundary inside the alias route.

## Decision

For aliases whose target context window is larger than the visible context
window, estimate the context before every delegated request.

When the estimated request reaches the visible window:

1. Do not call the target provider.
2. Return a local assistant error matching Pi's context-overflow contract.
3. Preserve the selected alias identity on that error, as with every other alias
   response.
4. Let Pi's existing overflow path compact the session and resume the interrupted
   tool loop.

Pi-owned compaction and branch-summary calls bypass the visible boundary and use
the target hard window. These calls must be able to read the context they are
replacing, and an overflow raised from inside summarization has no second
compaction path through which it could recover. They are recognized by Pi's exact
summarization system prompt and single tagged-conversation message shape.

Estimate context the same way Pi does: use the latest valid assistant usage plus
trailing messages and newly loaded tools; when no valid usage exists, estimate
the system prompt, tools, and all messages from their serialized size.

Same-window aliases keep their existing provider-owned enforcement. The guard
fires at the visible edge, not at Pi's configurable reserve threshold, because
this layer owns the alias's operating-window contract but cannot read or replace
Pi's compaction policy.

## Alternatives considered

### Trigger `ctx.compact()` from `turn_end`

Rejected. Manual extension compaction aborts the active run and does not carry
Pi's native retry semantics. Preserving autonomous work would require a second
continuation mechanism and an extra synthetic message. It would also react only
after the oversized request had already completed.

### Add a general turn-boundary compaction extension

Rejected. The mismatch exists only where an alias knows both a smaller visible
window and a larger target window. A global extension would duplicate Pi policy
for unrelated models and could conflict with user compaction settings.

### Lower the target context window to 372K

Rejected. That makes Pi's provider request clamp reduce the output budget against
an artificial hard limit during a tool loop. The separate 1.05M target remains
necessary to give the crossing response enough real provider capacity.

### Continue silently when automatic compaction is disabled

Rejected. A model advertised as 372K should not send requests beyond 372K just
because its target can accept them. With automatic compaction disabled, the local
overflow remains visible and the user can compact manually or re-enable it.

## Consequences

### Positive

- Sol cannot issue another normal provider request once its estimated context
  reaches the configured 372K operating window.
- Compaction and continuation use Pi's native, tested overflow-recovery path.
- No extra continuation message enters model context.
- Requests below the boundary still use the target model's full hard capacity for
  output clamping.
- Compaction and branch summaries can consume an over-visible-window history as
  long as the summary request remains within the target hard window.

### Negative

- One provider response can cross the visible edge because usage is known only
  after that response; the next request is blocked. Overshoot is therefore bounded
  to one response and tool-result batch rather than to zero tokens.
- The extension carries a small copy of Pi's context-estimation shape and Pi's
  stable summarization request signature so it can enforce the boundary before
  delegation without blocking recovery itself.
- With automatic compaction disabled, reaching the visible edge now stops instead
  of continuing toward the larger target window.

## Verification

Coverage proves that:

- the exact visible edge produces a Pi-recognized context-overflow result without
  calling the target delegate;
- requests below the edge still delegate;
- same-window aliases remain unchanged; and
- fallback estimation counts initial prompt/tool context and newly loaded tools;
- a deterministic AgentSession tool loop blocks the oversized request, delegates
  an over-visible-window summary under the target hard window, records one
  compaction, and resumes successfully through Pi's native retry path.
