# ADR: Resume budget-limited goals into a fresh budget window

## Status
Accepted

## Area
goal-controller

## Context
`20260629-resume-completed-goals` keeps a resumed goal's usage counters and budgets as they were, as the audit trail of the earlier run. For a goal stopped *by* its budget that rule leaves `/goal_resume` useless: the counters already sit at the limit, so the resumed goal hits the budget again on its first turn and stops without doing any work. The only way forward was to clear the goal and start over, losing its checker history.

Budgets in goal-controller are a guard on one stretch of automatic continuation the user has authorized, not a lifetime spending cap: they default to unbounded, and the user can resume any stopped goal. Resuming is the user explicitly authorizing more work.

## Decision
Resuming a `budget_limited` goal, with `/goal_resume` or by editing it (`/goal_edit` also resumes), opens a fresh budget window measured from the resume point. The goal records where the window starts (`budgetWindowStart`: tokens, turns and elapsed seconds at the resume, with usage first brought up to date, since turns can run while the goal is stopped), and budget checks and the status line compare the budget against usage since that point. Lifetime counters (`tokensUsed`, `turnsUsed`, `timeUsedSeconds`) keep counting from the goal's start and stay the audit trail; the goal summary shows both once a window exists.

Resuming from any other status keeps the current window, so pausing and resuming a goal mid-budget does not grant a new budget.

This narrows `20260629-resume-completed-goals`: counters are still preserved, but budgets on a budget-limited resume apply to the new window rather than to lifetime usage.

## Alternatives Considered
- **Refuse the resume until the budget is raised**: keeps budgets as lifetime caps — rejected by the user: budgets are set from config defaults when a goal starts, and there is no command to raise one on an existing goal, so the goal could never continue.
- **Reset the lifetime counters on resume**: simplest — rejected because it destroys the audit trail the earlier ADR exists to keep.

## Consequences

### Positive
- `/goal_resume` on a budget-limited goal does what it says: the goal gets another full budget of work and can complete.
- Lifetime usage stays visible and accurate.

### Negative
- A budget no longer caps a goal's total spend across resumes; each resume authorizes up to one more budget.

## Enforced by
`packages/extensions/goal-controller/extensions/goal-controller/settle-timing.test.ts` ("resuming a budget-limited goal opens a fresh budget window and can complete") — pins the fresh window on resume.

## Source
- Session: formal bug hunt of pi-plugins, ruling recorded in the run's Manifest (ASM-5)
- Related: 20260629-resume-completed-goals
