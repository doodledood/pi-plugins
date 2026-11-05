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
Proves: the package works as its README says, in real Pi sessions with a scripted model and a fake Slack server writing the official server's formats (both email variants):
- Starting and sending: every send route starts and marks a watch; main's own messages go out
  whole; replies are answered once, in thread.
- Reading: text imitating the format, in any message or in a thread's first message, cannot
  add, re-author or pull in a message, move the checkpoint, set the attach boundary or stop a
  watch; a failed lookup never drops a message; passing failures retry and lasting ones stop the
  watch (an expired login says how to sign in); reads survive pages, truncation, failures and
  restarts (property test).
- The helper: it loads no extension (no factory runs), has only its allowlisted tools (every
  read-only MCP tool, main's active ones shown directly, the owner's own Slack and the private
  servers only when he lists them as server/tool, never the send tool), reaches the model with
  main's credential, stops when stopped and at its turn limit; its file tools and its sandboxed
  shell (macOS) read the project, the opened folders and, for the file tools, the offered skills,
  and refuse the rest of the home and every secret in every path form and through symlinks; on
  Linux it has no shell and is told so once; the real wiring builds that policy.
- Triage, hand-offs, approvals (read to the end before approving; they outlive their watch),
  held replies, limits and their daily reset, stopping, locks and routing between sessions,
  resume catch-up, crash and reload safety, bounded state, the line and panel at every size, and
  helper and cost records.
Line: 8.4 s on darwin-arm64-12cpu; raised: round 9 added real-Seatbelt scenarios (closed home and temp folder, scratch-only writes, a project that is a secret folder, git in a linked worktree) and real-wiring checks of skills and saved results, each starts a real sandbox or helper

### types
Run: `npm run typecheck --workspace @doodledood/pi-slack-companion`
Proves: the package compiles with no type error.
Line: 3.4 s on darwin-arm64-12cpu

## Gotchas

- The real shell scenarios need macOS Seatbelt. On Linux the helper has no shell by decision
  (docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md), and those scenarios check
  exactly that instead; they skip, with the reason printed, only where sandbox-runtime does not
  support the platform.
- The fixtures in `format.test.ts` keep the real server's layout byte for byte, with every value invented. When the
  server's format changes, `slack-companion-live` fails; its evidence holds
  `scrubbedThreadListing`, the server's raw thread listing with the person's name, ids and emails
  replaced by the fixtures' invented ones, to refresh them from.
