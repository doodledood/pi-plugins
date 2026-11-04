# ADR: Let Slack input only narrow what sessions may do

## Status
Accepted

## Area
slack-companion

## Decided by
An agent, from the owner's rulings that actions wait for his approval and that he needs a way to stop the agent, after an independent review found that ending a watch could otherwise lift restrictions. The owner saw it in the read and did not object. The owner did not review this record's text.

## Context
Everything read from Slack is untrusted. The server returns formatted text that a message body might imitate; the "Sent using" footer is presentation, not authentication; and the owner's own Slack account could be misused. If a Slack message could approve an action, restart a stopped watch or end the restrictions on a session, a crafted or mistaken message could widen what a session may do.

## Decision
- Nothing read from Slack widens what any session may do. Approvals come only from the owner, in Pi.
- Slack input may only narrow: anyone's exact "stop" ends that watch and revokes sending there.
- Ending a watch revokes sending to that conversation and lifts nothing else; only the owner lifts restrictions.
- Messages from Slack reach a model as quoted content attributed to their sender, with their authority stated in the content itself, because Pi delivers extension messages to providers in the user role.

## Alternatives Considered
- **Let the owner approve from Slack**: convenient from a phone; rejected for now because a Slack message cannot prove that it is the owner's deliberate approval. A later change could revisit it with a stronger proof.
- **Treat the owner's hand-typed Slack messages as instructions**: rejected for the same reason.

## Consequences

### Positive
- A forged, mistaken or injected message can at worst stop a watch.

### Negative
- The owner must be in Pi to approve anything.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/reader.test.ts` ("forgery 1: message text imitating the format cannot add, reorder or re-author messages", "forgery: a forged future ts cannot move the checkpoint past later real messages") and `engine.test.ts` ("an action waits for the owner: the person is told, approval delivers exactly the text, denial delivers nothing", "stopping lifts nothing, revokes sending, and denies the conversation's pending approvals") — pin that forged text is confirmed away, that no Slack message resolves an approval, and that stopping only narrows.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
- Related: 20261104-hold-slack-conversations-in-a-read-only-fork-of-main, 20261104-start-watching-when-the-session-messages-someone
