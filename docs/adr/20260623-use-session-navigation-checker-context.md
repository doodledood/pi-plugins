# ADR: Use session-navigation context for goal checking

## Status
Accepted

## Context
The goal-controller checker currently receives an inline transcript generated from the current branch and capped by `continuation.transcriptMaxChars`. This creates two problems: the controller, rather than the checker, decides how much evidence is available; and a fixed character cap can hide earlier goal requirements or verification evidence. The existing continuation config also limits checker history preemptively and blocks after a single automatic continuation turn with no tool use, which is too conservative for long-running agent work.

Pi session files are JSONL trees: entries are linked by `id` and `parentId`, and the active conversation is the path from the current leaf to the root. A session file path alone is therefore not enough to identify the current branch when a session has branches. The checker needs enough navigation context to inspect the relevant branch when it decides more history is needed.

## Decision
Replace the capped inline transcript with a compact checker context envelope. The controller will provide goal state plus session navigation metadata such as the persisted session file path when available, current leaf entry id, branch/message counts, and latest-turn/tool metadata. The checker prompt will explain the Pi JSONL tree format and instruct the checker to inspect the session artifact only when needed, walking from the provided leaf id to root to reconstruct the active branch.

Remove `continuation.transcriptMaxChars`; the checker, not the controller, decides how far back to inspect. If no session file is available, checking is explicitly degraded rather than silently reintroducing a capped transcript.

Remove `continuation.checkerHistoryLimit` while preserving checker history in goal state. If history growth becomes a real problem, address it later with an evidence-backed retention or normalized storage design.

Replace `continuation.suppressAfterNoToolContinuation` with a consecutive no-tool continuation threshold defaulting to 3. Only automatic checker-driven continuation turns count; tool-using turns and user/system interventions reset the counter. The goal blocks when the threshold is reached.

Keep `checker.toolMode` defaulting to `inspect`. Treat the old `transcript`/no-tools mode as incompatible with session-file inspection unless it is explicitly redesigned; do not silently grant tools to a no-tools configuration.

## Alternatives Considered
- **Keep capped inline transcript**: Simple and supports no-tools checking, but preserves the core failure mode where the controller truncates evidence before the checker can decide what matters.
- **Pass only the session file path**: Removes the transcript cap, but is under-specified because Pi session files can contain multiple branches and the path does not identify the active leaf.
- **Remove checker history entirely**: Minimizes persisted state, but loses useful audit/debug information. The immediate problem is the premature limit, not the existence of history.
- **Keep one-turn no-tool suppression**: Prevents loops aggressively, but blocks legitimate reasoning or planning continuations too early. A consecutive threshold preserves loop protection with less false blocking.

## Consequences

### Positive
- The checker controls evidence depth and can inspect older context when the goal requires it.
- The controller prompt stays small and avoids subprocess argument growth from uncapped transcripts.
- Branch-aware metadata avoids checking the wrong path in branched sessions.
- Long-running goals are less likely to block after a single non-tool continuation.
- Checker history remains available for audit and debugging.

### Negative
- Checker correctness now depends on available inspection tools and persisted session files for deep history.
- In-memory sessions have degraded checker evidence unless a separate fallback is designed.
- Unbounded checker history can grow persisted goal state; this is accepted until it becomes observable.
- Existing config/docs/tests must migrate away from the old continuation fields.

## Source
- Session: figure-out discussion in this repo on 2026-06-23
- Related: `packages/extensions/goal-controller/extensions/goal-controller/`
