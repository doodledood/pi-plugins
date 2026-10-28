---
kind: extension
covers: packages/extensions/cache-optimization
---
# Cache optimization

Keeps Anthropic prompt caches warm and intact: the cache keeper stamps a spare breakpoint, the TTL keepalive re-reads a large prefix during long waits, and `/cache` explains cache breaks.

## How a user reaches it

- `/cache` for the per-turn report.
- Automatic: the keeper and keepalive act on every eligible provider request.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-cache-optimization`
Proves: the package's own tests pass.

### types
Run: `npm run typecheck --workspace @doodledood/pi-cache-optimization`
Proves: the package compiles with no type error.
