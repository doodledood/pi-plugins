# ADR: Watch Slack by polling from code through the MCP adapter, behind a swappable backend

## Status
Accepted

## Area
slack-companion

## Decided by
The user ruled the constraints: no webhooks and no Slack bot; a deterministic read loop that runs until stopped and spends no model tokens; and tool names that are configurable, with the owner's as defaults, so the package works in other setups. An agent chose the mechanism. The owner did not review this record's text.

## Context
A local Pi session has no public endpoint for Slack's Events API, and creating a Slack app for Socket Mode means a second identity and, in many workspaces, an admin approval. The owner reaches Slack through an MCP server (Slack's official server, behind a company gateway) used through pi-mcp-adapter.

Pi lets extension code call another tool only inside a tool's own execution, and Pi's built-in MCP support exposes no way for code to call its tools. pi-mcp-adapter documents a runtime tool-call event, `pi-mcp-adapter:runtime-tool-call:v1`, for exactly this. Slack applies its Web API limits to MCP calls: thread and history reads allow 50 or more calls a minute, while search is limited per user and is unsuitable for polling. The official server returns messages as formatted text, not JSON; its detailed format carries each message's id and author, and every message sent through it ends with a "Sent using" footer naming the app.

## Decision
- A plain-code loop reads each watched conversation about once a minute and does nothing else; a model is involved only when a new message needs handling.
- Slack is reached through one small backend interface: read new messages since a completed checkpoint, send a message, identify the owner. The first backend calls MCP tools through pi-mcp-adapter's runtime event, with tool names configurable and defaulting to the official Slack MCP server's names; each server's output format gets its own parser, starting with the official one. A backend that calls Slack's Web API with a token can be added for setups without the adapter.
- Reading fails loudly: an unreadable result stops the watch and tells the owner, a failed read never counts as an empty one, and the checkpoint never moves past unread messages.

## Alternatives Considered
- **Socket Mode with an owner-created Slack app**: real events without a public endpoint; rejected for now because it needs a second identity and an app install that admins may have to approve.
- **Webhooks**: need a public endpoint; rejected.
- **Let the model poll**: works with any tool host; rejected because every poll would spend a model turn.
- **Only a Web API token backend**: structured JSON that parses robustly; kept as an optional backend, since MCP-only setups expose no token.

## Consequences

### Positive
- Watching costs no model tokens, and the package needs no Slack app.
- Other setups work by configuring tool names, as long as they use pi-mcp-adapter and a server that has a parser.

### Negative
- Parsing formatted text is brittle: a change in the server's format stops watching until the parser is updated, and whether message text that imitates the format is escaped is not yet known.
- Setups on Pi's built-in MCP need the token backend.
- A read a minute per watch shows in the workspace's MCP audit logs.

## Enforced by
not yet — parser tests on captured server output, including message text that imitates the format; an integration test with a fake backend that pins the checkpoint never passing unread messages.

## Revisit when
Pi exposes code calls for its built-in MCP tools, or Slack's MCP server returns structured messages; read in Pi's extension documentation and in the server's tool results.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
- Related: 20261104-hold-slack-conversations-in-a-read-only-fork-of-main
