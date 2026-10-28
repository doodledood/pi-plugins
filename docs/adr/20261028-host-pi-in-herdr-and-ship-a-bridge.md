# ADR: Host parallel Pi sessions in Herdr and ship a bridge, not a board

## Status
Accepted

## Area
parallel-sessions

## Decided by
An agent, under the owner's explicit delegation of the host choice ("dont really care"), within an assignment the owner set: keep ceremony low, let sessions be entered directly, and make `/orchestrate` work without setup. The owner chose the one-start-tool scope over five tools; the owner did not review this record's text.

## Context
The owner runs many Pi sessions at once and wants to see each one's live status, switch into any of them by keyboard or mouse, and have one orchestrator session that can start sessions, read them, answer their questions and steer them. The manifest-dev `/orchestrate` skill must work on the result without setup: it starts each run "by whatever means the host offers", relies on the host to report whether a session is alive, and checks in when a run ends or every ten minutes.

Three earlier attempts in this repo's history failed for this owner: a chat-hub orchestrator, the planned Mission Control layer, and the HQ extension (removed in `ec73fcb`). HQ fell short because work ran headless and could not be entered, because its doctrine, packets and graduation were heavy ceremony, and because sessions had no project identity.

Facts that shape the choice:
- Inside one Pi process, switching sessions aborts and disposes the session left behind (`dist/core/agent-session-runtime.js`, `teardownCurrent`), so several live sessions need several processes or a custom in-process host.
- Herdr, a terminal workspace manager for coding agents, already runs each session as a real Pi in a pane. It shows live agent states in a sidebar driven by keyboard and mouse, ships a Pi integration, and exposes a CLI to start, read, prompt, wait on and send keys to agents. Its agent skill drives that CLI well, but only loads when Herdr is named: asked for "2 sessions" without the word, a Pi session started subagents instead.
- Herdr's Pi integration reports `blocked` only on a `herdr:blocked` extension event. Pi's `ui_prompt_start`/`ui_prompt_end` are not mapped, so a session waiting at an ask dialog shows as working, and Herdr's refusal to type into a blocked agent never fires.
- A survey of the Pi community (pi.dev catalog and npm `pi-package` search) found no package that combines a live board, fast switching and a Pi-native orchestrator.

## Decision
Use Herdr as the host for parallel Pi sessions. pi-plugins ships one bridge package, `herdr-bridge`, and no board of its own. It adds three things:

- `start_agent_session`, one tool whose description names the capability in plain words — a separate interactive session the person can open — so a skill or a person asking for a new session reaches it; listing, reading, messaging and stopping stay with Herdr's own agent commands, which the tool's guidance points to.
- A status bridge that turns Pi's dialog events into Herdr's blocked state.
- Wake-ups: the starting session gets a follow-up message when a session it started finishes a turn, waits at a question (with the question, its options and the Herdr commands that answer it), stays working for ten minutes with no change, or exits.

The package never closes, types into or answers another session; those stay with the agent's judgment. Real Pi in every pane keeps every installed extension and renderer when the owner switches in, and Herdr already provides the board and the switching.

## Alternatives Considered
- **A board inside Pi** (as `@zhuxixi/pi-agent-board` does: background Pi processes on PTYs with an attachable board): keeps everything in one Pi TUI, but rebuilds what Herdr already does, and the closest package has no orchestrator tools. It remains the fallback host if Herdr does not suit the owner in use, behind the same start tool and wake-ups.
- **A browser or desktop dashboard** (as `@blackbelt-technology/pi-agent-dashboard`, which injects session-control MCP tools into every session): the strongest orchestration API in the community, but a web view cannot render Pi's custom terminal components, which the owner's dialog-driven sessions depend on, and it adds a server to run.
- **Adopt a coordination layer on Herdr** (`pi-straw-boss`: a main agent per tab, a tower per workspace, a work board): solves coordination with more structure than the owner wants after HQ's ceremony.
- **Use Herdr with only its agent skill**: needs no code, but the skill triggers only when Herdr is named, dialog waits still read as working, and nothing wakes the orchestrator when a run ends.
- **The package's own five tools** (start, list, read, send, stop): one place to test everything and cleaner reads than screen text, but duplicates what Herdr's agent skill already does well and costs context in every Herdr session.

## Consequences

### Positive
- Board, switching and session fidelity come from a maintained tool; the repo owns a small surface.
- `/orchestrate` gets a host that starts sessions the owner can open, reports liveness through Herdr and signals run endings and quiet runs.
- If Herdr disappoints, only the start tool's backend changes; wake-ups and the tool's contract can stay.

### Negative
- Parallel work depends on a third-party terminal app being installed and running.
- The status bridge couples to Herdr's `herdr:blocked` event name until Herdr's own Pi integration maps Pi's dialog events.
- A waiting question reaches the orchestrator as screen text, not structured data, because the package may only report through Herdr's state.
- Per-project memory and instructions are not provided; projects are only Herdr workspaces and each repository's own context files.

## Enforced by
partly — `packages/extensions/herdr-bridge/extensions/herdr-bridge/index.test.ts` ("a started session wakes its starter on each change, and the package closes and types nothing") and `start.test.ts` ("starting runs only the start sequence: no close, no keys, no other prompt") pin that the package runs only the start sequence and read-only Herdr queries; whether Herdr stays the right host is judgment.

## Revisit when
Herdr's own Pi integration maps Pi's `ui_prompt_start`/`ui_prompt_end` to blocked (read in `src/integration/assets/pi/herdr-agent-state.ts` on Herdr's main branch), which retires the status bridge; or the owner reports Herdr does not suit them in daily use.

## Source
- Session: figure-out on Pi "projects/bots", an orchestrator session and a session board (2026-10-28), log `~/.manifest-dev/logs/figure-out-log-20261028-081334.md`; executed under `~/.manifest-dev/manifests/manifest-20261028-093805.md`.
- Related: 20261022-steer-main-with-extension-sent-user-messages
