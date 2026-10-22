# ADR: Steer main with user messages that extensions send on the user's behalf

## Status
Accepted

## Context
BTW's `send_to_main` relay and the goal controller's goal prompts (the kickoff from `/goal`, `/goal_resume`, or the `goal` tool, and checker continuations) reach the main session through `pi.sendUserMessage`. Both passed `deliverAs: "followUp"` when main was busy, so Pi held the message until the whole run ended. In use that was the wrong trade: a relayed verdict or a newly started goal is direction the user wants main to act on now, and waiting for a long run to finish meant main kept working on stale direction. The goal controller also branched on `ctx.isIdle()` and omitted `deliverAs` when idle, which races a prompt still in Pi's preflight; BTW had already avoided that by always passing `deliverAs`.

## Decision
Extension-sent user messages on the user's behalf are delivered as steering: both extensions always pass `deliverAs: "steer"`. While main is running, Pi delivers the message after the current assistant turn's tool calls finish and before the next model call. When main is idle, Pi ignores `deliverAs` and starts a turn, so the option is passed unconditionally and no extension branches on idleness.

Checker continuations sent from `agent_before_settle` behave the same either way, since Pi continues the run when either queue holds a message; they steer too so every goal prompt follows one rule.

## Alternatives Considered
- **Keep follow-up delivery** — rejected: the message waits for the whole run, which is the behavior the user asked to remove.
- **Make the delivery mode configurable** — rejected: no case for follow-up delivery has come up, and an option nobody sets is code to maintain.
- **Steer only for BTW, keep follow-up for goals** — rejected: a goal kicked off mid-run is direction just as much as a relay is, and one rule is easier to predict.

## Consequences

### Positive
- Relays and new goals take effect at the next tool boundary instead of after the run.
- Removes the goal controller's idle-check race.

### Negative
- A relay or goal kickoff now redirects main mid-task, which the previous BTW record had avoided on purpose. A user who wants an aside to wait can type it into main with `Alt+Enter` instead.
- Steering still cannot reach the model between two calls in one tool batch; it lands after the batch.

## Source
- Session: user request — "when they send to main it uses the follow up … I want them to steer instead".
- Related: 20261014-keep-btw-read-only-with-one-relay-to-main (amended: relays steer instead of queuing as a follow-up)
- See also: `/hq`'s take-the-seat prompt and `/panel`'s injected question and answers adopt the same steering delivery in the change after this record; HQ's system nudge that new decisions arrived stays a follow-up because the user did not send it.
