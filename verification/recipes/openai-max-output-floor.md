---
kind: extension
covers: packages/extensions/openai-max-output-floor
---
# OpenAI max-output floor

Raises `max_output_tokens` on OpenAI Responses requests to the provider minimum, so a near-full context does not produce a 400.

## How a user reaches it

- Automatic, on every OpenAI Responses request.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-openai-max-output-floor`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-openai-max-output-floor`
Proves: the package compiles with no type error.
