# ADR: Only a main session orchestrates; a started session knows it was started

## Status
Accepted

## Area
parallel-sessions

## Decided by
The user ruled that only the main session is the orchestrator; an agent chose how the bridge enforces it and what a started session is told. The owner did not review this record's text.

## Context
The orchestrator role (20261101-derive-the-orchestrator-role-from-started-sessions) is derived from the sessions a session started. A started session also loads the bridge, so it had `start_agent_session` and could start sessions of its own, becoming an orchestrator under another orchestrator. It also had no idea it was started: it took its first prompt as if the person had typed it, and could end a turn with "done, see above" although its orchestrator reads only the end of its screen.

The bridge starts every such session itself, through `herdr agent start`, which passes arguments after `--` to Pi's command line. Pi lets an extension register a command-line flag; Pi reapplies the parsed flags to every runtime in the process, so a flag survives `/reload`, `/new` and `/resume`, and it refuses a command line with a flag no extension registered.

## Decision
- `start_agent_session` launches each session with `--herdr-orchestrator <pane>`, the starter's Herdr pane.
- The bridge registers that flag wherever it loads. A session that has it is a started session: the bridge registers no `start_agent_session` there and follows nothing, so it can never orchestrate. Its dialogs still show as blocked in Herdr.
- A started session's system prompt carries a `herdr_started_session` section: an orchestrator in that pane started it and coordinates its work, the person may also type to it, it ends each turn with a self-contained report, it asks decisions as questions with options, and it leaves starting sessions to the orchestrator.
- A session without the flag is a main session and may orchestrate as before.

## Alternatives Considered
- **An environment variable on the started session's tab**: Herdr already passes tab environment through, but the variable outlives the Pi it was meant for; a Pi the person later starts by hand in that tab would wrongly count as started. Checking that the orchestrator's pane is still alive narrows that but does not close it.
- **Telling the started session in its first prompt**: costs nothing in code, but the model can lose it to compaction or ignore it, and it cannot remove the start tool.
- **Allowing nested orchestrators**: a started session could fan out work itself, but the owner wants one orchestrator, and a tree of sessions makes it unclear where a question should go.

## Consequences

### Positive
- Exactly one orchestrator per tree: the role cannot nest, by construction rather than by instruction.
- A started session reports in a form the orchestrator can read and relay.

### Negative
- Work that would benefit from a started session fanning out has to go back through the orchestrator.
- The flag shows in `pi --help` on every install of the bridge, including outside Herdr.
- A started session started by an older bridge (no flag) is treated as a main session.

## Enforced by
partly — `packages/extensions/herdr-bridge/extensions/herdr-bridge/index.test.ts` ("a session it starts is launched naming its orchestrator, and such a session gets no start tool and is told to report back") pins the flag on the start command, the missing tool and the section; the e2e recipe shows real Pi accepts the flag. Whether the model follows the section stays judgment.

## Revisit when
The owner wants a started session to start sessions of its own.

## Source
- Session: Pi session in pi-plugins, 2026-11-01, the owner's "only the main one is the orchestrator".
- Related: 20261101-derive-the-orchestrator-role-from-started-sessions, 20261028-host-pi-in-herdr-and-ship-a-bridge
