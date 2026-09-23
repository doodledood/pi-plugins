# ADR: Validate only the goal checker's verdict path in Pi's JSON stream

## Status
Accepted

## Context
The goal checker runs `pi --mode json` as a subprocess and reads its verdict from the JSONL event stream. A run of hardening commits (`6c70665` through `e8e5cd7`) made the controller schema-check every record in that stream: every known event type, every message role, every assistant content block and usage field, every session-entry type and every streaming sub-event, each against a closed list. Any record outside the list counted as a "malformed recognized event envelope" and failed the whole checker run, which pauses the goal.

Pi evolves that stream freely, and each extension broke every goal check until the controller caught up:

- Pi 0.83 added `stopReason: "pending"` to in-flight assistant messages (fixed in `04bcc38`).
- Pi 0.84 stripped the cumulative snapshot from `message_update` (fixed in `89e039e`).
- Pi 0.86/0.87 added a `role: "system"` transcript message on `message_start`, `message_end` and `agent_end`. Every checker run then failed with "3 malformed recognized event envelopes" even though the checker had returned a valid verdict with `stopReason: "stop"`.

The deep checks guarded nothing the verdict depends on. The verdict comes from the text of the last settled assistant `message_end`; the other records are progress, bookkeeping and transcript copies. `advisor-consult` already parses the same stream by reading only the assistant `message_end` and has not broken across these Pi releases.

## Decision
The checker enforces only the contract its verdict depends on:

1. Every non-empty stdout line is a JSON object with a string `type` (catches stdout pollution and truncation).
2. The run reaches `agent_settled`, and no record follows it (the terminal answer is final, including after retries).
3. Every `message_end` carries a message with a string `role`; every assistant `message_end` has a `content` array, a terminal `stopReason` (`stop`, `length`, `toolUse`, `error`, `aborted`; never `pending`), and a string-or-absent `errorMessage`.

Everything else — event types, message roles, content blocks, session-entry types, streaming sub-events and extra fields — is ignored. A violation is reported by its kind and count (for example `1× event after agent_settled`), never by content, so the failure names what broke without leaking transcript text.

This also closes the diagnosability gap: the old message gave only a count, so each Pi change needed a manual reproduction to find the offending record.

## Alternatives Considered
- **Add each new Pi shape to the closed lists as it appears**: the fix used for 0.83 and 0.84 — Rejected because it guarantees the next Pi protocol addition pauses every goal again until the controller ships a patch.
- **Validate deeply but log instead of failing on unknown shapes**: keeps the validator's upkeep with no decision depending on it, and a warning nobody acts on is noise.
- **Pin the Pi version the checker subprocess runs**: the checker must run the user's installed Pi to share its auth, models and bootstrap extensions, so pinning is not available.
- **A live contract test against the installed Pi in CI**: it would catch drift but costs a model call per run and still only detects the break; narrowing the contract removes the break itself.

## Consequences

### Positive
- Pi releases that extend the JSON stream no longer pause goals; the controller no longer tracks Pi's full event schema.
- Protocol failures name the violated rule, so the next genuine breakage can be diagnosed from the error line alone.
- Roughly 300 lines of validators and their per-shape rejection tests are gone.

### Negative
- A corrupted or mis-shaped record off the verdict path (for example a malformed `tool_execution_end`) is no longer reported. It cannot change the verdict, but it is no longer surfaced as a warning sign of a broken Pi build.
- If Pi ever changes the verdict-path shapes themselves (the `message_end` assistant message, `stopReason` values, or `agent_settled`), the checker still fails loudly and needs an update — intentionally, since that is where a silent misread would cost a wrong verdict.

## Source
- Session: diagnosis of a goal paused with "Goal checker returned a malformed Pi JSON event stream (3 malformed recognized event envelopes)" on Pi 0.87.1.
- Related: 20260623-use-session-navigation-checker-context, 20260709-advisor-consult-independent-subprocess
