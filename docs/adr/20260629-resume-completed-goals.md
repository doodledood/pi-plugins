# ADR: Resume completed goals as historical reactivation

## Status
Accepted

## Context
The goal controller already treats a checker-completed goal as non-live: starting a new goal after `complete` is accepted, while active, checking, and waiting-for-user goals remain protected from replacement. A separate usability need emerged: a user should also be able to resume a completed goal when the same objective needs more work or follow-up.

The main state tension is that a completed goal carries a `lastCheckerVerdict` whose decision is `complete`. That field is shown in `/goal` summaries and included in checker-visible goal state. If a completed goal were resumed by only flipping its status back to `active`, the prior completion could leak into the revived run and make the user or checker treat old completion as current proof.

## Decision
Allow `/goal_resume` to reactivate a completed goal. Resuming a completed goal resurrects the same goal record rather than cloning a fresh goal with the same text.

On resume from `complete`, the controller should make the previous completion operationally historical: clear `lastCheckerVerdict`, reset continuation/no-tool state, and set the goal status back to `active` with the normal resumed transition reason. Preserve `checkerHistory`, `checkerIteration`, goal text, usage counters, budgets, and identity as the audit trail of the earlier run.

The model-callable `goal` tool should continue to create a fresh goal only when no live goal exists. Its prompt surface should explicitly make terminal `complete` non-live/restartable enough that the worker model does not mistake a completed goal for an active live-goal block.

## Alternatives Considered
- **Keep completed goals non-resumable**: Preserves a simple terminal-state model, but forces users to start a new goal or edit/clear state when they actually want to continue the same objective.
- **Start a fresh cloned goal from the completed goal text**: Avoids old completion leakage, but loses the identity and audit continuity that make “resume” distinct from “start another goal.”
- **Only flip `complete` to resumable without clearing `lastCheckerVerdict`**: Minimal implementation, but leaves the prior complete verdict in user-visible summaries and checker-visible state, risking false current completion.
- **Append a non-checker resume marker to `checkerHistory`**: Makes the boundary explicit inside history, but widens a checker-verdict-only schema for little benefit. The resumed transition reason plus cleared `lastCheckerVerdict` is enough.

## Consequences

### Positive
- Users can continue a completed objective without manual clear/recreate friction.
- The resumed goal keeps durable audit continuity through preserved checker history and counters.
- Clearing `lastCheckerVerdict` prevents stale completion from being interpreted as current proof.
- The lifecycle remains consistent: live goals are protected, while non-live completed goals can be resumed or superseded.

### Negative
- A completed goal is no longer a final-only terminal state; it can become active again by explicit user command.
- Summaries of a resumed goal will not show the prior checker verdict in `lastCheckerVerdict`; historical completions remain only in `checkerHistory` unless a future UI exposes that history.
- The implementation needs tests for both controller-level state semantics and command/tool-facing behavior so prompt or wiring drift does not reintroduce stale-completion leakage.

## Source
- Session: figure-out discussion in `pi-plugins` on 2026-06-29
- Related: `packages/extensions/goal-controller/extensions/goal-controller/controller.ts`
- Related: `packages/extensions/goal-controller/extensions/goal-controller/index.ts`
- Related: `packages/extensions/goal-controller/extensions/goal-controller/prompts.ts`
