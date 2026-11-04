# ADR: Rule that this repository is also for Pi users beyond the owner

## Status
Accepted

## Area
north-star

## Decided by
The user: "it should work in other setups as well, that's my point", followed by his explicit choice to mark the North Star line as ruled.

## Context
The North Star's *Purpose* names who the project is for: the owner, running Pi daily across several machines, and Pi users who install one extension or theme from this repository on its own. That line was a hypothesis, resting on the repository's packaging rule and npm publish metadata, with no outside user recorded. While designing a Slack companion, the owner required it to work in other people's setups, with configurable tool names whose defaults are his but not required, and called that the point.

## Decision
The *For* line becomes `ruled`, decided by the owner: resources here are built to work in other people's Pi setups, not only in his. The line's words do not change.

## Alternatives Considered
- **Leave the line a hypothesis until an outside user appears**: keeps the state about the world; rejected because the owner made a choice, not an observation. Whether outside users arrive is evidence for a measure, not for whom the work is built.

## Consequences

### Positive
- A choice that trades portability for convenience in the owner's setup now has a ruling to weigh it against.

### Negative
- Portability costs work in every package: configuration where the owner's own values could have been hard-coded.

## Enforced by
none — whom the work is for is a ruling no check can hold; individual installability is held by 20260623-ship-each-resource-as-its-own-package.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
