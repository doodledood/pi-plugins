/**
 * Seed content for the doctrine files.
 *
 * These are materialization templates, not an update channel: once a doctrine
 * file exists, HQ never overwrites it, and re-seeding is a no-op. The user's
 * edits are authoritative.
 *
 * The Tastes / Doors / Escalation / Directives / Precedents sections carry over
 * the user's policy content from the previous generation of this system, curated
 * for HQ's model where delegated sessions end at stops rather than being
 * messaged in place.
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

- Send a packet when a doctrine gap combines with a material preference, risk,
  doubt, irreversibility, conflict, or a required novel personal fact. Also send
  one when evidence materially conflicts, or at a one-way door or any other
  hard-to-reverse choice.
- A delegated session working on its own may take a reversible, not-high-blast
  step that no rule decides, on its own judgment; if the step needs the user's
  preference, it stops and that stop becomes a packet.
- HQ may answer a stop without the user only by citing a rule that decides the
  case itself. This bullet, and any other bullet about when to escalate, is not
  such a rule: silence is permission for a session to proceed, never a line HQ
  can point at to answer for the user.
- A finished task is a decision too: work the user has not seen arrives as a
  close packet rather than being silently archived.

## Directives

- Add current directives here. Keep each one citable, and remove it when it no
  longer applies.

## Precedents

- Add only precedents you have approved. Record the decision rule, not the
  incidental details of the case that produced it.

## Meta

These numbers govern HQ itself. They are read from this file on every cycle, so
editing them is the whole configuration surface. Nothing else changes them. A
value outside its range is ignored and the default stands.

- batch-max: 4                            (1–20)
- batch-trivial-only: true                (true or false)
- graduation-consecutive-agreements: 10   (1–1000)
- graduation-min-days: 14                 (0–3650)
- audit-sample-rate: 0.2                  (0–1)
- staleness-minutes: 30                   (1–10080)
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
  "maxConcurrentWorkers": 10
}
`;
