/**
 * Seed content for the doctrine files.
 *
 * These are materialization templates, not an update channel: once a doctrine
 * file exists, HQ never overwrites it, and re-seeding is a no-op. The user's
 * edits are authoritative.
 *
 * The Tastes / Doors / Escalation / Directives / Precedents sections carry over
 * the content of the user's own policy file from the previous generation of this
 * system (~/.pi/mission-control/policy.md), curated for HQ's model where
 * delegated sessions end at stops rather than being messaged in place.
 */

export const DOCTRINE_GLOBAL_SEED = `# HQ Doctrine — global

This file is the behavior surface for every project. HQ may rely on a rule only
when it can cite the line that decides the case. Edit it freely: nothing but your
own ratification adds to it, and HQ never rewrites it.

## Tastes

- Prefer the simplest durable solution that fixes the root cause and leaves the
  touched area easier to reason about.
- Preserve attention for choices where preference, risk, or irreversibility
  changes the answer.

## Doors

- Treat destructive actions, releases and deployments, publishing, production
  changes, and externally visible acts performed as the user as one-way doors
  unless the user has already authorized the exact action.
- Treat reversible local edits, tests, and investigation inside a worker's
  existing permission envelope as two-way doors.

## Escalation rules

- Escalate when a doctrine gap combines with a material preference, risk, doubt,
  irreversibility, conflict, or a required novel personal fact. Also escalate
  when evidence materially conflicts, or at a one-way door or other hard-to-
  reverse choice.
- Doctrine silence alone is not escalation. When a reversible gap blocks progress
  or needs judgment, escalate; otherwise ordinary reversible progress continues.
- A finished task is a decision too: closing work the user has not seen is
  escalated as a close packet rather than silently archived.

## Directives

- Add current directives here. Keep each one citable, and remove it when it no
  longer applies.

## Precedents

- Add only precedents you have approved. Record the decision rule, not the
  incidental details of the case that produced it.

## Meta

These numbers govern HQ itself. They are read from this file on every cycle, so
editing them is the whole configuration surface. Nothing else changes them.

- batch-max: 4
- batch-requires-same-project: true
- batch-trivial-only: true
- graduation-consecutive-agreements: 10
- graduation-min-days: 14
- audit-sample-rate: 0.2
- staleness-minutes: 30
`;

export const DOCTRINE_PROJECT_SEED = (project: string): string =>
  `# HQ Doctrine — ${project}

Rules here apply only to this project and take precedence over the global file
where both speak. HQ never rewrites this file.

## Directives

- Add project-specific directives here.

## Precedents

- Add approved project-specific precedents here.
`;

export const HQ_EXAMPLE_CONFIG = `{
  "titleModel": "anthropic/claude-fable-5",
  "maxConcurrentWorkers": 10,
  "stalenessMinutes": 30
}
`;
