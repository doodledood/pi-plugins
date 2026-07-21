import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Minimal structural view of the session entries returned by
 * `ctx.sessionManager.buildContextEntries()` (active branch, compaction
 * applied). Mirrors pi's session-format entry union without importing
 * internals.
 */
export interface ContextEntryLike {
  type: string;
  timestamp?: string;
  message?: AgentMessage;
  // compaction
  summary?: string;
  tokensBefore?: number;
  // branch_summary
  fromId?: string;
  // custom_message
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
}

/**
 * Convert the active branch's context entries into the AgentMessage history a
 * panelist session is seeded with. Follows pi's own entry→message conversion
 * (session-format.md "Context Building"): `message` entries pass through
 * verbatim (full history preserved), `compaction` and `branch_summary` become
 * their summary message forms, `custom_message` becomes a CustomMessage, and
 * non-context entries (`custom`, labels, model changes) are dropped.
 */
export function forkMessagesFromEntries(entries: readonly ContextEntryLike[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const entry of entries) {
    switch (entry.type) {
      case "message":
        if (entry.message) messages.push(entry.message);
        break;
      case "compaction":
        messages.push({
          role: "compactionSummary",
          summary: entry.summary ?? "",
          tokensBefore: entry.tokensBefore ?? 0,
          timestamp: entryTimestamp(entry),
        } as AgentMessage);
        break;
      case "branch_summary":
        messages.push({
          role: "branchSummary",
          summary: entry.summary ?? "",
          fromId: entry.fromId ?? "",
          timestamp: entryTimestamp(entry),
        } as AgentMessage);
        break;
      case "custom_message":
        messages.push({
          role: "custom",
          customType: entry.customType ?? "unknown",
          content: (entry.content as never) ?? "",
          display: entry.display ?? false,
          details: entry.details,
          timestamp: entryTimestamp(entry),
        } as AgentMessage);
        break;
      default:
        break; // custom, label, model_change, thinking_level_change, session, …
    }
  }
  return messages;
}

function entryTimestamp(entry: ContextEntryLike): number {
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isNaN(parsed) ? Date.now() : parsed;
}
