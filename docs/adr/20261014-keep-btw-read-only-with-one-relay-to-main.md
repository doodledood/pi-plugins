# ADR: Keep BTW read-only, with `send_to_main` as its one path into the main session

## Status
Accepted; amended by 20261022-steer-main-with-extension-sent-user-messages (relays steer main's current run instead of queuing as a follow-up)

## Context
BTW inherited the parent's full active tool set and was told only to "verify shared state before a conflicting write". In practice the side conversation is used to ask questions while the main session works, and an aside that edits the same workspace competes with main. Users also want a way to carry a conclusion reached in BTW back to main without retyping it.

## Decision
BTW is a read-only side conversation. Its system prompt sets the posture: answer, explain, investigate, leave files and outside systems as found, and point changes at the main session. The child does not inherit `edit`, `write`, or `goal`. Other inherited tools, such as `bash`, stay available for read-only inspection, so the posture is an instruction backed by the tool set, not a sandbox.

The child-only `send_to_main` tool is the single path by which BTW adds anything to the main session. It sends one user-attributed message, prefixed `[Relayed from my BTW side conversation]`, through `pi.sendUserMessage`. When main is busy the message is queued as a follow-up rather than steering the current run. The prompt limits its use to explicit user requests to tell, send, or relay something to main.

## Alternatives Considered
- **Keep the full tool set with a stronger prompt** — rejected: leaves the mutating file tools one model decision away in a pane meant for questions.
- **Sandbox the child (no `bash`, filesystem isolation)** — rejected for now: `bash` is the main read-only inspection tool (git, search, queries), and isolation is far heavier than the risk warrants.
- **Relay by steering main's current run** — rejected: an aside's verdict should not interrupt main mid-task; a follow-up preserves main's turn.
- **Inject the relay as a hidden custom message in main** — rejected: the user should see in main exactly what was sent on their behalf.

## Consequences

### Positive
- The aside cannot casually edit the workspace main is working in, and the boundary between "ask" and "do" is clear.
- Verdicts reach main in one step, visibly attributed.

### Negative
- Changes found in BTW need a relay and a main turn to land.
- A model can still mutate through `bash` against instructions.

## Source
- Session: BTW "nicer" work — "make it read-only, only answer questions" and the `send_to_main` nice-to-have.
- Related: 20261014-fork-btw-without-parent-extension-state
