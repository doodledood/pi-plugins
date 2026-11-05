// A watched conversation is one direct message's top level or one thread — never a whole
// channel (CONTEXT.md: Watched conversation).
import { isSlackTs } from "./format.ts";

export type Conversation =
  | { kind: "thread"; channelId: string; threadTs: string }
  | { kind: "dm-top"; channelId: string };

export function conversationKey(conversation: Conversation): string {
  return conversation.kind === "thread"
    ? `${conversation.channelId}/${conversation.threadTs}`
    : `${conversation.channelId}/top`;
}

/** Direct-message channel ids start with D; everything else is a channel or group. */
export function isDirectMessage(channelId: string): boolean {
  return channelId.startsWith("D");
}

/** A person's user id, which a send may use as its channel to reach the direct message with them. */
export function isUserId(id: string): boolean {
  return /^[UW]/.test(id);
}

export interface ParsedLink {
  channelId: string;
  messageTs: string;
  threadTs?: string;
}

/** `https://<workspace>.slack.com/archives/<channel>/p<ts without dot>[?thread_ts=<ts>]`. */
export function parseSlackLink(link: string): ParsedLink | undefined {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return undefined;
  }
  if (!/(^|\.)slack\.com$/.test(url.hostname)) return undefined;
  const match = /^\/archives\/([A-Z0-9]+)\/p(\d{16})\/?$/.exec(url.pathname);
  if (!match) return undefined;
  const digits = match[2]!;
  const messageTs = `${digits.slice(0, 10)}.${digits.slice(10)}`;
  const threadTs = url.searchParams.get("thread_ts") ?? undefined;
  if (threadTs !== undefined && !isSlackTs(threadTs)) return undefined;
  return threadTs ? { channelId: match[1]!, messageTs, threadTs } : { channelId: match[1]!, messageTs };
}

/**
 * The conversations a send by the session takes part in (the one routing rule, see
 * docs/adr/20261104-start-watching-when-the-session-messages-someone.md): a reply belongs to its
 * thread; a new message lives in its own thread, and in a direct message the top level too,
 * where people often answer.
 */
export function conversationsForSend(send: { channelId: string; ts?: string; threadTs?: string }): Conversation[] {
  if (send.threadTs) return [{ kind: "thread", channelId: send.channelId, threadTs: send.threadTs }];
  const out: Conversation[] = [];
  if (send.ts) out.push({ kind: "thread", channelId: send.channelId, threadTs: send.ts });
  if (isDirectMessage(send.channelId)) out.push({ kind: "dm-top", channelId: send.channelId });
  return out;
}

/** The conversations a message link names: its thread, and a direct message's top level when the link is top-level. */
export function conversationsForLink(link: ParsedLink): Conversation[] {
  return conversationsForSend({ channelId: link.channelId, ts: link.messageTs, ...(link.threadTs ? { threadTs: link.threadTs } : {}) });
}
