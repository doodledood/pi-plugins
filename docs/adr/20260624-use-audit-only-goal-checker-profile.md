# ADR: Use a single audit-only goal checker profile

## Status
Accepted

## Context
The goal-controller checker exists to decide whether an active goal's completion contract has been proven. Earlier design exposed configurable checker capability modes. In practice this made the checker capability boundary harder to reason about: the no-tools mode is too weak for the session-navigation checker because it cannot inspect the persisted session file; the unrestricted mode lets the checker become too worker-like; and the read-oriented mode blocks skills while still allowing shell execution.

The desired checker role is narrower: read the transcript/session artifact as needed, reason over surfaced evidence, inspect referenced files when useful, and activate skills that help with the judgment. The checker should not run omitted primary verification work such as tests, builds, evals, or deploys on the worker's behalf, and it should not mutate local state.

Prompt templates and context files do not belong in the checker subprocess by default. Prompt templates are slash-command prompt expanders for user workflows, not checker evidence. Context files are broad AGENTS/CLAUDE behavioral and project instructions; loading them would blur the checker prompt's independent-auditor role. Skills are different: they are on-demand audit workflows or domain instructions that the checker can load with `read` when the task shape calls for them.

## Decision
Remove checker capability modes as a supported configuration surface. The goal checker will use one fixed audit-only capability profile:

- allow read/search/navigation built-in tools needed to inspect evidence: `read`, `grep`, `find`, and `ls`;
- enable skill discovery so the checker can activate relevant skills and read their `SKILL.md` files;
- disable extension tools, prompt templates, and context files;
- deny `bash`, `edit`, and `write` so the checker cannot run primary verification commands or mutate files;
- keep the checker prompt's explicit rule that checker-side tools must not perform omitted primary success work on the worker's behalf.

Keep checker model and reasoning effort configurable with the existing default of `model: "inherit"` and `thinking: "inherit"`. A different model family or lower/higher thinking level remains an explicit user configuration choice, not a default.

No compatibility mode is kept for old checker capability-mode values; the modes are removed rather than deprecated over time.

## Alternatives Considered
- **Keep configurable checker capability modes**: Preserves configurability, but keeps a confusing boundary and leaves room for the checker to be either too weak or too worker-like.
- **Default to `full` tools**: Maximizes checker autonomy, but violates the checker role by enabling worker-like tools and extension actions.
- **Keep no-tools transcript checking**: Simple, but incompatible with branch-aware session navigation when the checker needs to inspect the persisted session artifact.
- **Load prompt templates and context files too**: Gives the checker the worker's broader prompt environment, but prompt templates are workflow expanders and context files are broad behavioral/project instructions rather than checker evidence.
- **Use a different model family or lower checker effort by default**: Could reduce latency or add independent judgment, but introduces hidden provider/credential/cost assumptions. Inheriting model and thinking keeps default behavior unsurprising and configurable.

## Consequences

### Positive
- The checker has the evidence-inspection tools it needs without being able to perform the worker's omitted verification work.
- Skills can guide checker judgment for specialized workflows.
- The public configuration becomes simpler and easier to explain: checker capability is fixed, model/thinking/timeout remain configurable.
- Removing `bash`, `edit`, and `write` reduces accidental side effects from checker subprocesses.

### Negative
- Users who intentionally wanted no-tools or full-tools checker modes lose that configuration surface.
- Some checks that could have been accelerated by `bash` must be delegated back to the worker, which may require another continuation turn.
- Skill loading increases checker prompt surface compared with the current `--no-skills` subprocess behavior.

## Source
- Session: figure-out discussion in `pi-plugins` on 2026-06-24
- Supersedes the checker capability-mode portion of 20260623-use-session-navigation-checker-context
- Related: `packages/extensions/goal-controller/extensions/goal-controller/checker.ts`
- Related: `packages/extensions/goal-controller/extensions/goal-controller/prompts.ts`
- Related: `packages/extensions/goal-controller/extensions/goal-controller/config.ts`
