# ADR: Cache-optimization second wave

- **Date:** 2026-07-07
- **Status:** Accepted
- **Supersedes/corrects:** part of [20260706-cache-optimization-extension](20260706-cache-optimization-extension.md)
- **Related:** [20260706-cache-efficiency-observability](20260706-cache-efficiency-observability.md), [20260624-keep-goal-statusline-separate](20260624-keep-goal-statusline-separate.md)

## Context

The first cache-optimization extension shipped `/cache`, Anthropic cache keeper, and a bounded TTL keepalive. Follow-up forensics over the 14-day pre-activation window found roughly $659 modeled cache-break waste on roughly $5,054 total spend. That investigation also falsified one label in the first ADR: the previously described "$131/14d in-flight TTL waits" class was not mainly foreground tools waiting mid-turn.

Gap-end decomposition showed that true foreground in-flight waits were small (about 3 events / ~$6). The dominant Anthropic TTL shape was background wakeups and idle gaps: background completion entries and custom entries arrived after more than 5 minutes with no foreground tool execution still in flight. The actionable thinking-off background-wakeup slice was estimated at about $25–28 per 14 days. Thinking-enabled TTL gaps remain structurally unreachable because a cheap identical-prefix ping cannot reproduce the original thinking budget, and Anthropic's pre-warm/zero-token shape does not rescue that class.

A second source of cache waste came from `mcp-tool-loadout`: the names-only catalog was already cache-safe and byte-stable, but `load_tools` changed Pi's active tools array mid-session. Provider caching treats that as a system/tools prefix change, causing a full rewrite at warm-context sizes. With the local MCP universe at 157 tools / about 60k schema tokens, keeping the catalog stable is valuable, and mid-session hard activation should be exceptional rather than default.

A third lever came from the cost-sim research in `~/Documents/Projects/research/tools/cost-sim/results/REPORT.md`: boundary compaction around 50% context was graded as a robust improvement (+8.6% in the sim) when performed at natural boundaries. This repo should provide an ambient hint, not automatic compaction, because mid-task compaction can reduce answer adequacy.

Finally, the same research reaffirmed that Anthropic 1h retention is not the right default. The S23 5m-TTL + keep-warm strategy was robustly better across the sweep: 1h retention's 2× write premium taxes every write, while the 5m keepalive pays cheap reads only when a gap actually needs rescue. OpenAI retention is a separate provider decision because OpenAI's long retention does not carry the same write premium.

## Decision

1. **Generalize TTL keepalive to background work without package coupling.**
   - Keepalive now arms while either a foreground tool is in flight or the main agent is idle with pending background work.
   - Background detection is package-agnostic: any tool call carrying a truthy `run_in_background`-style argument (for example `run_in_background`, `runInBackground`, or `background_work`) counts as a background launch, regardless of tool name or extension.
   - Package identities and custom entry names are intentionally not part of the mechanism. They may appear in tests and docs as examples only.
   - Pending background work is armed after the launching agent turn ends, consumed by the next real provider-request wake, cleared on branch/tree navigation or shutdown, and dropped by a fail-safe expiry that only removes pending work.
   - Existing keepalive bounds remain: same-route Anthropic API-key route, 5m-TTL payloads only, thinking-off payloads only, 100k prompt floor, per-gap ping cap, daily dollar cap, and zero pings while idle with no foreground/background work.

2. **Make `load_tools` cache-safe by default.**
   - Default `load_tools` returns the requested dormant tools' schemas and exact `mcp({ tool, args })` proxy-call examples in the tool result.
   - The default path does not mutate the active tool set and does not change the system prompt or tools array.
   - Direct native activation remains available via an explicit `direct:true` escape hatch for cheap contexts or reliability-sensitive calls where a cache rewrite is acceptable.
   - The model-facing catalog now says dormant tools are loaded cache-safely for proxy calls, and that direct activation is opt-in.

3. **Put the compaction nudge in the statusline.**
   - `simple-statusline` now computes context percentage against the active model's context window and shows an ambient `compact at boundary` hint at 50%.
   - The hint is display-only footer state. It does not compact automatically, append session entries, or enter model context.
   - This placement follows the ambient-footer direction from `20260624-keep-goal-statusline-separate.md`: persistent low-hierarchy status belongs in the footer, not in modal warnings.

4. **Do not add invalidation warnings.**
   - The statusline already carries the cache-break signal, and `/cache` explains causes on demand. Additional warning notifications would add noise without changing the underlying behavior.

5. **Do not adopt Anthropic 1h retention as the default.**
   - The cost-sim S23 result keeps 5m TTL + bounded keepalive as the recommended Anthropic strategy. 1h retention remains rejected for this repo's default path.

## Consequences

- Background-wakeup TTL breaks that follow the generic background-launch convention are now covered without requiring users to install any companion extension.
- Exotic background work that does not expose a recognizable launch flag may remain uncovered. This is acceptable: missed coverage costs savings, not correctness. Adding a future cooperative signal is allowed, but the standalone heuristic must continue to work without cooperation.
- `load_tools` becomes slightly less ergonomic by default because the model calls through the `mcp` proxy with JSON-string args rather than native function calling. That trade-off is intentional at warm contexts: avoiding a full prompt/tools rewrite is worth occasional proxy-call friction. `direct:true` exists for cases where native calling matters more.
- The statusline becomes the single ambient place for context pressure, session cache rate, and cache-break flag; `/cache` remains the detailed diagnostic surface.

## Alternatives considered

- **Special-case known background extensions.** Rejected. It would cover today's pi-subagents or goal-controller shapes more precisely, but `cache-optimization` is individually installable and must work with arbitrary extension sets. Package-specific hooks would also age poorly as new background tools appear.
- **Decrement background work only on extension-specific completion entries.** Rejected for the same coupling reason. The implemented wake bookkeeping plus expiry is less precise but bounded and generic.
- **Keep hard `load_tools` as the default and merely warn about rewrites.** Rejected. The model-facing catalog was already cache-safe; the remaining expensive operation was the hard activation itself. Warnings would explain the waste after choosing it, not avoid it.
- **Proxy-only MCP usage with no catalog.** Rejected. It hides tool names and forces discovery/search. The names-only catalog is small, byte-stable, and preserves awareness.
- **Auto-compact at 50%.** Rejected. The cost-sim benefit assumes useful task-boundary compaction; automatic mid-task compaction can reduce quality. The statusline hint leaves the boundary decision with the operator.
- **Anthropic 1h retention.** Rejected again. The research sweep found 5m TTL + keep-warm robustly better because 1h retention doubles every write while keepalive pays cheap reads only during actual long gaps.

## Verification

- Unit tests cover generic fake-tool background arming, idle-with-background pings, wake/pending-zero disarm, fail-safe expiry, branch/tree disarm, and the existing keepalive guards.
- Unit tests cover cache-safe `load_tools` returning schemas/proxy examples without active-tool mutation, explicit `direct:true` hard activation, and catalog byte-stability after load-like active-set changes.
- Unit tests cover statusline context percentage computation, threshold hint/tone, and compaction/tree refresh hooks.
- Repo-level verification is `npm run verify`.
