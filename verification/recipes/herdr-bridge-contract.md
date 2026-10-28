---
kind: extension
covers: packages/extensions/herdr-bridge
ask-first: each run drives a real model on the person's configured default, which spends credit
---
# Herdr bridge with a real model

Whether a real model reaches for `start_agent_session` when asked for sessions, and only then: a
real orchestrator on the person's default model, with sessions it starts on the scripted fake.

## How a user reaches it

- `/orchestrate` launching a run, and plain requests such as "create 2 sessions in … that tell
  me a joke".

## Scenarios

### contract
Run: `npm run contract --workspace @doodledood/pi-herdr-bridge`
Proves: in three runs each, `/orchestrate`'s launch wording (read from the installed skill)
starts the run through the tool and the check-in reads Herdr; the joke request opens two Herdr
sessions and a routine question gets answered through Herdr; an explicit subagent request still
gets a subagent.
Workload: varies
Check: read

### once
Run: `npm run contract --workspace @doodledood/pi-herdr-bridge -- --runs 1`
Proves: the same three cases, one run each, for a cheaper re-check during repairs.
Workload: varies

## Gotchas

- Needs the default model's credential in the environment; it is never copied into the run.
- Spend is printed per run; it counts the orchestrator's session, not a subagent's own child
  session.
