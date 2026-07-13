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

function isTerminalAssistant(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    entry.message.stopReason !== "toolUse"
  );
}

/**
 * Return the completed prefix of an active branch. SessionManager only persists
 * finalized messages, but a finalized tool-use assistant plus tool results can
 * still be an incomplete turn while its final assistant response is streaming.
 */
export function selectCompletedBranch(
  entries: readonly SessionEntry[],
  isIdle = false,
): SessionEntry[] {
  // Once Pi is idle there is no pending model continuation: every entry it has
  // persisted on the active branch is settled, including a terminating
  // tool-use assistant/result batch and trailing extension context.
  if (isIdle) return [...entries];

  let completedThrough = -1;
  let turnOpen = false;
  let customOnly = false;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;

    if (entry.type === "custom_message") {
      // During an active turn this may be queued context for that turn, so
      // retain the previous completed boundary. If no agent turn is open, a
      // later user message proves this custom-only prefix was idle context.
      if (!turnOpen) customOnly = true;
      turnOpen = true;
      continue;
    }

    if (entry.type !== "message") {
      if (customOnly) {
        completedThrough = index;
        turnOpen = false;
        customOnly = false;
      } else if (!turnOpen) {
        completedThrough = index;
      }
      continue;
    }

    switch (entry.message.role) {
      case "user":
        if (customOnly) completedThrough = index - 1;
        turnOpen = true;
        customOnly = false;
        break;
      case "assistant":
        if (isTerminalAssistant(entry)) {
          completedThrough = index;
          turnOpen = false;
        } else {
          turnOpen = true;
        }
        customOnly = false;
        break;
      case "toolResult":
        // Tool results are complete entries but not a complete agent turn.
        customOnly = false;
        break;
      case "bashExecution":
        if (!turnOpen) completedThrough = index;
        break;
      case "custom":
        turnOpen = true;
        customOnly = false;
        break;
      case "branchSummary":
      case "compactionSummary":
        if (!turnOpen) completedThrough = index;
        break;
      default: {
        const exhaustive: never = entry.message;
        void exhaustive;
      }
    }
  }

  return entries.slice(0, completedThrough + 1);
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

  const entries = selectCompletedBranch(ctx.sessionManager.getBranch(), ctx.isIdle());
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
