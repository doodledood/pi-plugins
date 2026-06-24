# ADR: Allow new goals over stopped goals

## Status
Accepted

## Context
The goal controller currently allows only one non-terminal goal in a session. `startGoal` rejects a new goal whenever the existing goal has any non-terminal status, including `paused`, `blocked`, and `budget_limited`. That means a user who paused an old goal and moved on has to run `/goal_clear` before starting a new goal, even though no goal work is actively continuing.

The useful distinction is not terminal versus non-terminal; it is live versus stopped. A live goal is still in progress, being checked, or waiting for an answer that may satisfy it. A stopped goal has already been paused or halted and should not block the user from starting something new.

## Decision
Starting a goal should replace the current controller state when there is no live goal. New goal starts should be accepted when there is no goal, when the previous goal is terminal, or when the previous goal is stopped/inactive: `paused`, `blocked`, or `budget_limited`.

New goal starts should still be rejected while the current goal is live: `active`, `checking`, or `waiting_for_user`.

This applies to goal start entrypoints generally, including the model-callable `goal` tool and the `/goal <text>` command. Replacing a stopped goal creates a new active goal and leaves prior goal history in the session log; it does not require the user to run `/goal_clear` first. A running checker is still protected: `checking` remains live and must be paused, cleared, or allowed to finish before a new goal starts.

## Alternatives Considered
- **Keep blocking all non-terminal goals**: Preserves a strict single-goal invariant, but creates needless friction after a goal is paused or halted.
- **Allow replacement for every status except `active`**: Reduces friction further, but would allow replacing `checking` or `waiting_for_user` goals that are still live and may be about to complete or resume.
- **Add a separate replace command**: Makes intent explicit, but keeps the common "paused old goal, start a new one" path too cumbersome.
- **Require `/goal_clear` before every new goal**: Clear and explicit, but makes stale paused/blocked goals feel sticky and user-hostile.

## Consequences

### Positive
- Users can move on from paused, blocked, or budget-limited goals without manual cleanup.
- The controller still protects live goal work from accidental replacement.
- The start behavior aligns with the user-visible lifecycle: stopped goals do not continue automatically.

### Negative
- A stopped goal can be superseded without an explicit clear action, so the latest controller state no longer represents that older stopped goal.
- The implementation needs a more precise predicate than the current `isNonTerminalGoal` block: live statuses and stopped statuses must be distinguished.
- If a user wants to replace a `waiting_for_user` goal, they still need to pause or clear first because it remains a live goal state.

## Source
- Session: figure-out discussion in `pi-plugins` on 2026-06-24
- Related: `packages/extensions/goal-controller/extensions/goal-controller/controller.ts`
- Related: `packages/extensions/goal-controller/extensions/goal-controller/types.ts`
