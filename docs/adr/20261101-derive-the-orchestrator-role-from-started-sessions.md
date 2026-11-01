# ADR: Derive the orchestrator role from started sessions, with no command to set it

## Status
Accepted

## Area
parallel-sessions

## Decided by
An agent, under the owner's ruling that a session should be marked orchestrator automatically and by a command only if that could not be done; the agent judged it could. The owner did not review this record's text.

## Context
The owner runs one Pi session in Herdr that starts others through the Herdr bridge. Two failures showed up in use. The starting session sometimes started Pi sessions with Herdr's own commands instead of `start_agent_session`, and those never report back, so the two-way loop broke. And it did work that belonged to a session it had started, or answered the person's questions about that work from its own reading, instead of sending them to the session that owns the task.

The bridge already records, in the starting session's own entries, which sessions it started and whether each is still open. That set is the exact condition under which the session coordinates others. Pi's `before_agent_start` event lets an extension add a named system-prompt section for a run, and Pi sends a changed section as a transcript delta rather than a new prompt.

## Decision
The bridge derives the orchestrator role from the open started sessions, with no separate flag:

- While at least one session it started is open, each run of the starting session gets a `herdr_orchestrator` system-prompt section. The section names it their orchestrator, lists each session with its folder and the start of its first prompt, and says that work and questions on a session's task go to that session through `herdr agent prompt`, that the starting session does only work belonging to no session plus the coordination, and that it ends its turn while sessions work instead of polling.
- When the last one exits, the section goes away.
- The section depends only on which sessions are open and what they were started for, so it changes when one starts or exits, not on every wake-up.
- `start_agent_session`'s result says the same thing for the run that started the session, since the section only applies from the next run.
- The tool's guidance routes every new Pi session through `start_agent_session`, and says why: sessions started with Herdr's commands never report back.

## Alternatives Considered
- **A `/herdr-orchestrate` command that marks the session**: explicit, but it is a second source of truth beside the started-session set. A session that starts sessions without the command would lack the role, and one that keeps the mark after its sessions exit would wrongly route work nowhere. The owner wanted a command only if the role could not be derived.
- **A static rule in the tool's guidance**: costs no per-run code, but it sits in every Herdr session, including ones that never start a session, and it cannot list the sessions, which the model needs to tell which questions belong to which session.
- **Reminding the model in each wake-up**: reaches it only when a wake-up arrives, not when the person asks about a session's work between wake-ups, which is where the failure happened.

## Consequences

### Positive
- The role cannot drift from reality: it holds exactly while a started session is open.
- The person asks the starting session about any session's work and the question reaches the session that owns it.
- No command or setting to remember.

### Negative
- A dispatcher that routes every new request to a new session, before any session exists, is not provided; it would need its own mode if wanted.
- The section costs prompt tokens in every run while sessions are open, and its listing grows with the number of open sessions.
- Sessions recorded before this change carry no folder or task, so they are listed by name and pane only.

## Enforced by
partly — `packages/extensions/herdr-bridge/extensions/herdr-bridge/index.test.ts` ("while sessions it started are open, the session's prompt names it their orchestrator and lists them" and "the tool's guidance routes every new Pi session through it, since only those report back") pins that the section appears with the first started session, lists it, and disappears with the last; whether the model follows it is checked only by the paid contract runs and in use.

## Revisit when
The owner wants a session to dispatch new work to new sessions before any exist, or reports that the starting session still does its sessions' work with the section present.

## Source
- Session: Pi session in pi-plugins, 2026-11-01, the owner's request to fix the Herdr bridge's start guidance and make the starting session act as orchestrator.
- Related: 20261028-host-pi-in-herdr-and-ship-a-bridge, 20261101-only-a-main-session-orchestrates
