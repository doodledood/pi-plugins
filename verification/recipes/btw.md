---
kind: extension
covers: packages/extensions/btw
---
# BTW side conversation

`/btw` opens a read-only child session forked from the main session in a right-hand overlay, so the user can ask questions while the main session keeps working; `send_to_main` relays back.

## How a user reaches it

- `/btw <question>`, and typing into the open overlay.
- The child's `send_to_main` tool, which steers the main session.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-btw`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-btw`
Proves: the package compiles with no type error.
