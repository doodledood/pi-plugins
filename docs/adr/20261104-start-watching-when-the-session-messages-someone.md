# ADR: Start watching a Slack conversation when the session messages someone

## Status
Accepted

## Area
slack-companion

## Decided by
The user chose automatic starts and asked for a way to stop them. An agent chose the stop controls and the routing. The owner did not review this record's text.

## Context
Watching must begin without a step the owner has to remember, or the owner is the doorbell again. Conversations other people start, such as a bug report in a direct message, also need a way in. Several of the owner's sessions can talk to the same person in one direct message.

## Decision
- When the session sends a direct message or a thread reply, Pi watches that conversation from that message on; a top-level channel post watches its own thread.
- `/slack <link>`, or asking the session to handle a thread, watches a conversation someone else started; the helper receives the part nobody has answered yet.
- Stopping: anyone types exactly "stop" in the conversation; `/slack stop` ends every watch; `/slack` lists the watches and ends one; `/slack off` turns automatic starts off for the session. A stopped conversation is marked so that a queued send cannot start it again.
- Routing: a conversation the session starts lives in its own thread, at most one session owns a direct message's top level, and a message no session can place goes to the owner.

## Alternatives Considered
- **Watch only when the owner hooks a conversation up**: deliberate; rejected because forgetting brings the doorbell back.
- **Automatic for direct messages only, a command for channels**: fewer surprises in busy channels; not chosen.
- **Route top-level replies to the session that posted last**: needs no shared state; rejected because two sessions asking in one direct message would receive each other's answers.

## Consequences

### Positive
- The common case needs no setup.

### Negative
- A one-off post, such as an announcement, also starts a watch, until it goes quiet or is stopped.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/integration.test.ts` ("a send by the mcp route starts a watch, is marked, and a reply is answered in its thread", and the direct and mcp__slack routes) and `engine.test.ts` ("stop from anyone ends the watch without a model, and a later send does not restart it", "two sessions on one machine never answer each other's conversations; a dead holder's lock is reclaimed") — pin automatic starts on every send route, stopping, tombstones and routing.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
- Related: 20261104-let-the-agent-carry-slack-conversations-on-by-itself, 20261104-let-slack-input-only-narrow-what-sessions-may-do
