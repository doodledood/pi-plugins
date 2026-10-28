---
kind: extension
covers: packages/extensions/advisor-consult
---
# Advisor consult

The model asks an independent, higher-capability advisor for a second read on risky or uncertain work; the advisor runs as its own Pi subprocess and returns advice, never actions.

## How a user reaches it

- The `advisor_consult` tool, which the model calls on its own judgment.
- Its invocation details, shown in the tool row when expanded.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-advisor-consult`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-advisor-consult`
Proves: the package compiles with no type error.

### smoke
Run: `npm run smoke --workspace @doodledood/pi-advisor-consult`
Proves: a consult call returns the advisor's answer through the real consult path, with a stand-in runner instead of a model.
