# ADR: Tolerate trailing commas and re-ask once when a goal checker's verdict is badly formatted

## Status
Accepted

## Context
A goal checker that cannot produce a usable verdict pauses the goal, so an unattended run stops until someone resumes it. Reading 577 recorded checker runs (their sidecar sessions) through the production `parseCheckerVerdict` showed that most failures were not the checker disagreeing, but the checker's answer being written wrongly:

- 11 answers had no JSON object at all: the model replied in prose, sometimes continuing the goal's own task instead of auditing it (all on the older `gpt-5.6-luna`).
- 3 answers were JSON without a recognized `decision` (`"verdict": "INCOMPLETE"`, or `complete` and `requirements` only).
- 1 answer, the most recent failure on `gpt-6-luna`, was a complete, well-formed verdict that had trailing commas (`},\n    },`). Strict `JSON.parse` rejected it and the message said "not a JSON verdict object", which was misleading: the object was there.
- 1 answer had conflicting fields, which is a verdict the checker meant, not a formatting slip.

Replayed through the new parser, that trailing-comma run is accepted and the 11 prose answers are still rejected, as intended.

Separately, 36 recorded runs end on a tool call after 9 to 41 seconds and 8 end in a provider error; those take other error paths and are not addressed here.

The failure message also could not distinguish these causes, so each one had to be reproduced by hand.

## Decision
Three changes, each limited to what cannot change what the verdict says:

1. **Parse strictly first, then tolerate exactly one slip.** If strict `JSON.parse` fails on an object, trailing commas before a closing brace or bracket are removed (outside strings) and the text is parsed again. Nothing else is repaired.
2. **Name the cause.** An answer with no opening brace is reported as "not a JSON verdict object" (prose); an object that still fails to parse is reported as malformed JSON with the line it broke on, never with any checker text.
3. **Re-ask once, for format failures only.** A prose, malformed-JSON, or decision-less answer starts one more checker run before the goal is paused; a second failure pauses it and the message says `Attempts: 2`. Process, provider, and event-stream failures, aborts, and semantic rejections (conflicting fields, complete without evidence) surface immediately and are never re-asked.

The checker prompt also asks for strict JSON with no trailing commas, comments, or surrounding text.

## Alternatives Considered
- **A lenient JSON5-style parser**: accepts comments, single quotes, unquoted keys — Rejected: a wider repair surface means more ways to read a verdict the checker did not write, in a path where a false "complete" is the expensive error.
- **Derive `decision` from a `complete` boolean when it is missing**: would recover two of the three decision-less answers — Rejected: `complete: true` without a stated decision is the case where guessing is least safe, and the checker prefers a false negative.
- **Retry on every invalid verdict**: simpler to state — Rejected: re-asking a semantic rejection until the checker says "complete" turns a safeguard into a coin flip.
- **More than one retry**: lowers the pause rate further — Rejected: each re-ask is a full audit; one covers an independent slip, and a checker that fails twice in a row is better surfaced.
- **Better diagnostics only**: cheapest — Rejected: it would have named the cause but still paused the goal.

## Consequences

### Positive
- A harmless syntax slip no longer pauses an unattended goal, and a one-off prose or schema slip is usually recovered without anyone noticing.
- Failure messages say whether the checker wrote prose or broken JSON, and where.

### Negative
- A format-invalid first answer costs a second full checker run and up to double the wall time (each run keeps its own timeout).
- The retry rate is not measured: the 2.6% format-failure figure is retrospective, and whether one re-ask clears most of them is an expectation, not an observation.

## Source
- Session: investigation of recurring "The checker response was not a JSON verdict object" goal pauses, 2026-10-06.
- Related: 20260923-validate-only-the-checker-verdict-path (that decision keeps the event stream tolerant of Pi; this one keeps the verdict text tolerant of a slip without loosening what a verdict must contain)
