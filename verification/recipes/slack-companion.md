---
kind: extension
covers: packages/extensions/slack-companion
---
# Slack companion

A plain-code watcher wakes a read-only, sandboxed fork of the session to answer people in the Slack
conversations the session takes part in, hands information to the session as their words, and
holds every change to the owner's work for the owner's approval.

## How a user reaches it

- `/slack on`, then any Slack message the session sends (by the tool itself, its deferred
  `mcp__<server>__<tool>` name, or through the `mcp` and `mcp__<server>` proxies) starts a watch; `/slack <link>` or the `slack_watch` tool attaches one.
- The line above the editor and the panel (`/slack`, `alt+s`) with approvals.
- `stop` typed in a watched conversation, `/slack stop`, `/slack off`.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-slack-companion`
Proves: in real Pi sessions with a scripted model and a fake Slack server writing the official
server's formats (both email variants): every send route starts and marks a watch, and main's own
messages go out whole; replies are answered once, in thread; forged format text cannot add,
reorder or re-author messages or move the checkpoint, at reads and when attaching; a failed
lookup never drops a message, passing read failures retry and lasting ones stop the watch; reads
survive pages, truncation, failures and restarts (property test); the helper loads no extension,
has only its allowlisted tools (main's active read-only MCP tools), reaches the model with main's
credential, stops when stopped and at its turn limit; its file tools refuse secret paths in every
spelling Pi accepts (checked against Pi's own resolver); the sandboxed shell cannot write outside
scratch, read secrets, see credential variables or reach the network, and the real wiring builds
that policy; Slack text and display names cannot carry the package's markers; triage verdicts and
model choice; hand-offs, approvals (which outlive their watch), held replies, limits, stopping,
locks and routing between two sessions, resume catch-up, a reload during a helper run, the poll
timer, bounded state that idle reads do not grow, the line and panel at every width and height,
helper records and cost records.
Line: 4.5 s on darwin-arm64-12cpu

### types
Run: `npm run typecheck --workspace @doodledood/pi-slack-companion`
Proves: the package compiles with no type error.
Line: 3.4 s on darwin-arm64-12cpu

## Gotchas

- The sandbox scenarios skip, with the reason printed, where sandbox-runtime cannot run (they need
  macOS Seatbelt, or bubblewrap, socat and ripgrep on Linux).
- The fixtures in `format.test.ts` are scrubbed captures of the real server's output. When the
  server's format changes, `slack-companion-live` fails; its evidence holds
  `scrubbedThreadListing`, the server's raw thread listing with the person's name, ids and emails
  replaced by the fixtures' invented ones, to refresh them from.
