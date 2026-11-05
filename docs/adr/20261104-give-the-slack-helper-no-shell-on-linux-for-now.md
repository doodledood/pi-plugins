# ADR: Give the Slack helper no shell on Linux until its secret denial is complete there

## Status
Accepted

## Area
slack-companion

## Decided by
An agent, during an unattended build, after reviews showed that the shell's secret denial on Linux was either too slow to use or incomplete, and that an agent's record cannot narrow the Manifest's invariant that the helper's shell reads no secret file. The owner has not reviewed this decision or this record's text; the build report asks him to confirm it.

## Context
20261104-sandbox-the-slack-helpers-shell denies environment files and other secret names to the helper's shell. On macOS, sandbox-runtime gives Seatbelt the names as patterns, which costs nothing per command. On Linux, bubblewrap can deny only paths, so sandbox-runtime walks the disk under each pattern's folder to find matches, and does so again before every command. A review timed that walk at 215 s for one large home folder and 26 s for `/opt/homebrew`, per command, with no time limit. A bounded walk once per helper run was tried next; it was fast enough, but it left secret files deeper in the home folder or in other top-level folders readable, which the invariant does not allow. Denying the home folder whole and letting the project back in would hide tools installed under the home or `/opt`, and no part of the Linux shell path has run on Linux: the owner works on macOS and the repository has no Linux CI.

## Decision
- On Linux, the helper gets no shell. It keeps its guarded file tools, which deny secret names anywhere on every platform, and its read-only MCP tools.
- The helper's start says why, once, as for any sandbox that cannot start.
- macOS keeps the sandboxed shell as 20261104-sandbox-the-slack-helpers-shell decides.

## Alternatives Considered
- **Keep the per-command patterns rooted at every top-level folder**: complete, but minutes per shell command; rejected.
- **Walk once per helper run, within bounds**: tried; incomplete outside the walked folders, and an agent may not trade the invariant away; rejected.
- **Deny the home folder and top-level data folders whole, and let the project and toolchains back in with `allowRead`**: sandbox-runtime documents the pattern, and it may be the way back to a Linux shell; not taken now, because it needs per-machine toolchain lists and a Linux machine to prove it, which this build does not have.

## Consequences

### Positive
- The invariant holds on every platform with no Linux-only code path that has never run.
- No disk walk, on any platform.

### Negative
- Linux users' helpers cannot run shell investigations (git history, local analysis); they still read the project through the file tools.
- Bringing the shell back on Linux needs a design proven on Linux, and a new record.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/secrets.test.ts` ("on Linux the helper gets no shell, and says why; no sandbox starts") — pins that on Linux no sandbox is configured and the helper is told why.

## Source
- Session: the unattended build of slack-companion (2026-11-04), review rounds 6 and 7 (operational readiness, code-bugs, the acceptance judge on INV-G5).
- Related: 20261104-sandbox-the-slack-helpers-shell
