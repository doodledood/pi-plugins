# ADR: Keep goal statusline rendering separate from goal-controller

## Status
Accepted

## Context
The goal-controller extension publishes goal lifecycle state into Pi's footer/status mechanism with `ctx.ui.setStatus("goal-controller", ...)`. A separate `simple-statusline` extension installs the actual custom footer and renders extension statuses from Pi footer data. During UX discussion, we considered improving the visibility of long-running goal checks now that checker subprocesses can run for up to five minutes. The main tension was whether to change the generic statusline renderer to make goal state more prominent, or keep goal-specific behavior inside goal-controller.

## Decision
Goal UX improvements will preserve the boundary between goal-controller and the statusline renderer. Goal-controller may improve the status value it publishes, track checker runtime metadata needed for that value, recover stale `checking` state, and implement goal-specific commands such as cancellation. It must not require changes to `simple-statusline` for goal-specific behavior. The statusline remains a generic consumer of extension statuses.

## Alternatives Considered
- **Modify `simple-statusline` for goal-specific rendering**: Could make goal states visually richer, but couples a generic footer renderer to one extension's domain and makes future statusline changes riskier.
- **Add a separate goal widget or transcript lifecycle rows**: Would make checker progress more visible, but the user judged the existing footer enough; transcript rows would also risk adding UX telemetry to model-visible context if implemented via custom messages.
- **Move footer rendering into goal-controller**: Would give goal-controller full control over presentation, but duplicates or competes with the existing statusline extension and breaks the intended separation of state publication from footer rendering.

## Consequences

### Positive
- Goal-controller can improve UX without depending on a particular footer implementation.
- `simple-statusline` stays generic and low-hierarchy.
- Future footer/statusline redesigns can continue to consume the same extension status API.
- Goal-specific lifecycle fixes remain testable inside the goal-controller package.

### Negative
- Goal-controller is limited to compact status strings for always-visible progress.
- Richer visual affordances require either generic statusline capabilities or a future explicitly-approved goal-specific surface.
- The statusline may still truncate or style goal text according to generic footer rules.

## Source
- Session: figure-out discussion in `pi-plugins` on 2026-06-24
- Related: `packages/extensions/goal-controller/extensions/goal-controller/`
- Related: `packages/extensions/simple-statusline/extensions/simple-statusline.ts`
