# ADR: On Linux, find the Slack helper shell's secret files once per helper run, within set bounds

## Status
Accepted

## Area
slack-companion

## Decided by
An agent, during an unattended build, after a review measured what the shell's name denial costs on Linux. The owner has not reviewed this decision or this record's text; the build report asks him to confirm it.

## Context
20261104-sandbox-the-slack-helpers-shell denies environment files and other secret names to the helper's shell. On macOS, sandbox-runtime gives Seatbelt the names as a pattern, which costs nothing per command. On Linux, bubblewrap can deny only paths, so sandbox-runtime walks the disk under each pattern's folder to find matches, and it does so again before every command. A review timed that walk on one large home folder at 215 s, and on `/opt/homebrew` at 26 s. That is per root, per command, with no time limit, and Pi's bash timeout does not cover it. A shell that needs minutes before each command does not serve investigations, and a stalled network mount could block Pi itself.

## Decision
- On Linux, the package finds the secret-named files itself, once when a helper starts. It walks the whole project and Pi's agent folder, and the home folder to 4 levels deep. It skips version control, installed packages, caches and toolchains. It gives the sandbox the files it found as literal paths, plus the named secret folders and the agent folder's own auth, MCP and token files.
- If the walk takes more than 3 seconds or finds more than 2000 files, the helper gets no shell, as when the sandbox cannot start.
- On Linux, outside those folders, only the named secret folders are closed to the shell. The helper's file tools still deny the secret names anywhere, on every platform. macOS keeps the any-depth patterns.

## Alternatives Considered
- **Keep the patterns, rooted at every top-level folder**: complete, but the cost above falls on every shell command; rejected.
- **Deny the home folder and the other top-level data folders whole, and let the project back in**: closes more, but it also hides tools installed under the home or `/opt` (for example a Node or Python version manager), so many shells would break; and it rests on an allow-inside-deny order that could not be tested here; rejected.
- **No shell on Linux**: rejected; the owner wants investigations, and the bounded walk keeps most of the protection.

## Consequences

### Positive
- On Linux a shell command costs no disk walk, and the start of a helper costs at most 3 seconds.

### Negative
- On Linux, a secret file deeper than 4 levels in the home folder, outside the project and the agent folder, or in another top-level folder such as `/srv`, is readable by the shell unless it sits in a named secret folder. The README states this.
- A file created after the helper started is not in the list for that run.
- A very large project or home folder leaves the helper without a shell on Linux.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/secrets.test.ts` ("the shell sandbox denies every secret folder, and secret file names at any depth from the root", "on Linux the secret files are found once, by a walk that skips installed packages and gives up loudly when slow") — pin that every Linux entry is a literal path, that the walk finds names in the project at any depth and in the home to its depth, skips installed packages, and reports an incomplete walk, which leaves the helper without a shell.

## Source
- Session: the unattended build of slack-companion (2026-11-04), review round 6 (operational readiness OR-1, code-bugs #4).
- Related: 20261104-sandbox-the-slack-helpers-shell
