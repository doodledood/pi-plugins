// Turns a raw read into confirmed new messages and a safe checkpoint.
//
// Holds docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md for reading: the
// listing is used only to learn which message ids are new. Each new id is first checked to belong
// to the watched conversation (a read that succeeds without it is the only evidence that an id is
// not real), then looked up on its own — a lookup's first header is genuine, since no message
// text precedes it — and its author and text come from that lookup, never from the listing. So
// text imitating the server's format can neither invent a message, put words under another
// author, nor pull in a message from elsewhere. A failed check or lookup throws: the read point
// stays where it was, and the message is read again later, never dropped.
// The checkpoint stays a little behind the read's start, so a message Slack makes visible late
// is still read, and it moves past everything settled, so reads stay short.
import { BackendError, type SlackBackend } from "./backend.ts";
import type { Conversation } from "./conversation.ts";
import { compareTs, isSlackTs, tsFromMillis } from "./format.ts";

export interface SlackMessage {
  ts: string;
  userId: string;
  userName: string;
  text: string;
  agentFooter: boolean;
}

export interface ReadPoint {
  /** Exclusive lower bound: everything at or before it was handled. */
  checkpoint: string | undefined;
  /** Settled timestamps newer than the checkpoint (delivered or rejected), so a re-read skips them. */
  seen: string[];
}

export interface ReadOutcome {
  fresh: SlackMessage[];
  next: ReadPoint;
  /** Ids the listing showed that are not genuine messages of this conversation. */
  forged: number;
  /** New ids left for the next poll because of the per-poll confirmation cap. */
  deferred: number;
}

/** How far behind the read's start the checkpoint stays, to absorb late visibility and clock skew. */
export const CHECKPOINT_LAG_MS = 2 * 60 * 1000;
/** How far past the read's start an id may be and still be kept as seen (clock skew, not forgery). */
export const FUTURE_HORIZON_MS = 60 * 60 * 1000;
/** New messages confirmed per poll (two Slack reads each), to stay well inside Slack's read allowance. */
export const MAX_CONFIRMATIONS_PER_POLL = 15;

export async function readNew(
  backend: SlackBackend,
  conversation: Conversation,
  point: ReadPoint,
  readStartedAtMs: number,
): Promise<ReadOutcome> {
  const candidates = await backend.readSince(conversation, point.checkpoint);
  const seen = new Set(point.seen);
  const isNew = (ts: string) => (!point.checkpoint || compareTs(ts, point.checkpoint) > 0) && !seen.has(ts);
  const ids = [...new Set(candidates.map((c) => c.ts))].filter((ts) => {
    if (!isSlackTs(ts)) throw new Error(`unreadable message id "${ts}"`);
    return isNew(ts);
  }).sort(compareTs);

  const now = ids.slice(0, MAX_CONFIRMATIONS_PER_POLL);
  const fresh: SlackMessage[] = [];
  const settled: string[] = [];
  let forged = 0;
  for (const ts of now) {
    if (!(await backend.belongsTo(conversation, ts))) {
      forged += 1;
      settled.push(ts);
      continue;
    }
    const genuine = await backend.lookupMessage(conversation.channelId, ts);
    if (genuine.ts !== ts) throw new BackendError(`looking up message ${ts} returned message ${genuine.ts}`, "unreadable");
    fresh.push({ ts, userId: genuine.userId, userName: genuine.userName, text: genuine.text, agentFooter: genuine.agentFooter });
    settled.push(ts);
  }
  const firstDeferred = ids[now.length];
  return { fresh, next: advance(point, settled, readStartedAtMs, firstDeferred), forged, deferred: ids.length - now.length };
}

/**
 * Move the checkpoint past every settled id older than the lag, but never up to an id still
 * waiting for confirmation; keep the newer settled ones in `seen`.
 */
export function advance(point: ReadPoint, settledNow: readonly string[], readStartedAtMs: number, firstUnsettled?: string): ReadPoint {
  const cap = tsFromMillis(Math.max(0, readStartedAtMs - CHECKPOINT_LAG_MS));
  const all = [...new Set([...point.seen, ...settledNow])].sort(compareTs);
  let checkpoint = point.checkpoint;
  for (const ts of all) {
    if (compareTs(ts, cap) > 0) break;
    if (firstUnsettled && compareTs(ts, firstUnsettled) >= 0) break;
    if (!checkpoint || compareTs(ts, checkpoint) > 0) checkpoint = ts;
  }
  // An id far in the future is no message yet: text named it. It is not kept, so `seen` stays
  // bounded; if a listing names it again before the checkpoint passes that text, it is rejected again.
  const horizon = tsFromMillis(readStartedAtMs + FUTURE_HORIZON_MS);
  const seen = all.filter((ts) => (!checkpoint || compareTs(ts, checkpoint) > 0) && compareTs(ts, horizon) <= 0);
  return { checkpoint, seen };
}
