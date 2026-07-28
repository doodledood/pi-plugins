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
  role: "user" | "assistant";
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

interface RawEntry {
  id: string | undefined;
  parentId: string | undefined;
  timestamp: string | undefined;
  message: TranscriptMessage | undefined;
}

/**
 * Parses a session file into the messages on its live branch, oldest first.
 *
 * Session entries form a tree via id/parentId — pi branches in place when a
 * message is edited, a session is forked, or the tree is rewound — so file order
 * is not conversation order. Reading flat would let an abandoned branch be quoted
 * back to the user as what the session said, which is exactly the confusion
 * drills exist to prevent.
 */
export async function readTranscript(sessionFile: string): Promise<TranscriptMessage[]> {
  let text: string;
  try {
    text = await readFile(sessionFile, "utf8");
  } catch {
    return [];
  }

  const entries: RawEntry[] = [];
  const byId = new Map<string, RawEntry>();
  const hasChild = new Set<string>();

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
    const raw = parsed as Record<string, unknown>;
    if (raw.type === "session") continue;

    const id = typeof raw.id === "string" ? raw.id : undefined;
    const parentId = typeof raw.parentId === "string" ? raw.parentId : undefined;
    const entry: RawEntry = {
      id,
      parentId,
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
      message: toTranscriptMessage(raw),
    };
    entries.push(entry);
    if (id) byId.set(id, entry);
    if (parentId) hasChild.add(parentId);
  }

  // The live leaf is the last entry nothing descends from; falling back to the
  // last entry keeps a malformed or single-line file readable.
  const leaf = [...entries].reverse().find((entry) => entry.id && !hasChild.has(entry.id))
    ?? entries.at(-1);
  if (!leaf) return [];

  const branch: RawEntry[] = [];
  let cursor: RawEntry | undefined = leaf;
  const seen = new Set<string>();
  while (cursor) {
    branch.unshift(cursor);
    const parentId: string | undefined = cursor.parentId;
    if (!parentId || seen.has(parentId)) break;
    seen.add(parentId);
    cursor = byId.get(parentId);
  }

  return branch
    .map((entry) => entry.message)
    .filter((message): message is TranscriptMessage => message !== undefined);
}

function toTranscriptMessage(raw: Record<string, unknown>): TranscriptMessage | undefined {
  const message = raw.message;
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  const role = typeof record.role === "string" ? record.role : undefined;
  if (role !== "user" && role !== "assistant") return undefined;
  const body = textFromContent(record.content);
  if (!body.trim()) return undefined;
  return {
    role,
    text: body,
    at: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
    stopReason: typeof record.stopReason === "string" ? record.stopReason : undefined,
  };
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
