---
kind: extension
covers: packages/extensions/tool-activity-renderer
---
# Tool activity renderer

Draws built-in file and shell tools as Graphite rows, drives the working line, and draws narration and thinking in the quieter tone.

## How a user reaches it

- Always on, in every transcript.
- `/tool-render`.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-tool-activity-renderer`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-tool-activity-renderer`
Proves: the package compiles with no type error.
