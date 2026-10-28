---
kind: extension
covers: packages/extensions/mcp-tool-loadout
---
# MCP tool loadout

Keeps MCP tools out of context until used: a compact catalog in the prompt, a budgeted set of active schemas, and `load_tools` to load dormant schemas without breaking the prompt cache.

## How a user reaches it

- The `load_tools` tool.
- The MCP tool catalog section of the system prompt.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-mcp-tool-loadout`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-mcp-tool-loadout`
Proves: the package compiles with no type error.
