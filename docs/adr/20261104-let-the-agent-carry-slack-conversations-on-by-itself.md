# ADR: Let the agent carry Slack conversations on by itself, speaking only when addressed or useful

## Status
Accepted

## Area
slack-companion

## Decided by
The user ruled: replies go out directly, without drafts, marked as the owner's agent; the agent keeps going until it has what it needs or reaches a decision only the owner can make; it must not spam, it answers only when addressed or when it has something valuable to add, and it conserves tokens. An agent chose the filter and the limits from those rulings; the owner saw the limits in the read and did not object. The owner did not review this record's text.

## Context
The owner wanted to stop being both the doorbell and the send button for conversations his sessions have on Slack. Messages sent through his Slack MCP appear as him, so every needless message costs a colleague's attention under his name, and in shared threads people mostly talk to each other, not to the agent. Each Slack helper costs a turn over the main session's full context.

## Decision
- New messages pass three stages. Code drops the agent's own posts, reactions and duplicates and handles "stop". A cheap one-shot call to a small model then decides, with whether the agent was addressed as an input, whether the batch needs a reply or the agent has something valuable to add. Only then is a helper forked, and it may still stay silent. Messages it stays silent on remain context for the next helper.
- A burst of messages becomes one wake-up and at most one reply, with corrections folded into it. In channels the agent replies only in its own thread.
- Every message is marked as the owner's agent, and the first message in a conversation says so plainly.
- After a few messages to one conversation without the owner's input (5 by default), the agent pauses and asks the owner; this also keeps two agents from talking to each other indefinitely.
- A watch ends when the helper is done, on "stop", after a quiet period (24 hours by default) or when the session closes; resuming the session catches up on what arrived meanwhile.

## Alternatives Considered
- **The owner presses send on prepared replies**: rejected; it keeps the owner as the send button.
- **Only notify the owner**: rejected; it changes the least and helps the least.
- **Fork a helper for every message**: simplest; rejected because it spends a main-sized turn on every line of chat.
- **Rules only, with no model check**: cheapest; rejected because rules cannot tell when the agent has something valuable to add without being addressed.
- **No limit on autonomous exchanges**: rejected from the owner's "don't spam".

## Consequences

### Positive
- The owner is no longer the doorbell or the send button.
- Chat that does not concern the agent costs a small-model call, not a main-sized turn.

### Negative
- The small model can misjudge: a message that needed an answer may get none, and the reverse.
- The pause can stop a conversation that would have finished on its own.

## Enforced by
not yet — the package's tests that pin: the agent's own posts, reactions and "stop" never wake a model; one reply per batch; the pause after the configured number of sends.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
- Related: 20261104-hold-slack-conversations-in-a-read-only-fork-of-main, 20261104-start-watching-when-the-session-messages-someone
