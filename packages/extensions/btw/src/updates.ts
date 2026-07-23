import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ReadonlyParentSessionManager = ExtensionContext["sessionManager"];
import { selectForkBranch } from "./fork.ts";

const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_MAX_CHARS = 12_000;
const MAX_ENTRY_CHARS = 1_500;

export type ParentUpdateStatus = "no_updates" | "updates" | "diverged";

export interface ParentUpdateResult {
  status: ParentUpdateStatus;
  text: string;
  details: {
    status: ParentUpdateStatus;
    commonEntryId: string | null;
    updateCount: number;
    returnedCount: number;
    compacted: boolean;
    truncated: boolean;
    parentLeafId: string | null;
  };
}

export interface ParentUpdateLimits {
  maxEntries?: number;
  maxChars?: number;
}

function commonPrefixLength(left: readonly string[], right: readonly string[]): number {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left[index] === right[index]) index += 1;
  return index;
}

function shorten(text: string, maxChars = MAX_ENTRY_CHARS): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars <= 0) return "";
  const marker = "\n… [entry truncated] …\n";
  if (marker.length >= maxChars) return normalized.slice(-maxChars);
  const available = maxChars - marker.length;
  const headChars = Math.floor(available * 0.4);
  return `${normalized.slice(0, headChars)}${marker}${normalized.slice(-(available - headChars))}`;
}

function contentText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
    case "toolResult":
      if (typeof message.content === "string") return message.content;
      return message.content
        .map((block) => (block.type === "text" ? block.text : "[image]"))
        .join("\n");
    case "assistant":
      return message.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "toolCall") {
            return `[tool call: ${block.name} ${shorten(JSON.stringify(block.arguments), 400)}]`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    case "bashExecution":
      return `$ ${message.command}\n${message.output}`;
    case "custom":
      if (typeof message.content === "string") return message.content;
      return message.content
        .map((block) => (block.type === "text" ? block.text : "[image]"))
        .join("\n");
    case "branchSummary":
    case "compactionSummary":
      return message.summary;
    default: {
      const exhaustive: never = message;
      return String(exhaustive);
    }
  }
}

export function normalizeParentEntry(entry: SessionEntry): string | null {
  switch (entry.type) {
    case "message": {
      const message = entry.message;
      if (message.role === "toolResult") {
        return shorten(`[tool result: ${message.toolName}${message.isError ? " — error" : ""}]\n${contentText(message)}`);
      }
      if (message.role === "assistant") {
        const suffix = message.stopReason === "error" || message.stopReason === "aborted" ? ` — ${message.stopReason}` : "";
        return shorten(`[assistant${suffix}]\n${contentText(message)}`);
      }
      return shorten(`[${message.role}]\n${contentText(message)}`);
    }
    case "compaction":
      return shorten(`[parent compacted context]\n${entry.summary}`);
    case "branch_summary":
      return shorten(`[parent branch summary]\n${entry.summary}`);
    case "model_change":
      return `[parent model changed] ${entry.provider}/${entry.modelId}`;
    case "thinking_level_change":
      return `[parent thinking changed] ${entry.thinkingLevel}`;
    case "custom_message": {
      const content = typeof entry.content === "string"
        ? entry.content
        : entry.content.map((block) => (block.type === "text" ? block.text : "[image]")).join("\n");
      return shorten(`[parent context: ${entry.customType}]\n${content}`);
    }
    case "session_info":
      return entry.name ? `[parent session renamed] ${entry.name}` : "[parent session name cleared]";
    case "label":
      return entry.label ? `[parent label] ${entry.label} → ${entry.targetId}` : null;
    case "custom":
      return null;
    default: {
      const exhaustive: never = entry;
      return String(exhaustive);
    }
  }
}

interface NormalizedSection {
  text: string;
  entryId: string;
  selectedIndex: number;
}

function boundNewestSections(
  sections: NormalizedSection[],
  maxChars: number,
  preserveFirst: boolean,
): { sections: NormalizedSection[]; truncated: boolean; newestRepresented: boolean } {
  if (sections.length === 0) {
    return { sections: [], truncated: false, newestRepresented: true };
  }
  if (maxChars <= 0) {
    return { sections: [], truncated: true, newestRepresented: false };
  }

  const newestIndex = sections.length - 1;
  const keep = new Map<number, NormalizedSection>();
  let used = 0;
  let truncated = false;
  const add = (index: number, maxSectionChars = sections[index]!.text.length): void => {
    const source = sections[index]!;
    const text = shorten(source.text, maxSectionChars);
    if (!text) return;
    keep.set(index, { ...source, text });
    used += text.length + (keep.size > 1 ? 2 : 0);
    truncated ||= text !== source.text;
  };

  if (preserveFirst && newestIndex > 0) {
    const first = sections[0]!;
    const newest = sections[newestIndex]!;
    if (first.text.length + 2 + newest.text.length <= maxChars) {
      add(0);
      add(newestIndex);
    } else {
      const contentBudget = Math.max(0, maxChars - 2);
      const firstBudget = Math.min(first.text.length, Math.floor(contentBudget * 0.4));
      const newestBudget = contentBudget - firstBudget;
      add(0, firstBudget);
      add(newestIndex, newestBudget);
      truncated = true;
    }
  } else {
    add(newestIndex, Math.min(sections[newestIndex]!.text.length, maxChars));
  }

  for (let index = newestIndex - 1; index >= 0; index -= 1) {
    if (keep.has(index)) continue;
    const section = sections[index]!;
    const separator = keep.size === 0 ? 0 : 2;
    const remaining = maxChars - used - separator;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (section.text.length <= remaining) add(index);
    else {
      if (remaining > 80) add(index, remaining);
      truncated = true;
      break;
    }
  }

  const bounded = [...keep.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, section]) => section);
  truncated ||= bounded.length !== sections.length;
  return {
    sections: bounded,
    truncated,
    newestRepresented: keep.has(newestIndex),
  };
}

