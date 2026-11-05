# ADR: Keep the owner's own Slack and browser out of the Slack helper's reach unless he lists their tools

## Status
Accepted

## Area
slack-companion

## Decided by
An agent, during an unattended build, from the owner's ruling that the helper gets "all read-only stuff" but "no secrets", after reviews pointed out what all read-only reach includes (round 4 for his Slack, rounds 7 and 8 for his browser). The owner has not reviewed this decision or this record's text; the build report asks him to confirm it.

## Context
20261104-hold-slack-conversations-in-a-read-only-fork-of-main gives the helper every MCP tool its server marks read-only. The owner's Slack MCP server marks its search and read tools read-only: searching public and private channels, reading any channel or thread, reading his direct messages. The helper serves anyone who posts in a watched conversation (20261104-serve-anyone-in-a-watched-conversation). So a channel member could ask the helper to look up and quote the owner's private conversations with other people. The owner's other conversations are his, much as his credentials are. The same holds for a server that drives his live browser (chrome-devtools and the like): its read-only tools list network requests, console messages and page contents of a logged-in browser, which carry cookies, auth headers and private pages. A server that reads local files (the reference `filesystem` server) is the same case: its read-only tools read files outside the helper's file allowlist (20261104-close-the-home-folder-to-the-slack-helper).

## Decision
- The helper does not get the tools of the MCP server that serves the configured Slack tools (the configured `server`, else every server listing one of them), even when they are marked read-only.
- Nor does it get the tools of the servers in the `privateServers` setting, which always includes the servers that drive the owner's browser (`chrome-devtools`, `playwright`, `puppeteer`) and the reference file server (`filesystem`); the owner's own list is added to these. He can add any server that reaches his private data under another name.
- The owner can give it any read-only tool of a private server by listing it as `server/tool` in `investigativeTools`; a bare tool name never opens a private server's tool, so a name meant for another server cannot.
- A tool of that server that is not read-only (it posts or changes something) is never reachable, listed or not; neither is the configured send tool on any server.

## Alternatives Considered
- **All read-only reach, Slack included**: what the earlier record says; rejected because it lets anyone in a watched conversation read the owner's private Slack through the helper.
- **Only the watched conversation's own thread readable**: closer to need; rejected for now because the helper already receives the conversation, and a per-conversation filter on a generic tool is fragile.

## Consequences

### Positive
- People in a watched conversation cannot reach the owner's other Slack conversations, or his browser's state, through the helper.

### Negative
- The helper cannot look up a Slack link someone pastes, unless the owner lists the read tools.
- A gateway that serves Slack and other tools as one MCP server hides those other tools from the helper too, unless listed.
- A browser or file server under another name is not recognized until the owner adds it to `privateServers`; until then its read-only tools reach the helper, and a file server's reach past the file allowlist with them.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/mcp-tools.test.ts` ("the owner's own Slack server is private: its tools are reachable only when he lists them", "every server in the private list is closed to the helper unless a tool is listed") and `wiring.test.ts` ("the real helper gets read-only tools and the owner's listed ones; never the send tool, nor his own Slack unless listed", "a server that drives the owner's browser is private: its read-only tools reach no helper unless listed") — pin the exclusion, the opt-in by name, and the production wiring.

## Source
- Session: the unattended build of slack-companion (2026-11-04), review rounds 4, 7, 8 and 9; execution log `~/.manifest-dev/logs/do-manifest-20261104-191921-e6fcc51c.md`.
- Amends 20261104-hold-slack-conversations-in-a-read-only-fork-of-main (which MCP tools the helper reaches).
