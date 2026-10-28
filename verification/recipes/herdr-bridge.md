---
kind: extension
covers: packages/extensions/herdr-bridge
---
# Herdr bridge

`start_agent_session` starts a separate interactive Pi session in its own Herdr tab; the starting
session gets wake-ups when it finishes, waits at a question, goes quiet or exits; any Pi waiting
at a dialog shows in Herdr as blocked.

## How a user reaches it

- Asking a Pi session in a Herdr pane for new sessions, or running `/orchestrate`, which calls
  `start_agent_session`.
- Wake-up messages arriving in the session that started the work.
- Herdr's sidebar, where a Pi at a dialog shows as blocked.

## Scenarios

### tests
Run: `npm run test --workspace @doodledood/pi-herdr-bridge`
Proves: the tracker, the start sequence, the gate and the wake-up cycle pass against a fake Herdr.

### types
Run: `npm run typecheck --workspace @doodledood/pi-herdr-bridge`
Proves: the package compiles with no type error.

### e2e
Run: `npm run e2e --workspace @doodledood/pi-herdr-bridge`
Proves: against the installed Herdr, in a session of its own with Pis on a scripted fake model,
a start lands a real Pi in the right folder and tab, dialog waits show blocked, every wake-up
arrives once and in order, wake-ups survive a reload and a resume, a waiting dialog is answered
through the wake-up's own steps, and a worker on the person's installed packages comes up.
Workload: varies

## Gotchas

- Needs `herdr` on PATH and Herdr able to start a named session; without it the run fails at
  setup rather than passing.
- The e2e removes its Herdr session and temporary agent directory on exit; an interrupted run can
  leave a `hbe2e-…` session behind (`herdr session list`, then `herdr session delete <name>`).
