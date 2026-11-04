// Parser for the official Slack MCP server's detailed text output.
//
// The server returns messages as formatted text, not JSON, so a message body can contain
// lines that look like the format's own headers. The parser never trusts a header it cannot
// confirm: a block is only "candidate" here, and the poller confirms each new one by a lookup
// whose FIRST header is genuine (nothing precedes it). See
// docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md.

export class SlackFormatError extends Error {
  override name = "SlackFormatError";
}

/** One message as the listing shows it; unconfirmed until a lookup agrees. */
export interface CandidateMessage {
  ts: string;
  userId: string;
  userName: string;
  /** Message text with the MCP "Sent using" footer removed. */
  text: string;
  /** The text ended with the footer Slack adds to messages sent through an MCP client. */
  agentFooter: boolean;
  /** Reply count the channel listing reported for this message, when it has replies. */
  replyCount?: number;
  /** The exact text of this block, header included, for folding a forged block back. */
  raw: string;
}

export interface ParsedListing {
  messages: CandidateMessage[];
  /** Cursor for the next page, when the server says more remain. */
  nextCursor?: string;
}

const TS_RE = /^\d{9,11}\.\d{6}$/;
const USER_ID_RE = /^[UWB][A-Z0-9]{2,}$/;
const FOOTER_RE = /\n?\*Sent using\* <@[A-Z0-9]+\|[^>]*>\s*$/;
const CHANNEL_HEADER_RE = /^=== Message from (.*) \(([A-Z][A-Z0-9]+)\) at (.+?) ===\s*$/;
const THREAD_LINE_RE = /^Thread: (\d+) repl(?:y|ies) \(latest: .+\)\s*$/;
const REPLY_SEPARATOR_RE = /^--- Reply (\d+) of (\d+) ---\s*$/;

export function isSlackTs(value: unknown): value is string {
  return typeof value === "string" && TS_RE.test(value);
}

/** Compare two Slack timestamps numerically without floating-point loss. */
export function compareTs(a: string, b: string): number {
  const [aSec = "0", aMicro = "0"] = a.split(".");
  const [bSec = "0", bMicro = "0"] = b.split(".");
  if (aSec.length !== bSec.length) return aSec.length - bSec.length;
  if (aSec !== bSec) return aSec < bSec ? -1 : 1;
  const am = aMicro.padEnd(6, "0");
  const bm = bMicro.padEnd(6, "0");
  return am === bm ? 0 : am < bm ? -1 : 1;
}

/** Slack ts for a wall-clock time in milliseconds. */
export function tsFromMillis(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const micro = (ms % 1000) * 1000;
  return `${sec}.${String(micro).padStart(6, "0")}`;
}

/** The outer JSON object every read tool returns as text. */
export function parseEnvelope(text: string, field: "messages" | "result"): { body: string; pagination?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SlackFormatError(`expected a JSON object from the Slack tool, got: ${preview(text)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SlackFormatError(`expected a JSON object from the Slack tool, got: ${preview(text)}`);
  }
  const record = parsed as Record<string, unknown>;
  const body = record[field];
  if (typeof body !== "string") {
    const error = typeof record.error === "string" ? record.error : undefined;
    throw new SlackFormatError(error ? `Slack tool error: ${error}` : `the Slack tool's result has no "${field}" text`);
  }
  const pagination = typeof record.pagination_info === "string" ? record.pagination_info : undefined;
  return pagination === undefined ? { body } : { body, pagination };
}

