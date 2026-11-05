# ADR: Run the Slack helper's shell in an OS sandbox with no network

## Status
Accepted; amended by 20261104-give-the-slack-helper-no-shell-on-linux-for-now (on Linux, the helper has no shell) and 20261104-close-the-home-folder-to-the-slack-helper (the home folder is closed except the project and opened folders)

## Area
slack-companion

## Decided by
An agent, from the owner's rulings that the helper reads everything read-only and launches investigations while nothing it does may change his work. The owner saw it in the read and did not object. The owner did not review this record's text.

## Context
Investigations need a shell for searching, history and local analysis, but a shell can write files and reach the network, so withholding the edit and write tools alone would leave the owner's work exposed. Pi has no built-in sandbox; its built-in tools accept pluggable operations. Anthropic's open-source sandbox-runtime confines a whole process tree at the OS level (Seatbelt profiles on macOS, bubblewrap with a network namespace on Linux) and lets network traffic out only through host proxies that allow listed domains.

## Decision
- The helper's shell runs every command through sandbox-runtime, allowed to write only to a scratch folder and with no network by default. The owner may allow domains, knowing that an allowed domain can also receive writes.
- Reads of known secret locations (SSH and cloud credentials, environment files, auth and token stores) are denied to the helper's file tools and shell.
- Remote reads go through read-only tools instead of the shell.
- If the sandbox cannot start, the helper runs without a shell rather than with an unconfined one.

## Alternatives Considered
- **No shell for the helper**: simplest; rejected because the owner wants it to launch investigations.
- **A deny-list of dangerous commands**: rejected; it misses indirect paths, as 20261104-hold-slack-conversations-in-a-read-only-fork-of-main records.
- **A scratch git worktree instead of a sandbox**: protects the working tree but not the network or other files; rejected.
- **A container or micro-VM**: strongest; rejected as heavier than a per-command sandbox for a short-lived helper.

## Consequences

### Positive
- "The helper cannot change my work" holds for its shell, not only for its tools.

### Negative
- A new dependency, with platform prerequisites on Linux (bubblewrap, socat, ripgrep).
- Investigations that need the network from the shell, such as a CLI that calls a remote service, are unavailable unless the owner allows the domain.
- Not yet tested on the owner's machine.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/helper.test.ts` ("the sandboxed shell writes only to scratch, reads no secrets and reaches no network", "every file tool is denied secret locations, in every spelling Pi's tools accept", "a sandbox that cannot start leaves the helper without a shell") and `path-parity.test.ts` ("resolveToolPath matches Pi's own resolver on every rule") — pin the shell's confinement, the secret denials in every path spelling and the no-shell fallback; on Linux the shell scenario checks that there is no shell, and it skips, with its reason, only on a platform sandbox-runtime does not support.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
- Related: 20261104-hold-slack-conversations-in-a-read-only-fork-of-main
