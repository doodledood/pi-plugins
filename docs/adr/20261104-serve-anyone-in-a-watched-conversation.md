# ADR: Serve anyone in a watched Slack conversation

## Status
Accepted

## Area
slack-companion

## Decided by
The user, over the recommended option of serving only the people the session addressed plus people the owner adds. The reason inferred and named to him, not confirmed: he trusts the people in his workspace and wants the helper useful to whoever is in the thread. The owner did not review this record's text.

## Context
The Slack helper reads with every read-only tool the owner has, so whoever it serves can use the owner's read access through it, including data-warehouse queries. In a channel thread that means everyone who can read the channel.

## Decision
Anyone who posts in a watched conversation can get answers and investigations from the helper, under the same rules as everyone else: their messages are requests, never instructions with the owner's authority, and actions still wait for the owner.

## Alternatives Considered
- **Only people the session addressed, plus people the owner adds**: keeps the owner's read access with people he chose; not chosen.

## Consequences

### Positive
- No setup per person; the helper is useful to whoever joins the thread.

### Negative
- When the session posts in a channel, anyone in that channel can use the helper with the owner's read access until the watch ends.

## Enforced by
none — this choice opens access rather than restricting it, so there is nothing for a check to hold; the restrictions that do hold are in 20261104-let-slack-input-only-narrow-what-sessions-may-do.

## Revisit when
The owner watches conversations whose readers include people outside his company, or a disclosure through the helper surprises him.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
- Related: 20261104-hold-slack-conversations-in-a-read-only-fork-of-main
