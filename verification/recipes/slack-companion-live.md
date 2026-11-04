---
kind: extension
covers: packages/extensions/slack-companion/extensions/slack-companion/live
ask-first: it posts two messages as the person, to their own Slack direct message, through their real Slack MCP server
---
# Slack companion against the real Slack server

Whether the package reads the person's real Slack MCP server correctly, including message text that
imitates the server's own format: the one check the fake server cannot make.

## How a user reaches it

- Every watch reads the real server through pi-mcp-adapter; this checks that path end to end.

## Scenarios

### probe
Run: `SLACK_COMPANION_LIVE=1 pi -p --no-session -e packages/extensions/slack-companion/extensions/slack-companion/live/probe.ts "slack-companion live probe"`
Proves: the owner is identified from their own profile; one top-level message and one thread
reply whose bodies imitate the format's headers, posted to the owner's own direct message only,
each read back as exactly one message with its true id, author and text, the imitation kept as
text. The evidence also holds the server's thread listing, scrubbed, for refreshing the fixtures.

## Gotchas

- Needs the person's Pi setup with pi-mcp-adapter and a working Slack MCP login; the probe exits
  before any model call, so it spends no model credit.
- It leaves two messages in the person's own direct message; delete them by hand if wanted.
