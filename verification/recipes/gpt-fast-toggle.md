---
kind: extension
covers: packages/extensions/gpt-fast-toggle
---
# GPT fast toggle

`/gpt-fast` switches OpenAI GPT requests to the priority service tier without changing the reasoning level.

## How a user reaches it

- `/gpt-fast`.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-gpt-fast-toggle`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-gpt-fast-toggle`
Proves: the package compiles with no type error.
