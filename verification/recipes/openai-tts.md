---
kind: extension
covers: packages/extensions/openai-tts
---
# OpenAI text to speech

Speaks text aloud on the local machine through OpenAI's Speech API when the user asks for audio.

## How a user reaches it

- The `openai_tts_speak` tool.
- `/openai-tts`.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-openai-tts`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-openai-tts`
Proves: the package compiles with no type error.
