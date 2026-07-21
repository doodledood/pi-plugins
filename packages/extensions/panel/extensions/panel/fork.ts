import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Convert the active branch's context entries (from
 * `ctx.sessionManager.buildContextEntries()`: active branch, compaction
 * applied) into the AgentMessage history a panelist session is seeded with.
 *
 * Delegates to pi's own exported entry→message conversion so the fork can
 * never drift from what the host session itself would send: `message` entries
 * pass through (with null-content normalization), `compaction` and
 * `branch_summary` become their summary message forms, `custom_message`
 * becomes a CustomMessage, and non-context entries are dropped.
 */
export function forkMessagesFromEntries(entries: readonly SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => sessionEntryToContextMessages(entry));
}
