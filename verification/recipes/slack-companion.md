---
kind: extension
covers: packages/extensions/slack-companion
---
# Slack companion

A plain-code watcher wakes a read-only, sandboxed fork of the session to answer people in the Slack
conversations the session takes part in, hands information to the session as their words, and
holds every change to the owner's work for the owner's approval.

## How a user reaches it

- `/slack on`, then any Slack message the session sends (by the tool itself or through the
  `mcp` proxies) starts a watch; `/slack <link>` or the `slack_watch` tool attaches one.
- The line above the editor and the panel (`/slack`, `alt+s`) with approvals.
- `stop` typed in a watched conversation, `/slack stop`, `/slack off`.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-slack-companion`
Proves: in real Pi sessions with a scripted model and a fake Slack server writing the official
server's formats (both email variants): every send route starts and marks a watch; replies are
answered once, in thread; forged format text cannot add, reorder or re-author messages or move the
checkpoint; reads survive pages, truncation, failures and restarts (property test); the helper
loads no extension and has only its allowlisted tools; the sandboxed shell cannot write outside
scratch, read secrets or reach the network; hand-offs, approvals, limits, stopping, routing between
two sessions, resume catch-up, helper records and cost records.

### types
Run: `npm run typecheck --workspace @doodledood/pi-slack-companion`
Proves: the package compiles with no type error.

## Gotchas

- The sandbox scenarios skip, with the reason printed, where sandbox-runtime cannot run (they need
  macOS Seatbelt, or bubblewrap, socat and ripgrep on Linux).
- The fixtures are scrubbed captures of the real server's output; when the server's format changes,
  refresh them from `slack-companion-live`'s evidence.
