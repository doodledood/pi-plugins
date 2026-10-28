# North Star — pi-plugins

What this project is for, for whom, and how it measures progress — the base every session and
contributor decides from. This document informs; it never binds: a boundary that must be
enforced on a piece of work is encoded in that work's own binding contract. A line gives grounds
for a second look: before it cuts an option, check that it covers the case.

Every position below carries a state, rendered as a dated provenance note:

- **evidence** — something happened in the world, dated; new evidence moves it.
- **hypothesis** — best current thinking, untested; a test moves it.
- **ruled** — an authorized choice; its decider and any delegation are named.
- **empty** — nobody has answered yet, written with what would fill it.

New evidence may lower a position's state. Position changes need an authorized ruling, remembered
as a decision record. Explicit delegation can cover specified changes within an assignment;
owner-retained ends and bounds stay with the owner.

## Purpose

The end the person this project serves is after has not been stated.
— empty: no artifact names it. What would fill it: the owner, asked in their own words what a person using this setup is ultimately after, and "why does that matter?" of each answer. 2026-10

In the way: making a tuned Pi setup — its extensions, themes, configuration and operating instructions — hold on another machine or for another person takes manual, error-prone work.
— hypothesis: the README names agentic setup sync as the main use case; no outside user has confirmed this is the barrier. 2026-10

In the way: Pi's stock behavior leaves daily agent work with friction the owner meets, such as cache breaks, unattended goals, supervision of parallel sessions and noisy tool output.
— hypothesis: most of the history is extensions addressing the owner's own daily work; the README does not state this as the purpose. 2026-10

For: the owner, running Pi daily across several machines; and Pi users who install one extension or theme from this repository on its own.
— hypothesis: the README names the owner's portable setup; AGENTS.md keeps every shareable resource individually installable and the packages carry npm publish metadata; no outside user is recorded. 2026-10

Not for: nobody is named.
— empty: no artifact excludes anyone. What would fill it: the owner naming whom this setup is deliberately not built for. 2026-10

## Goal

Where the project is headed has not been stated.
— empty: no artifact states it. What would fill it: the owner, once the end above is stated, describing what reaching it looks like to the person relying on this setup. 2026-10

## Principles

- Every shareable resource stays individually installable: one package per extension or theme, never a bundle that must be taken whole.
  — hypothesis: stated as a standing repository rule in AGENTS.md and checked by `scripts/verify-structure.mjs`; not yet confirmed by the owner as held against evidence. 2026-10
- Nothing private is published: no live Pi state, credentials, session logs or workplace material enters the repository.
  — hypothesis: stated in AGENTS.md and checked by `scripts/verify-structure.mjs` (forbidden state files and employer terms); not yet confirmed by the owner as held against evidence. 2026-10

## How we know

- Progress on the end has no measure.
  — empty: the end is not stated. What would fill it: a count or observation the owner names once the end is stated, with its direction. 2026-10
- Setup sync: a machine reaches the selected setup through an agent with no step done by hand beyond local secrets; more machines synced that way, fewer manual fixes after.
  — hypothesis: follows from the README's completion contract for setup sync; nothing records it being counted. 2026-10

## What this rests on

- An agent given this repository can bring a machine to the owner's setup safely, preserving local values and secrets.
  — hypothesis: the README's whole replication workflow rests on it; no recorded run on a second machine is cited. 2026-10

## Open

- The README states setup sync as the main use, while most of the history builds extensions for the owner's own daily work. Which one is the purpose, or are both parts of one end? What would fill it: the owner's answer.

## Strategy choices in force