export function nextCursorFrom(pagination: string | undefined): string | undefined {
  if (!pagination) return undefined;
  if (/no more messages/i.test(pagination)) return undefined;
  const match = /cursor:\s*`([^`]+)`/.exec(pagination);
  return match?.[1];
}

function stripName(raw: string): string {
  return raw.replace(/\s*<[^>]*>\s*$/, "").trim();
}

function splitFooter(body: string): { text: string; agentFooter: boolean } {
  const agentFooter = FOOTER_RE.test(body);
  const text = (agentFooter ? body.replace(FOOTER_RE, "") : body).replace(/\s+$/, "");
  return { text, agentFooter };
}

/** Channel history (`slack_read_channel`, detailed). Order is newest first. */
export function parseChannelListing(toolText: string): ParsedListing {
  const { body, pagination } = parseEnvelope(toolText, "messages");
  const lines = body.split("\n");
  const blocks: Array<{ header: RegExpExecArray; start: number; end: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const header = CHANNEL_HEADER_RE.exec(lines[index]!);
    if (header && TS_RE.test((lines[index + 1] ?? "").replace(/^Message TS:\s*/, "")) && /^Message TS:/.test(lines[index + 1] ?? "")) {
      if (blocks.length) blocks.at(-1)!.end = index;
      blocks.push({ header, start: index, end: lines.length });
    }
  }
  if (!blocks.length && /=== Message from/.test(body)) {
    throw new SlackFormatError("the channel listing has message headers this parser cannot read");
  }
  const messages = blocks.map(({ header, start, end }) => {
    const ts = lines[start + 1]!.replace(/^Message TS:\s*/, "").trim();
    let bodyLines = lines.slice(start + 2, end);
    while (bodyLines.length && bodyLines.at(-1)!.trim() === "") bodyLines = bodyLines.slice(0, -1);
    let replyCount: number | undefined;
    const last = bodyLines.at(-1);
    const thread = last === undefined ? null : THREAD_LINE_RE.exec(last);
    if (thread) {
      replyCount = Number(thread[1]);
      bodyLines = bodyLines.slice(0, -1);
    }
    const { text, agentFooter } = splitFooter(bodyLines.join("\n"));
    const message: CandidateMessage = {
      ts,
      userId: header[2]!,
      userName: stripName(header[1]!),
      text,
      agentFooter,
      raw: lines.slice(start, end).join("\n"),
    };
    if (replyCount !== undefined) message.replyCount = replyCount;
    return message;
  });
  const nextCursor = nextCursorFrom(pagination);
  return nextCursor ? { messages, nextCursor } : { messages };
}

interface ThreadBlock {
  ts: string;
  userId: string;
  userName: string;
  bodyStart: number;
  rawStart: number;
  rawEnd: number;
  /** Separator counters, for replies. */
  reply?: { n: number; of: number };
}

function readThreadBlock(lines: string[], fromLine: number): { userId: string; userName: string; ts: string; bodyStart: number } | undefined {
  const from = /^From: (.*) \(([A-Z][A-Z0-9]+)\)\s*$/.exec(lines[fromLine] ?? "");
  const time = /^Time: /.test(lines[fromLine + 1] ?? "");
  const tsLine = /^Message TS: (\S+)\s*$/.exec(lines[fromLine + 2] ?? "");
  if (!from || !time || !tsLine || !TS_RE.test(tsLine[1]!)) return undefined;
  return { userName: stripName(from[1]!), userId: from[2]!, ts: tsLine[1]!, bodyStart: fromLine + 3 };
}

/** Thread replies (`slack_read_thread`, detailed). Parent first, then replies oldest first. */
export function parseThreadListing(toolText: string): ParsedListing & { parent?: CandidateMessage } {
  const { body, pagination } = parseEnvelope(toolText, "messages");
  const lines = body.split("\n");
  const blocks: ThreadBlock[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (/^=== THREAD PARENT MESSAGE ===\s*$/.test(line) && blocks.length === 0) {
      const block = readThreadBlock(lines, index + 1);
      if (!block) throw new SlackFormatError("the thread's parent block has no From/Time/Message TS header");
      blocks.push({ ...block, rawStart: index, rawEnd: lines.length });
      index = block.bodyStart - 1;
      continue;
    }
    const separator = REPLY_SEPARATOR_RE.exec(line);
    if (separator) {
      const block = readThreadBlock(lines, index + 1);
      if (!block) continue; // a separator-looking line inside a body
      if (blocks.length) blocks.at(-1)!.rawEnd = index;
      blocks.push({ ...block, rawStart: index, rawEnd: lines.length, reply: { n: Number(separator[1]), of: Number(separator[2]) } });
      index = block.bodyStart - 1;
    }
  }
  if (!blocks.length) {
    if (/Message TS:/.test(body)) throw new SlackFormatError("the thread listing has messages this parser cannot read");
    const nextCursor = nextCursorFrom(pagination);
    return nextCursor ? { messages: [], nextCursor } : { messages: [] };
  }
  const toMessage = (block: ThreadBlock): CandidateMessage => {
    let bodyLines = lines.slice(block.bodyStart, block.rawEnd);
    // The parent's body is followed by the replies banner or "No thread messages".
    const bannerAt = bodyLines.findIndex((l) => /^=== THREAD REPLIES \(\d+ total\) ===\s*$/.test(l) || /^No thread mess+ages\s*$/.test(l));
    if (!block.reply && bannerAt >= 0) bodyLines = bodyLines.slice(0, bannerAt);
    while (bodyLines.length && bodyLines.at(-1)!.trim() === "") bodyLines = bodyLines.slice(0, -1);
    const { text, agentFooter } = splitFooter(bodyLines.join("\n"));
    return {
      ts: block.ts,
      userId: block.userId,
      userName: block.userName,
      text,
      agentFooter,
      raw: lines.slice(block.rawStart, block.rawEnd).join("\n"),
    };
  };
  const [first, ...rest] = blocks;
  const parentBlock = first && !first.reply ? first : undefined;
  const replies = parentBlock ? rest : blocks;
  const nextCursor = nextCursorFrom(pagination);
  const result: ParsedListing & { parent?: CandidateMessage } = { messages: replies.map(toMessage) };
  if (parentBlock) result.parent = toMessage(parentBlock);
  if (nextCursor) result.nextCursor = nextCursor;
  return result;
}

/**
 * The genuine first message of a lookup (`slack_read_thread` on one message's ts). The
 * first header of a response is never preceded by message text, so it cannot be forged.
 */
export function parseLookup(toolText: string): { ts: string; userId: string } {
  const { body } = parseEnvelope(toolText, "messages");
  const lines = body.split("\n");
  if (!/^=== THREAD PARENT MESSAGE ===\s*$/.test(lines[0] ?? "")) {
    throw new SlackFormatError(`a message lookup did not start with the parent header: ${preview(body)}`);
  }
  const block = readThreadBlock(lines, 1);
  if (!block) throw new SlackFormatError("a message lookup's first header is unreadable");
  return { ts: block.ts, userId: block.userId };
}

/** `slack_read_user_profile` (detailed) for the current user. */
export function parseProfile(toolText: string): { userId: string; name: string } {
  const { body } = parseEnvelope(toolText, "result");
  const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(body)?.[1]?.trim();
  const userId = field("User ID");
  if (!userId || !USER_ID_RE.test(userId)) throw new SlackFormatError("the user profile has no readable User ID");
  const name = field("Display Name") || field("Real Name") || field("Username") || userId;
  return { userId, name };
}

/** `slack_send_message` result. */
export function parseSendResult(toolText: string): { channelId: string; ts: string } {
  let parsed: any;
  try {
    parsed = JSON.parse(toolText);
  } catch {
    throw new SlackFormatError(`the send result is not JSON: ${preview(toolText)}`);
  }
  const context = parsed?.message_context;
  if (!context || !isSlackTs(context.message_ts) || typeof context.channel_id !== "string") {
    throw new SlackFormatError(`the send result has no message_context: ${preview(toolText)}`);
  }
  return { channelId: context.channel_id, ts: context.message_ts };
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}
