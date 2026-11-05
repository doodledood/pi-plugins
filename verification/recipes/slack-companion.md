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
  shell (macOS) read the project, the opened and repository folders and, for the file tools, the
  offered skills' folders and the files its own calls saved, and refuse the rest of the home, the
  temp and cache folders, `/Users/Shared`, a path a command prints, and every secret in every path
  form and through symlinks; git works from worktrees and submodules; the shell writes only to
  its scratch folder; on Linux it has no shell and is told so once; the real wiring builds that
  policy.
- Triage, hand-offs, approvals (read to the end before approving; they outlive their watch),
  held replies, limits and their daily reset, stopping, locks and routing between sessions,
  resume catch-up, crash and reload safety, bounded state, the line and panel at every size, and
  helper and cost records.
Line: 11.1 s on darwin-arm64-12cpu; raised: round 12 added real-Seatbelt and real-git scenarios (a forged saved-output line in a timed-out command, a submodule whose superproject holds the home, TMPDIR set elsewhere, ps that cannot run) and a runner that gives the tests their own temp folder, measured with base 3dcf48b at 9.1-9.3 s and this change at 11.0 s under the same machine load

### types
Run: `npm run typecheck --workspace @doodledood/pi-slack-companion`
Proves: the package compiles with no type error.
Line: 3.4 s on darwin-arm64-12cpu

## Gotchas

- `test/run.mjs` runs the tests with a temp folder of their own and removes it afterwards; run a
  single file the same way from `packages/extensions/slack-companion`
  (`node test/run.mjs extensions/slack-companion/<file>.test.ts`), or
  with `npx tsx --test` when its leftovers do not matter.

- The real shell scenarios need macOS Seatbelt. On Linux the helper has no shell by decision
  (docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md), and those scenarios check
  exactly that instead; they skip, with the reason printed, only where sandbox-runtime does not
  support the platform.
- The fixtures in `format.test.ts` keep the real server's layout byte for byte, with every value invented. When the
  server's format changes, `slack-companion-live` fails; its evidence holds
  `scrubbedThreadListing`, the server's raw thread listing with the person's name, ids and emails
  replaced by the fixtures' invented ones, to refresh them from.
