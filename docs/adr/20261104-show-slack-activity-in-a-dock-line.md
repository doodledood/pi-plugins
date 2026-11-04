# ADR: Show Slack activity in one line above the editor with a panel on demand, not in main's transcript

## Status
Accepted

## Area
slack-companion

## Decided by
The user, choosing among three versions shown side by side in a throwaway mock. The owner did not review this record's text.

## Context
When the owner comes back to a session, he needs to see what the Slack helper did and what waits for his approval. 20261104-run-slack-helpers-in-memory assumed each exchange would appear in main's transcript as a display-only entry. A mock showed three versions of the same scenario: display-only rows in main's transcript, one line above the editor with a panel opened by a key, and a side pane like BTW's.

## Decision
- One line above the editor shows each watch's state and how many approvals wait for the owner, in the way the widget dock summarizes widgets.
- A key opens a panel with the watched conversations, what the helper did in each, and the pending approvals to approve or deny.
- Main's transcript shows only the owner's work and the hand-offs that reach main.

## Alternatives Considered
- **Display-only rows in main's transcript**: everything in one ordered place; rejected because Slack activity mixes into the owner's own work.
- **A side pane like BTW's**: the richest live view; rejected because it takes screen space whenever a conversation is watched.

## Consequences

### Positive
- Main's transcript stays about the owner's work; the line is quiet until something needs him.

### Negative
- Seeing what happened takes one key; it is not in the scrollback.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/ui.test.ts` ("at every width the line fits, keeps the waiting count, the stops and the key, and leads with what needs the owner", "the panel never exceeds its height, keeps its frame and keys, and shows a request's age at its usual width", "a request taller than the panel scrolls inside itself, and cannot be approved before its last line was shown") and `integration.test.ts` ("a helper exchange adds nothing to main's transcript; an info hand-off arrives as the sender's words and starts a turn") — pin the line, the panel and the clean transcript.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`; mock `~/.manifest-dev/drafts/slack-companion-mock/index.html`.
- Amends 20261104-run-slack-helpers-in-memory (where the owner sees each exchange).
