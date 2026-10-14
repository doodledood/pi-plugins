# ADR: Fork BTW without the parent's extension state

## Status
Accepted

## Context
BTW seeds its child session from a copy of the parent's branch entries. That copy included Pi `custom` entries: extension-private state that never reaches the model. Child extensions load in the same process and restore their state from the session on `session_start`, so the child inherited whatever the parent's extensions had stored. With goal-controller that meant a parent's active goal resumed inside the aside and fired continuation turns there, while the user only wanted to ask a question.

## Decision
The child session file is written from the parent's entries with every `custom` entry dropped. The remaining path is re-chained the way Pi's `createBranchedSession` re-chains around dropped labels, and a compaction whose first kept entry was dropped keeps from the next retained entry instead. Model-visible entries — messages, `custom_message` context, compactions, branch summaries, model and thinking changes — are all kept, so the child's model context matches the parent's. The parent session and its goal are untouched.

## Alternatives Considered
- **Drop only goal-controller's entry types** — rejected: it names one extension's internals in BTW and leaves every other stateful extension resuming its work in the aside; the general rule is that extension state belongs to the session that created it.
- **Tell goal-controller to stand down in child sessions (a flag or env var)** — rejected: needs a cross-extension protocol for each stateful extension, and still leaks every other extension's state.
- **Withhold the `goal` tool only** — insufficient on its own: the restored goal fires continuation turns without the tool being called; BTW withholds the tool as well, so a new goal cannot start in the aside.

## Consequences

### Positive
- An active main-session goal can no longer run inside BTW, and no other extension's stored state leaks into the aside.
- The child's model context is unchanged, as the fork test checks against Pi's own `buildSessionContext`.

### Negative
- Child extensions start with fresh state, so an extension whose state the user would have wanted in the aside does not carry over.

## Source
- Session: BTW "nicer" work — "any active goal must not fire in the side session".
- Related: 20261014-keep-btw-read-only-with-one-relay-to-main
