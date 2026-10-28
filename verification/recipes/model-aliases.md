---
kind: extension
covers: packages/extensions/model-aliases
---
# Model aliases

Selector-visible aliases for provider models, each with its own visible operating window and a larger target window behind it.

## How a user reaches it

- The model selector and `--model`, where aliases appear.
- `model-aliases.json` in the agent directory.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-model-aliases`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-model-aliases`
Proves: the package compiles with no type error.
