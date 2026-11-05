# ADR: Close the owner's home folder to the Slack helper, except the project and folders he opens

## Status
Accepted

## Area
slack-companion

## Decided by
An agent, during an unattended build, from the owner's rulings that the helper gets "all read-only stuff" but "no secrets", after three review rounds each found credentials a list of known places missed. The owner has not reviewed this decision or this record's text; the build report asks him to confirm it.

## Context
20261104-sandbox-the-slack-helpers-shell denies "known secret locations" to the helper's file tools and shell, and 20261104-hold-slack-conversations-in-a-read-only-fork-of-main gives the helper read access for investigations. The denial was built as lists: secret folders and secret file names. Each review round found more credentials the lists missed, on the owner's own machine: Pi's MCP token store, agent-tool configs with API keys, then a Google client secret and refresh token under `~/.config/firebase`, firebase-tools tokens under `~/.config/configstore`, and an Anthropic login under `~/.config/anthropic/credentials`. Every tool keeps its credentials somewhere of its own, so a list is always one tool behind. The helper serves anyone who posts in a watched conversation, and its reply scan catches only credential shapes it knows, verbatim. The Manifest's ASM-4 records the owner's call that the helper gets all read-only reach, with "project files only" the alternative he did not take; this record moves most of the way toward that alternative for files, on the strength of his other call, "no secrets", and leaves him a lever (`readableFolders`) to open more.

