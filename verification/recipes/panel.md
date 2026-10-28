---
kind: extension
covers: packages/extensions/panel
---
# Panel

`/panel <question>` sends the question to several models in parallel over a fork of the conversation, then gives their answers to the main model before it replies.

## How a user reaches it

- `/panel <question>`, with its lineup picker.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-panel`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-panel`
Proves: the package compiles with no type error.
