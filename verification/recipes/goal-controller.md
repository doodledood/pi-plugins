---
kind: extension
covers: packages/extensions/goal-controller
---
# Goal controller

One long-running session goal whose completion only an independent checker can grant; the goal footer shows its state.

## How a user reaches it

- `/goal`, `/goal_edit`, `/goal_pause`, `/goal_resume`, `/goal_clear`.
- The model-callable `goal` tool, which starts a goal.
- The goal footer in the statusline.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-goal-controller`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-goal-controller`
Proves: the package compiles with no type error.

### smoke
Run: `npm run smoke --workspace @doodledood/pi-goal-controller`
Proves: a goal starts, refuses a second start while live, and completes on a stand-in checker verdict.