## Decision
- **The file tools read from an allowlist.** A path is readable only when the spelling the disk gives back for it (symlinks resolved, the case as stored, the data-volume form folded) lies inside the project, a folder the owner lists in `readableFolders`, the repository's own folders, or the folder of a skill the helper is offered (a SKILL.md and what is beside it), or is a loose skill file or a file the helper's own call saved (as Pi or the adapter name it in the call's structured result, never as output text names it, and never inside a secret folder); and nothing in it is named like a secret, in any case. Everything else is closed, on every platform, so another spelling of a closed path (other case, `/System/Volumes/Data`, `/dev/fd`) is closed rather than missed. The secret folders stay closed inside an opened folder.
- **The shell (macOS) is closed to the home and the temp folders** (the user's own temp and cache folder, as the system names it whatever `TMPDIR` says; the shared `/private/tmp` and `/private/var/tmp`; and `/Users/Shared`). A system that does not name the per-user folder leaves the helper without a shell. It reads the project, the owner's readable folders, the repository's own folders when the project is a linked worktree, a subfolder, a submodule or a worktree of a bare repository, and the toolchains a command needs from the home folder (Pi's `bin`, git's settings, common version managers); the rest of the system stays readable. Seatbelt keeps a deny that is more specific than the allow around it, so secrets inside an opened folder stay denied; real-sandbox tests prove it. It writes only to its scratch folder, which is also its `TMPDIR`; sandbox-runtime's shared `/tmp/claude` is denied.
- **What opens**: never the home itself, a folder holding it, a secret folder or one inside it; such a project or listed folder opens nothing. A repository's folders open only when its top folder could open and is not one of the home's dot-folders (a dotfiles repository would hand over every committed file through git); its shared folder opens only when the repository that owns it (the main checkout, the superproject or the bare folder) passes the same test. A skill's folder opens only when it holds no secret folder and is not a folder directly in the home (`~/.agents`, or `~/Documents` through a linked SKILL.md); otherwise only its file.
- **One list for both guards**: the folders open to the file tools and to the shell come from one function, so the two cannot drift; the shell adds its toolchains, the file tools the skills and saved files.

## Alternatives Considered
- **Keep adding names and folders to the lists**: what three rounds did; rejected, because the class stays open by construction.
- **Close only the home's dot-folders and `~/Library`, leave ordinary folders open**: closer to ASM-4; rejected, because ordinary folders hold credentials too (downloaded keys, exported configs, private documents), and the lists of what to close would again be one tool behind.
- **A denylist over path text (closed folders and names, the rest open)**: what rounds 5 to 8 built; rejected, because every alias the disk accepts is a way around it, and every tool keeps credentials somewhere a list does not know.
- **Run the file tools inside the OS sandbox too**: one enforcement for both; not taken, because it needs a worker process per call and leaves Linux, where there is no sandbox, without file tools.
- **For the shell, close everything but the project, outside the home too**: stronger; rejected for now, because system paths hold the tools and libraries a shell needs. The temp and shared folders, where the owner's and other tools' data sits outside the home, are closed; mounted volumes are not, and are named under Negative.
- **No file reach beyond the project, no `readableFolders`**: simpler; rejected, because the owner wants investigations, and other repositories are a common need he can now open one by one.

## Consequences

### Positive
- A credential in a place no list knows is closed, unless the owner opened its folder.
- The owner's documents and other projects are no longer readable by people in a watched conversation.

### Negative
- The helper cannot read other repositories or files in the home folder unless the owner lists them; its file tools read no system files either.
- A file hard-linked into the project from a closed place is readable through that link: both guards judge paths, not file contents.
- The shell still reads other system folders and mounted volumes.
- The shell cannot run a skill's scripts: skill folders open to the file tools only.
- A SKILL.md that is a link opens the folder it leads to, so a skill linked from an ordinary folder outside the home's top level opens that folder.
- A shell command that reads a toolchain the list does not name fails until the owner opens its folder.
- Running Pi in the home folder itself opens nothing in it.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/secrets.test.ts` ("the file tools read only the project; secret names, symlinks out of it and the rest of the home are closed", "another spelling of a path is closed, not missed: case, the data volume, a secret name in capitals", "the folders that open the home: never the home, a folder holding it, a secret folder or one inside it", "exact files open: a loose skill file and a result the helper's own call saved, nothing beside them", "a submodule opens its repository folder only when its superproject could be opened", "a skill opens its own folder, never the home, a folder holding it or one holding a secret folder", "a repository opens its folders only when its top folder could be opened: never a dotfiles repository at ~ or in ~/.config", "a folder whose name begins like an open one is not inside it; a folder named like a secret closes its contents"), `helper.test.ts` ("before main's first prompt, the skills the loader offers can be loaded", "a result the helper's own call saved to a file can be read; other saved results cannot", "searches through the helper drop what it may not read: no secret file's lines or name come back", "the helper can load the skills it is offered from Pi's agent folder, and nothing else there"), `shell.test.ts` ("the real shell reads the project inside the home and the toolchains, and nothing else there; secrets in the project stay closed", "the real shell writes only to its scratch folder: not to sandbox-runtime's shared temp, and TMPDIR is the scratch folder", "the real shell opens nothing when the project is a secret folder, such as Pi's agent folder", "the real shell cannot read the user's caches or /Users/Shared", "with TMPDIR set elsewhere, the shell still closes the per-user temp and cache folder the system names (macOS)", "on macOS, a system that does not name the per-user folder leaves the helper without a shell, never with that folder open"), `shell-git.test.ts` ("git works in the real shell from a linked worktree, whose repository lies outside the project", "git works in the real shell from a submodule, whose repository lies in the superproject"), `shell-output.test.ts` ("the helper can read the full output of its own shell command that timed out, and a saved-output line the command prints opens nothing", "a command whose short output prints a saved-output line, then times out or is stopped, opens nothing (any platform)") and `wiring.test.ts` ("the real helper path builds its sandbox and file guards for the owner's home and configured domains") — pin the allowlist, the aliases, the openings (one list, `secrets.openedFolders`, for both guards), the shell's closed home, temp and shared folders, and the production wiring.

## Revisit when
The owner reports the helper failing to read something it needs (a toolchain the list does not name, a repository he expected open), read from the helper's tool errors in his session; or Pi's file tools gain a way to run inside the OS sandbox.

## Source
- Session: the unattended build of slack-companion (2026-11-04), review rounds 8 and 9 (the acceptance judge's gap A on INV-G5, then its path-alias and temp-folder findings).
- Amends 20261104-sandbox-the-slack-helpers-shell (what the file tools and shell may read) and 20261104-hold-slack-conversations-in-a-read-only-fork-of-main (the helper's read reach).
