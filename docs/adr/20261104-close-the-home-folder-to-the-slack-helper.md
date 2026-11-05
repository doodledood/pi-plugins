# ADR: Close the owner's home folder to the Slack helper, except the project and folders he opens

## Status
Accepted

## Area
slack-companion

## Decided by
An agent, during an unattended build, from the owner's rulings that the helper gets "all read-only stuff" but "no secrets", after three review rounds each found credentials a list of known places missed. The owner has not reviewed this decision or this record's text; the build report asks him to confirm it.

## Context
20261104-sandbox-the-slack-helpers-shell denies "known secret locations" to the helper's file tools and shell, and 20261104-hold-slack-conversations-in-a-read-only-fork-of-main gives the helper read access for investigations. The denial was built as lists: secret folders and secret file names. Each review round found more credentials the lists missed, on the owner's own machine: Pi's MCP token store, agent-tool configs with API keys, then a Google client secret and refresh token under `~/.config/firebase`, firebase-tools tokens under `~/.config/configstore`, and an Anthropic login under `~/.config/anthropic/credentials`. Every tool keeps its credentials somewhere of its own, so a list is always one tool behind. The helper serves anyone who posts in a watched conversation, and its reply scan catches only credential shapes it knows, verbatim.

## Decision
- The home folder is closed to the helper's file tools and shell, except the project (the session's folder) and the folders the owner lists in `readableFolders`. The home itself, or a folder holding it, never opens it.
- Inside what is open, the secret folders and secret file names stay closed; a folder named like a secret closes what is in it, for the file tools as for the shell.
- The file tools may read the folders of the skills the helper is offered, which mostly live in Pi's agent folder; secret names stay closed there.
- The shell also reads the toolchains a command needs from the home folder: Pi's `bin`, git's settings, and common version managers. On macOS, Seatbelt keeps a deny that is more specific than the allow around it, so secrets inside an opened folder stay denied; a real-sandbox test proves it.
- Files outside the home folder keep their earlier rules.

## Alternatives Considered
- **Keep adding names and folders to the lists**: what three rounds did; rejected, because the class stays open by construction.
- **Close everything but the project, outside the home too**: stronger; rejected for now, because system paths hold the tools and libraries a shell needs, and credentials there are rare and usually readable only by root.
- **No file reach beyond the project, no `readableFolders`**: simpler; rejected, because the owner wants investigations, and other repositories are a common need he can now open one by one.

## Consequences

### Positive
- A credential in a place no list knows is closed, unless the owner opened its folder.
- The owner's documents and other projects are no longer readable by people in a watched conversation.

### Negative
- The helper cannot read other repositories or files in the home folder unless the owner lists them.
- A shell command that reads a toolchain the list does not name fails until the owner opens its folder.
- Running Pi in the home folder itself opens nothing in it.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/secrets.test.ts` ("the home folder is closed except the project and the folders the owner opens; secrets stay closed inside those"), `helper.test.ts` ("the real shell reads the project inside the home and the toolchains, and nothing else there; secrets in the project stay closed", "the helper can load the skills it is offered from Pi's agent folder, and nothing else there") and `wiring.test.ts` ("the real helper path builds its sandbox and file guards for the owner's home and configured domains") — pin the closed home, the openings, the secrets inside them and the production wiring.

## Revisit when
The owner reports a shell command failing on a toolchain the list does not name, read from the helper's tool errors in his session.

## Source
- Session: the unattended build of slack-companion (2026-11-04), review round 8 (the acceptance judge's gap A on INV-G5).
- Amends 20261104-sandbox-the-slack-helpers-shell (what the file tools and shell may read) and 20261104-hold-slack-conversations-in-a-read-only-fork-of-main (the helper's read reach).
