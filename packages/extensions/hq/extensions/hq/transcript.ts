/**
 * Reading a pi session's transcript.
 *
 * Session files are append-only JSONL: a header line, then entries. HQ only ever
 * reads them — the tail of the conversation is what triage and drills need to
 * explain a stop, and quoting it verbatim is what lets the user trust a packet
 * without opening the session.
 */

import { readFile } from "node:fs/promises";

export interface TranscriptMessage {
  role: string;
  text: string;
  at: string | undefined;
  stopReason: string | undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const part = entry as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "toolCall" && typeof part.name === "string") {
      parts.push(`[tool: ${part.name}]`);
    }
  }
  return parts.join("\n");
}

/** Parses a session file into user/assistant messages, oldest first. */
export async function readTranscript(sessionFile: string): Promise<TranscriptMessage[]> {
  let text: string;
  try {
    text = await readFile(sessionFile, "utf8");
  } catch {
    return [];
  }

  const messages: TranscriptMessage[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // A torn last line means another process is still writing; ignore it.
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as Record<string, unknown>;
    if (entry.type === "session") continue;
    const message = entry.message;
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    const role = typeof record.role === "string" ? record.role : undefined;
    if (!role || (role !== "user" && role !== "assistant")) continue;
    const body = textFromContent(record.content);
    if (!body.trim()) continue;
    messages.push({
      role,
      text: body,
      at: typeof entry.timestamp === "string" ? entry.timestamp : undefined,
      stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
    });
  }
  return messages;
}

export interface TailOptions {
  maxMessages?: number;
  maxChars?: number;
}

/** The most recent exchange, budgeted so a worker prompt stays readable. */
export async function readTranscriptTail(
  sessionFile: string | null,
  options: TailOptions = {},
): Promise<TranscriptMessage[]> {
  if (!sessionFile) return [];
  const maxMessages = options.maxMessages ?? 30;
  const maxChars = options.maxChars ?? 24_000;
  const all = await readTranscript(sessionFile);
  const tail = all.slice(-maxMessages);

  let budget = maxChars;
  const kept: TranscriptMessage[] = [];
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index];
    if (!message) continue;
    const cost = message.text.length;
    if (cost > budget && kept.length > 0) break;
    kept.unshift(
      cost > budget
        ? { ...message, text: `${message.text.slice(0, Math.max(0, budget))}…` }
        : message,
    );
    budget -= Math.min(cost, budget);
    if (budget <= 0) break;
  }
  return kept;
}

export function renderTranscript(messages: readonly TranscriptMessage[]): string {
  if (messages.length === 0) return "(no transcript available)";
  return messages
    .map((message) => `### ${message.role}${message.at ? ` @ ${message.at}` : ""}\n${message.text}`)
    .join("\n\n");
}
