# ADR: Session-tree cost accounting via persistent parent-linked child sessions

## Status
Accepted

## Context
Pi reports session cost by scanning one session file's own entries: assistant messages, `toolResult.usage`, compaction usage, and branch-summary usage. It does not aggregate related child session files.

That leaves auxiliary model work uncounted in this setup:

- `advisor-consult` and the `goal-controller` checker run `pi --mode json -p --no-session`, so their provider-reported usage is discarded entirely.
- `@gotgenes/pi-subagents` persists each agent session under `<parent-session>/tasks/`, but returns no `ToolResult.usage`, so subagent cost never enters the parent session.
- `/panel` persists panelist sessions but records cost only in its own display metadata.
- `/btw` creates a temporary child session and deletes it on close.
- `simple-statusline` sums only assistant-message usage in the parent branch, so it also omits tool-reported, compaction, and branch-summary usage that Pi's own footer counts.

Observed magnitude: two audit subagents launched during this investigation cost about $0.66 of provider-reported spend that appeared nowhere in the parent session.

The owner's requirement is a complete picture in two places: an accurate live statusline total, and durable data that supports later cost analysis.

## Decision
Treat the **Pi session tree** as the accounting system of record, and aggregate it recursively.

1. Every model run this setup spawns persists as a normal Pi session file, linked to its parent through the session header's `parentSession` field, stored under the parent session's sidecar directory. The advisor and checker runners stop passing `--no-session`, keeping it only as the fallback for a parent that has no session file of its own — there is then nothing to attach the spend to.
2. Cost accounting reads Pi's native per-entry usage from those files — assistant, tool-result, compaction, and branch-summary usage — rather than a separate parallel ledger.
3. `simple-statusline` reports whole-session lifetime cost by recursively summing the root session and all descendant sessions, refreshing as child sessions gain usage.
4. Direct paid calls that are not Pi sessions — the cache-optimization TTL keepalive, and any speech/image API call — record their own durable cost entries in the session that caused them, because no child session file exists to scan.

Deduplication spans the tree rather than following file identity, because a fork copies its parent's entries verbatim into its own file: a billed unit is keyed by its cost-record id, or by entry id plus timestamp. Pi's entry ids are eight hex characters, unique within a session but not across a large tree, so the timestamp is what makes the key safe to compare between files — a copied entry keeps both verbatim, while two unrelated turns would have to collide on both.

## Alternatives Considered
- **Custom usage ledger in the parent session**: An extension-owned `recordUsage()` API writing context-excluded custom entries, with child sessions instrumented to report upward. Rejected as unnecessary duplication once every child run is a persistent linked session: it would maintain a second source of truth that can disagree with the session files, and it needs its own reconciliation path for crashes.
- **Return aggregate `ToolResult.usage` from every model-backed tool**: This is Pi's native contract and remains correct for tool-shaped work such as `advisor_consult`. Rejected as the *complete* solution because goal checking, `/panel`, `/btw`, cache keepalive, and background-subagent completion do not run inside a parent tool result and therefore have no usage slot.
- **Patch or extend Pi upstream with a usage-entry API**: Cleanest native semantics, and it would fix Pi's own `/session` and RPC totals. Rejected because the owner requires a local solution that does not modify Pi.
- **Runtime-patch `AgentSession.getSessionStats()`**: Would make Pi's built-in `/session` and RPC totals include aggregated child cost. Rejected as the primary mechanism: it depends on Pi internals across versions, and Pi's per-model cost breakdown scans entries directly, so the breakdown and the total could disagree.
- **Keep child transcripts only long enough to import their usage**: Rejected because durable child sessions are what make later cost analysis and audit possible at all; retention follows each feature's existing transcript policy.
- **Report only the active branch's cost**: Rejected because abandoned branches were still billed; lifetime spend is the honest headline, with an active-branch subtotal available in a detailed report.

## Consequences

### Positive
- One source of truth: Pi's own session entries, with no parallel ledger to reconcile.
- Later cost analysis can walk the session tree offline and attribute spend by session, model, and feature.
- Subagents need no persistence change; they already write linked session files.
- Advisor and checker runs gain auditable transcripts as a side effect of becoming accountable.
- Crash recovery is inherent: usage already written to a child session file is still discoverable on the next scan.

### Negative
- Auxiliary runs now write session files where they previously wrote none, consuming disk and requiring a retention policy.
- Statusline rendering must read descendant session files instead of only in-memory parent state, adding I/O, caching, and invalidation concerns.
- Pi's built-in footer and `/session` still report parent-only totals, so two visible numbers can disagree unless the built-in surfaces are also addressed.
- Live cost lags provider reporting: a child's spend appears only once that turn's usage is written, not continuously during a long turn.
- Non-session paid calls remain a special case that must be recorded deliberately, and any request billed without returned usage stays invisible.

## Source
- Session: figure-out investigation, log at `~/.manifest-dev/logs/figure-out-log-20260728-082100.md`
- Related: 20260706-cache-efficiency-observability, 20260709-advisor-consult-independent-subprocess, 20260624-keep-goal-statusline-separate
