# ADR: Hold Slack conversations in a read-only fork of the main session, with changes behind the owner's approval

## Status
Accepted

## Area
slack-companion

## Decided by
The user ruled the shape: a read-only helper forked from the main session holds the conversation and may read and investigate freely, while anything that changes the owner's work or cannot be undone waits for the owner's approval. An agent chose the mechanics below from those rulings. The owner did not review this record's text.

## Context
The owner's Pi sessions often need answers from colleagues on Slack, and the owner relays between them: he notices a reply and tells the session, and he tells the session when to send. In one recorded session that meant three such relays and about seven send approvals over four hours, with replies arriving 7 to 54 minutes apart. The session already had the context and the Slack tools; it had no way to notice replies, and letting other people reach it raised the question of what their messages may make it do. This addresses the North Star's second hypothesis of what is in the way: friction the owner meets in daily agent work.

The first design delivered colleagues' messages to the main session itself, behind a deny-list gate on irreversible steps. An independent review showed that a gate inside one session is a seatbelt, not a boundary: the session can reach an irreversible effect indirectly, for example by editing a script and then running the tests that execute it, and tool annotations are unverified hints. The owner then chose a real boundary.

## Decision
- For each batch of new messages in a watched conversation, Pi forks the main session, as it is at that moment, into a **Slack helper**: a separate session that knows what the main session knows and holds the conversation.
- The helper may read and investigate on its own: every read-only tool, file reads outside secret locations, and a shell confined by an OS sandbox (20261104-sandbox-the-slack-helpers-shell). It has no edit or write tool and cannot call the main session's tools.
- The helper hands off to main in two ways. Information the main session asked for, such as answers to its questions, reaches main as data attributed to its sender. A request for an action that would change the owner's work (edits, commits, pushes), or that cannot be undone or is dangerous (deletes, merges, deploys, database writes, posts outside the conversation), becomes a pending approval; it reaches main only after the owner approves it in Pi, and main carries it out.
- Pending approvals never block: nothing freezes while the owner is away, and the helper tells the person that it is waiting on the owner.

## Alternatives Considered
- **Deliver messages to the main session behind a deny-list gate**: one session with full capability; rejected because the gate can be bypassed indirectly, so "they cannot change my work" would not be true.
- **Treat named colleagues like the owner**: fastest; rejected because they would act with the owner's access.
- **One long-lived helper per conversation that pulls updates from main**, as BTW does: fewer forks; kept as the fallback if a fork per batch costs too much, since a long-lived helper works from an older picture of main.
- **Prepare replies for the owner to send**: rejected; the owner wants to stop being the send button.

## Consequences

### Positive
- Nothing a Slack participant writes reaches a session that can change the owner's work without the owner's approval.
- The main session's context stays free of Slack chatter; it receives only hand-offs.
- Each helper works from main's current state.

### Negative
- Each helper costs a turn over main's full context, and a hand-off costs a main turn as well.
- Requests for action wait for the owner, who stays in the loop for those.
- Replies can share what is in the session's context with the people in the conversation; only text shaped like a secret is blocked.

## Enforced by
partly — `packages/extensions/slack-companion/extensions/slack-companion/helper.test.ts` ("the helper's runtime: no extension, no handler, only the allowlisted tools, and those tools work") pins that the helper loads no extension, runs none of the parent's handlers and holds only its allowlisted tools; `engine.test.ts` ("an action waits for the owner: the person is told, approval delivers exactly the text, denial delivers nothing") pins that an action reaches main only after the owner approves it. Whether the helper sorts a request into `info` or `action` correctly stays the model's judgment, bounded by main's prompt that hand-offs authorize nothing.

## Revisit when
A fork per batch costs more than the owner accepts, read in the session-tree cost of a watched conversation.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
- Related: 20261104-let-slack-input-only-narrow-what-sessions-may-do, 20261104-sandbox-the-slack-helpers-shell, 20261104-run-slack-helpers-in-memory, 20261014-keep-btw-read-only-with-one-relay-to-main, 20261014-fork-btw-without-parent-extension-state