/** State changes only when pull() is explicitly called by the child tool. */
export class ParentUpdateTracker {
  private observedEntryIds: string[];
  private readonly limits: Required<ParentUpdateLimits>;
  private readonly parentIsIdle: () => boolean;

  constructor(
    initialEntryIds: readonly string[],
    limits: ParentUpdateLimits = {},
    parentIsIdle: () => boolean = () => false,
  ) {
    this.observedEntryIds = [...initialEntryIds];
    this.limits = {
      maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxChars: limits.maxChars ?? DEFAULT_MAX_CHARS,
    };
    this.parentIsIdle = parentIsIdle;
  }

  pull(parent: ReadonlyParentSessionManager): ParentUpdateResult {
    const rawBranch = parent.getBranch();
    const parentIdle = this.parentIsIdle();
    let branch = selectForkBranch(rawBranch, parentIdle);
    // An active selector can trim a dangling tail that an earlier idle pull
    // already observed as settled. Preserve that known prefix so previously
    // observed entries cannot look like divergence.
    if (
      !parentIdle &&
      branch.length < this.observedEntryIds.length &&
      this.observedEntryIds.every((id, index) => rawBranch[index]?.id === id)
    ) {
      branch = rawBranch.slice(0, this.observedEntryIds.length);
    }
    const currentIds = branch.map((entry) => entry.id);
    const commonLength = commonPrefixLength(this.observedEntryIds, currentIds);
    const diverged = commonLength < this.observedEntryIds.length;
    const start = diverged ? commonLength : this.observedEntryIds.length;
    const updates = branch.slice(start);
    const compactIndex = updates.findLastIndex((entry) => entry.type === "compaction");
    const relevantUpdates = compactIndex >= 0 ? updates.slice(compactIndex) : updates;
    const compacted = compactIndex >= 0;
    const commonEntryId = commonLength > 0 ? currentIds[commonLength - 1]! : null;
    const parentLeafId = currentIds.at(-1) ?? null;

    if (!diverged && updates.length === 0) {
      this.observedEntryIds = currentIds;
      return {
        status: "no_updates",
        text: "No completed parent updates since the previous check.",
        details: {
          status: "no_updates",
          commonEntryId,
          updateCount: 0,
          returnedCount: 0,
          compacted: false,
          truncated: false,
          parentLeafId,
        },
      };
    }

    let selected = relevantUpdates;
    let truncated = false;
    if (selected.length > this.limits.maxEntries) {
      selected = compacted && this.limits.maxEntries > 1
        ? [selected[0]!, ...selected.slice(-(this.limits.maxEntries - 1))]
        : selected.slice(-this.limits.maxEntries);
      truncated = true;
    }

    const normalized = selected.flatMap((entry, selectedIndex): NormalizedSection[] => {
      const text = normalizeParentEntry(entry);
      return text === null ? [] : [{ text, entryId: entry.id, selectedIndex }];
    });
    const bounded = boundNewestSections(normalized, this.limits.maxChars, compacted);
    truncated ||= bounded.truncated || normalized.length !== selected.length;

    let latestMeaningfulEntryId: string | undefined;
    for (let index = relevantUpdates.length - 1; index >= 0; index -= 1) {
      const entry = relevantUpdates[index]!;
      if (normalizeParentEntry(entry) !== null) {
        latestMeaningfulEntryId = entry.id;
        break;
      }
    }
    const newestContentRepresented = latestMeaningfulEntryId === undefined || (
      normalized.at(-1)?.entryId === latestMeaningfulEntryId && bounded.newestRepresented
    );
    // Advance to the current head only when its newest meaningful content was
    // represented. Otherwise retain the old cursor so the next explicit pull
    // can retry with a larger budget.
    if (newestContentRepresented) this.observedEntryIds = currentIds;

    const status: ParentUpdateStatus = diverged ? "diverged" : "updates";
    const intro = diverged
      ? `The parent active branch diverged after ${commonEntryId ?? "the session root"}. The entries below describe the current completed branch after that point; reconcile rather than assuming a linear continuation.`
      : compacted
        ? "The parent compacted its context. The compaction summary and subsequent completed entries follow."
        : "Completed parent updates follow.";
    const omission = truncated ? "\n\n[Result bounded; some entries or content were omitted.]" : "";
    const body = bounded.sections.length > 0
      ? `\n\n${bounded.sections.map((section) => section.text).join("\n\n")}`
      : "";

    return {
      status,
      text: `${intro}${body}${omission}`,
      details: {
        status,
        commonEntryId,
        updateCount: updates.length,
        returnedCount: bounded.sections.length,
        compacted,
        truncated,
        parentLeafId,
      },
    };
  }
}
