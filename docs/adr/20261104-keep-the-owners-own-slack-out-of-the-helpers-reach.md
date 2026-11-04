# ADR: Keep the owner's own Slack out of the Slack helper's reach unless he lists its tools

## Status
Accepted

## Area
slack-companion

## Decided by
An agent, during an unattended build, from the owner's ruling that the helper gets "all read-only stuff" but "no secrets", after a review pointed out what all read-only reach includes. The owner has not reviewed this decision or this record's text; the build report asks him to confirm it.

## Context
20261104-hold-slack-conversations-in-a-read-only-fork-of-main gives the helper every MCP tool its server marks read-only. The owner's Slack MCP server marks its search and read tools read-only: searching public and private channels, reading any channel or thread, reading his direct messages. The helper serves anyone who posts in a watched conversation (20261104-serve-anyone-in-a-watched-conversation). So a channel member could ask the helper to look up and quote the owner's private conversations with other people. The owner's other conversations are his, much as his credentials are.

## Decision
- The helper does not get the tools of the MCP server that serves the configured Slack tools (the configured `server`, else every server listing one of them), even when they are marked read-only.
- The owner can give it any of them by listing it by name in `investigativeTools` (`tool` or `server/tool`).
- The send tool is never reachable, listed or not.

## Alternatives Considered
- **All read-only reach, Slack included**: what the earlier record says; rejected because it lets anyone in a watched conversation read the owner's private Slack through the helper.
- **Only the watched conversation's own thread readable**: closer to need; rejected for now because the helper already receives the conversation, and a per-conversation filter on a generic tool is fragile.

## Consequences

### Positive
- People in a watched conversation cannot reach the owner's other Slack conversations through the helper.

### Negative
- The helper cannot look up a Slack link someone pastes, unless the owner lists the read tools.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/mcp-tools.test.ts` ("the owner's own Slack server is private: its tools are reachable only when he lists them") and `wiring.test.ts` ("the real helper gets read-only tools and the owner's listed ones; never the send tool, nor his own Slack unless listed") — pin the exclusion, the opt-in by name, and the production wiring.

## Source
- Session: the unattended build of slack-companion (2026-11-04), review round 4; execution log `~/.manifest-dev/logs/do-manifest-20261104-191921-e6fcc51c.md`.
- Amends 20261104-hold-slack-conversations-in-a-read-only-fork-of-main (which MCP tools the helper reaches).
