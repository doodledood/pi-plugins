# pi-plugins

A collection of individually installable Pi extensions and themes maintained in this repository.

## Language

**Tool activity renderer**:
A Pi extension in this repo that wraps built-in file and shell tools with compact custom TUI renderers.
_Avoid_: Tool rendering plugin.

**Compact tool rendering**:
A renderer mode that minimizes built-in tool rows by hiding routine output unless the row is expanded or something abnormal happens.
_Avoid_: Compact mode when the renderer context is unclear.

**Session cache rate**:
The cumulative token-weighted cache-hit percentage for the active session branch, computed as total cacheRead over total input + cacheRead + cacheWrite across assistant messages. Shown ambiently by the simple-statusline footer; the full per-turn breakdown lives in cache-optimization's /cache report.
_Avoid_: Cache %, cache utilization when the latest-turn rate could be meant.

**Latest cache hit rate**:
The single most recent assistant turn's cacheRead share of its prompt tokens, matching Pi's built-in footer CH metric.
_Avoid_: Session cache rate.

**Cache break**:
A turn whose cache reads fall far below what the established context prefix predicts, typically flagged by a low latest cache hit rate together with a large prompt and often a cacheWrite spike (re-prime signature).
_Avoid_: Cache miss when referring to a whole-prefix invalidation event.

**Cache keeper**:
The cache-optimization behavior that stamps Anthropic's spare 4th cache_control breakpoint at the previous request's tail-marker position whenever more than ~15 content blocks were appended between requests, so the provider's 20-block lookback still finds the previous cache write.
_Avoid_: Cache pinning, breakpoint hack.

**TTL keepalive**:
The cache-optimization behavior that re-reads a large cached Anthropic prefix (max_tokens 1, 0.1× input price) during long foreground-tool waits or idle waits on pending background work so the 5-minute cache TTL does not expire before the next request; structurally bounded (work-only arming, per-gap ping cap, daily dollar cap, activation floor, background expiry) and correctness-guarded (direct Anthropic API-key route only, adaptive-thinking refresh must replay the exact captured provider payload and prove cache-read usage, budget-style thinking and GPT/OpenAI are excluded).
_Avoid_: Cache heartbeat, keep-warm when the bounded design is the point.

**Background-wakeup TTL break**:
A Cache break where a >5-minute gap ends at a background completion notification or other custom entry while no foreground tool execution is in flight. Historically this was not covered by a foreground-only TTL keepalive; the generalized TTL keepalive now covers background work launched through package-agnostic `run_in_background`-style tool arguments.
_Avoid_: In-flight TTL break.

**20-block lookback**:
Anthropic's prompt-cache read behavior of checking at most 20 content-block positions backward from each cache breakpoint for a previously written prefix; appends larger than the window silently lose the message-history cache.
_Avoid_: Cache window when the context-window could be meant.

**Goal reminder message**:
The goal controller's persistent appended context message carrying the active goal text and rules, injected once per goal activation (and on resume transitions) instead of a system-prompt override, so goal lifecycle changes never invalidate the provider prompt cache head.
_Avoid_: Goal system prompt.

**Tool-row glyph**:
The leading colored dot or spinner that marks a compact tool row and anchors the rendered tool activity in the transcript.
_Avoid_: Dot thingy.

**Goal controller**:
A Pi extension in this repo that manages one long-running session goal and delegates completion authority to an independent checker.
_Avoid_: Goal mode when referring to the extension implementation.

**Model aliases**:
A Pi extension in this repo that registers selector-visible provider/model aliases and rewrites provider requests to configured upstream provider/model IDs.
_Avoid_: Model override when referring to selector-visible aliases.

**OpenAI max-output floor**:
A Pi extension in this repo that raises `max_output_tokens` to the OpenAI Responses provider minimum (16) on outgoing payloads via `before_provider_request`, so requests do not 400 when Pi's context-aware clamp drops the output budget below 16 near the context window. Scoped by the snake_case `max_output_tokens` field so only OpenAI Responses / Azure OpenAI Responses payloads are touched; only ever raises a sub-minimum value, never lowers a legitimate budget.
_Avoid_: Token limiter, max-tokens cap (it is a floor, not a cap).

**Context-clamp output underflow**:
The condition where Pi's `clampMaxTokensToContext` returns a value below the OpenAI Responses minimum (as low as 1) because the estimated context leaves almost no room in the window, which unfixed produces `max_output_tokens: 1` and a provider 400. A large-context alias (e.g. `openai-1m/gpt-5.5-1m`) avoids it by leaving budget headroom; the OpenAI max-output floor covers the regular provider.
_Avoid_: Context overflow (that is a different, input-side condition).

**Goal checker**:
An independent Pi subprocess run by the goal controller to assess whether the active goal's completion contract has been proven.
_Avoid_: Worker, completion tool.

**Goal footer**:
The Pi footer/statusline segment used by the goal controller to show the active goal's lifecycle state.
_Avoid_: Goal widget when referring only to the footer/statusline surface.

**Live goal**:
A goal controller goal that is active, checking, or waiting for user input and should block starting a different goal.
_Avoid_: Non-terminal goal when the distinction includes stopped states.

**Stopped goal**:
A goal controller goal that is paused, blocked, or budget-limited and may be replaced by a newly started goal without an explicit clear.
_Avoid_: Inactive goal when the lifecycle boundary is ambiguous.

**Completed goal**:
A goal controller goal with status complete that is not live and may be resumed or superseded while preserving prior checker verdicts only as history.
_Avoid_: Terminal goal when resumability matters.

## Relationships

- The **Goal controller** publishes **Goal footer** state through Pi extension status APIs; the statusline renderer consumes that state but remains a separate surface.
- A **Live goal** blocks new goal starts; a **Stopped goal** can be superseded by a new **Goal controller** goal.
- A **Completed goal** is not a **Live goal**; resuming it returns the same goal record to active work while historical checker verdicts remain audit history.
- A **Cache break** is detected by comparing the latest turn's cache reads against the previously established prefix, with a collapsed **Latest cache hit rate** as its visible symptom; the **Session cache rate** tracks aggregate efficiency — the two are complementary, not interchangeable.
- The **Cache keeper** and **TTL keepalive** prevent two specific **Cache break** mechanisms (the **20-block lookback** miss and TTL expiry during active foreground/background work); the /cache report in cache-optimization explains the rest after the fact.
- A **Background-wakeup TTL break** was historically outside the **TTL keepalive**'s foreground-only coverage; generalized background-work arming now covers launches that follow Pi's `run_in_background`-style convention, while idle-with-no-work remains zero-ping.
- The **Goal reminder message** replaced the goal controller's system-prompt suffix precisely because system-prompt churn was a recurring **Cache break** cause.
- **Context-clamp output underflow** is what the **OpenAI max-output floor** neutralizes: the clamp still returns a tiny budget, but the floor raises it to 16 before send so the provider accepts the request. **Model aliases** with large context windows sidestep the underflow entirely, which is why the bug appeared only on the regular OpenAI provider.

## Flagged ambiguities
