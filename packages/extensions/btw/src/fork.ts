import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type {
  BuildSystemPromptOptions,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

export interface ForkSnapshot {
  cwd: string;
  entries: SessionEntry[];
  entryIds: string[];
  forkLeafId: string | null;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  activeToolNames: string[];
  projectTrusted: boolean;
  systemPromptOptions: BuildSystemPromptOptions;
  parentSessionFile: string | undefined;
}

/**
 * Return the newest valid fork prefix of an active branch. SessionManager only
 * persists finalized entries, so everything in the branch is settled content —
 * including tool calls of a turn that is still running. The only shape a fork
 * must not end on is an assistant tool-use message whose tool results are not
 * all persisted yet: a user message after dangling tool calls is rejected by
 * providers. Trim that dangling suffix and keep everything else.
 */
export function selectForkBranch(
  entries: readonly SessionEntry[],
  isIdle = false,
): SessionEntry[] {
  // Once Pi is idle there is no pending model continuation: every persisted
  // entry on the active branch is settled, including a terminating tool-use
  // assistant/result batch and trailing extension context.
  if (isIdle) return [...entries];

  // Find the last assistant message that requested tool calls. Only that one
  // can still be awaiting tool results; earlier tool-use assistants already
  // have their results persisted after them.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    if (entry.message.stopReason !== "toolUse") break;

    const pending = new Set(
      entry.message.content
        .filter((block) => block.type === "toolCall")
        .map((block) => block.id),
    );
    for (let rest = index + 1; rest < entries.length; rest += 1) {
      const later = entries[rest]!;
      if (later.type === "message" && later.message.role === "toolResult") {
        pending.delete(later.message.toolCallId);
      }
    }
    // Dangling tool calls: drop the requesting assistant and everything after
    // it (partial tool results, trailing context queued behind them).
    if (pending.size > 0) return entries.slice(0, index);
    break;
  }

  return [...entries];
}

export function snapshotParent(
  ctx: ExtensionCommandContext,
  model: Model<any> | undefined,
  thinkingLevel: ThinkingLevel,
  activeToolNames: readonly string[],
): ForkSnapshot {
  if (!model) {
    throw new Error("BTW cannot open because the parent has no active model.");
  }

  const entries = selectForkBranch(ctx.sessionManager.getBranch(), ctx.isIdle());
  const forkLeafId = entries.at(-1)?.id ?? null;

  return {
    cwd: ctx.cwd,
    entries,
    entryIds: entries.map((entry) => entry.id),
    forkLeafId,
    model,
    thinkingLevel,
    activeToolNames: [...activeToolNames],
    projectTrusted: ctx.isProjectTrusted(),
    systemPromptOptions: ctx.getSystemPromptOptions(),
    parentSessionFile: ctx.sessionManager.getSessionFile(),
  };
}
