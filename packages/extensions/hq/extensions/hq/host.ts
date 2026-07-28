/**
 * The slice of pi's extension surface HQ depends on.
 *
 * Declaring it here keeps the runtime testable without a live pi process and
 * makes the coupling explicit: anything HQ needs from pi appears in this file.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface SessionManagerLike {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getBranch?(): readonly unknown[];
}

/** What the reporter reads from a session. */
export interface SessionContextLike {
  mode: string;
  cwd: string;
  sessionManager: SessionManagerLike;
}

export interface AssistantSnapshot {
  text: string;
  stopReason: string | undefined;
}

/** Extracts the latest assistant text and stop reason from an event payload. */
export function assistantFromMessages(
  messages: readonly unknown[],
): AssistantSnapshot | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (record.role !== "assistant") continue;
    return {
      text: messageText(record),
      stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
    };
  }
  return undefined;
}

export function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "object" && entry !== null) {
      const part = entry as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/** Finds the first user message text in a session branch, if there is one. */
export function firstUserText(branch: readonly unknown[]): string | undefined {
  for (const entry of branch) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const message = (record.message ?? record) as Record<string, unknown>;
    if (message.role !== "user") continue;
    const text = messageText(message).trim();
    if (text) return text;
  }
  return undefined;
}

export type CommandContext = ExtensionCommandContext;
