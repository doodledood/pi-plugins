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

**Mission control (MC)**:
A planned supervisory layer — an automated agent plus a global sensor/actuator extension — that triages unattended Pi sessions' stop points and engages the user only where user judgment is load-bearing.
_Avoid_: Orchestrator, hub, inbox (earlier rejected designs).

**Release (MC move)**:
MC's reply unblocking a stopped session with "proceed with your recommendation", optionally injecting user tastes, always carrying a self-guarding reversibility clause.
_Avoid_: Nudge, approve.

**Escalation (MC move)**:
MC routing a stop point to the user with a re-entry ramp; the user rejoins the conversation in the session's own tab, never answers from a compressed queue item.
_Avoid_: Notification when the triage decision is meant.

**Re-entry ramp**:
A belief-register-style summary (leading read, settled points, open threads, the pending question) whose purpose is fast return to full immersion — explicitly not a decision brief for answering in place.
_Avoid_: Brief, capsule.

**Session posture**:
A per-session engagement mode: live/paired (user drives per-step, MC only shields) or supervised (run to natural stop, then MC compiles a review report); the default is supervised.
_Avoid_: Mode when Pi UI modes could be meant.

**On-behalf ledger**:
MC's per-session record of every release and policy-cited answer it made in the user's stead, surfaced at review with in-transcript provenance badges (rendered, never entering worker LLM context).
_Avoid_: Audit log when the Pi session file is meant.

**Release-loop budget**:
A hard cap on consecutive MC releases to one session without user contact, forcing escalation so individually reversible releases cannot compound into a committed trajectory.
_Avoid_: Rate limit.

**Figure-out watcher**:
A planned external reasoning auditor — a different model in a fresh background SDK session — that reads a figure-out investigation log as it grows and interjects into the driver's chat when it finds reasoning holes; the figure-out skill is its audit standard, never its operating identity.
_Avoid_: Fact-checker, reviewer agent.

**Pre-read checkpoint**:
The investigation-log entry (heading contains `PRE-READ CHECKPOINT`) a watched figure-out driver appends before naming its read; the watcher always answers it with an explicit verdict interject, and in autonomous runs the driver blocks on that verdict.
_Avoid_: Gate tool (deleted design), sign-off.

**Panel**:
A user-triggered consultation mode (the `panel` extension in this repo): `/panel <question>` forks the current conversation to several independently-running models in parallel, blocks the main chat behind a focused monitor component, then returns their answers to the main model as attributed fallible opinions before it responds.
_Avoid_: Ensemble, companions, council (earlier candidate names); consult.

**Panelist**:
One member model of a Panel, running agentically over a transcript fork of the conversation with a chosen effort level in a session shaped like a regular pi session (extensions, skills, and full tools loaded; interactive-only tools excluded), read-only toward the working tree (scratch writes go to temp dirs) unless the user's message explicitly grants writes.
_Avoid_: Companion, advisor (advisor_consult is a different, dispatcher-briefed mechanism).

**Tool-row glyph**:
The leading colored dot or spinner that marks a compact tool row and anchors the rendered tool activity in the transcript.
_Avoid_: Dot thingy.

**Goal controller**:
A Pi extension in this repo that manages one long-running session goal and delegates completion authority to an independent checker.
_Avoid_: Goal mode when referring to the extension implementation.

**Model aliases**:
A Pi extension in this repo that registers selector-visible provider/model aliases and routes aliased model calls through a hidden stream API to configured upstream provider/model IDs while preserving the selected alias identity in session history.
_Avoid_: Model override when referring to selector-visible aliases.

**OpenAI max-output floor**:
A Pi extension in this repo that raises `max_output_tokens` to the OpenAI Responses provider minimum (16) on outgoing payloads via `before_provider_request`, so requests do not 400 when Pi's context-aware clamp drops the output budget below 16 near the context window. Scoped by the snake_case `max_output_tokens` field so only OpenAI Responses / Azure OpenAI Responses payloads are touched; only ever raises a sub-minimum value, never lowers a legitimate budget.
_Avoid_: Token limiter, max-tokens cap (it is a floor, not a cap).

**Context-clamp output underflow**:
The condition where Pi's `clampMaxTokensToContext` returns a value below the OpenAI Responses minimum (as low as 1) because the estimated context leaves almost no room in the configured window, which unfixed produces `max_output_tokens: 1` and a provider 400; the OpenAI max-output floor converts that failure into a provider-valid 16-token request but cannot make an artificially small context window safe.
_Avoid_: Context overflow (that is a different, input-side condition).

**Artificial context boundary**:
A Pi model `contextWindow` deliberately set below the provider's real hard window to induce earlier compaction or display a preferred operating envelope; on Pi 0.80.6 it also hard-clamps request output and can stop long mid-agent turns before compaction runs.
_Avoid_: Provider context window, compaction threshold.

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

- **Mission control** classifies each stop point into a **Release (MC move)**, a policy-cited answer, or an **Escalation (MC move)**; the **Release-loop budget** bounds consecutive releases.
- A **Session posture** of live/paired suspends MC action on that session (user attention is the supervision); supervised posture ends in a review built from the **On-behalf ledger** plus a **Re-entry ramp**.
- Irreversible execution actions escalate in real time regardless of **Session posture**.

- A **Figure-out watcher** audits the driver's discipline against the live figure-out skill files; the driver remains the sole fact-verifier, and a **Pre-read checkpoint** is the one beat where the watcher must respond rather than stay silent.

- A **Panelist** answers the user's question *before* the main model does, so on the current question it is unanchored by the main model's take; the main model is the last mover, synthesizing with all **Panel** answers in hand.
- A **Panel** injects each **Panelist**'s final answer verbatim and attributed into the main session — never their tool transcripts, which stay viewable in the UI.
- The **Goal controller** publishes **Goal footer** state through Pi extension status APIs; the statusline renderer consumes that state but remains a separate surface.
- A **Live goal** blocks new goal starts; a **Stopped goal** can be superseded by a new **Goal controller** goal.
- A **Completed goal** is not a **Live goal**; resuming it returns the same goal record to active work while historical checker verdicts remain audit history.
- A **Cache break** is detected by comparing the latest turn's cache reads against the previously established prefix, with a collapsed **Latest cache hit rate** as its visible symptom; the **Session cache rate** tracks aggregate efficiency — the two are complementary, not interchangeable.
- The **Cache keeper** and **TTL keepalive** prevent two specific **Cache break** mechanisms (the **20-block lookback** miss and TTL expiry during active foreground/background work); the /cache report in cache-optimization explains the rest after the fact.
- A **Background-wakeup TTL break** was historically outside the **TTL keepalive**'s foreground-only coverage; generalized background-work arming now covers launches that follow Pi's `run_in_background`-style convention, while idle-with-no-work remains zero-ping.
- The **Goal reminder message** replaced the goal controller's system-prompt suffix precisely because system-prompt churn was a recurring **Cache break** cause.
- The **OpenAI max-output floor** prevents a hard provider 400 during **Context-clamp output underflow**, but at an **Artificial context boundary** the accepted 16-token response can still stop for length; a durable alias must keep Pi's visible compaction window separate from the target model metadata used for provider clamping.

## Flagged ambiguities
