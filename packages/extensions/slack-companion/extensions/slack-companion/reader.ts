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
  /** Delivered timestamps newer than the checkpoint, so a re-read skips them. */
  seen: string[];
  /**
   * Ids a listing named that are not messages of this conversation, newer than the checkpoint,
   * newest kept: a re-read skips them without checking or reporting them again (a thread's first
   * message is listed on every read, so a forged id in it would otherwise come back every poll).
   */
  rejected?: string[];
}

export interface ReadOutcome {
  fresh: SlackMessage[];
  next: ReadPoint;
  /** Ids the listing showed, for the first time, that are not genuine messages of this conversation. */
  forged: number;
  /** New ids left for the next poll because of the per-poll confirmation cap. */
  deferred: number;
}

/** How far behind the read's start the checkpoint stays, to absorb late visibility and clock skew. */
export const CHECKPOINT_LAG_MS = 2 * 60 * 1000;
/** Rejected ids a conversation may name at once; more stops the watch (lasting). */
export const MAX_REJECTED = 500;
/**
 * New messages confirmed per poll, so one poll stays near 30 Slack reads, well inside Slack's read
 * allowance: each costs two reads (membership, lookup); a thread adds one read per session that
 * confirms the server marks an empty read.
 */
export const MAX_CONFIRMATIONS_PER_POLL = 15;

export async function readNew(
  backend: SlackBackend,
  conversation: Conversation,
  point: ReadPoint,
  readStartedAtMs: number,
): Promise<ReadOutcome> {
  const candidates = await backend.readSince(conversation, point.checkpoint);
  const seen = new Set(point.seen);
  const rejectedBefore = new Set(point.rejected ?? []);
  const isNew = (ts: string) => (!point.checkpoint || compareTs(ts, point.checkpoint) > 0) && !seen.has(ts) && !rejectedBefore.has(ts);
  const ids = [...new Set(candidates.map((c) => c.ts))].filter((ts) => {
    if (!isSlackTs(ts)) throw new Error(`unreadable message id "${ts}"`);
    return isNew(ts);
  }).sort(compareTs);

  const now = ids.slice(0, MAX_CONFIRMATIONS_PER_POLL);
  const fresh: SlackMessage[] = [];
  const delivered: string[] = [];
  const rejected: string[] = [];
  for (const ts of now) {
    if (!(await backend.belongsTo(conversation, ts))) {
      rejected.push(ts);
      continue;
    }
    const genuine = await backend.lookupMessage(conversation.channelId, ts);
    if (genuine.ts !== ts) throw new BackendError(`looking up message ${ts} returned message ${genuine.ts}`, "unreadable");
    fresh.push({ ts, userId: genuine.userId, userName: genuine.userName, text: genuine.text, agentFooter: genuine.agentFooter });
    delivered.push(ts);
  }
  const firstDeferred = ids[now.length];
  const next = advance(point, delivered, rejected, readStartedAtMs, firstDeferred, new Set(candidates.map((c) => c.ts)));
  // Text can name any number of ids that do not exist; past the bound, stop rather than check them in turns forever.
  if ((next.rejected?.length ?? 0) > MAX_REJECTED) {
    throw new BackendError(`this conversation names more than ${MAX_REJECTED} message ids that do not exist`, "too_many_ids");
  }
  return { fresh, next, forged: rejected.length, deferred: ids.length - now.length };
}

/**
 * Move the checkpoint past every settled id (delivered or rejected) older than the lag, but never
 * up to an id still waiting for confirmation. Newer delivered ids stay in `seen`, newer rejected
 * ones in `rejected` (bounded); both are dropped once the checkpoint passes them.
 */
export function advance(point: ReadPoint, deliveredNow: readonly string[], rejectedNow: readonly string[], readStartedAtMs: number, firstUnsettled?: string, listed?: ReadonlySet<string>): ReadPoint {
  const cap = tsFromMillis(Math.max(0, readStartedAtMs - CHECKPOINT_LAG_MS));
  const delivered = [...new Set([...point.seen, ...deliveredNow])];
  const rejected = [...new Set([...(point.rejected ?? []), ...rejectedNow])];
  let checkpoint = point.checkpoint;
  for (const ts of [...new Set([...delivered, ...rejected])].sort(compareTs)) {
    if (compareTs(ts, cap) > 0) break;
    if (firstUnsettled && compareTs(ts, firstUnsettled) >= 0) break;
    if (!checkpoint || compareTs(ts, checkpoint) > 0) checkpoint = ts;
  }
  const after = (ts: string) => !checkpoint || compareTs(ts, checkpoint) > 0;
  // A rejected id is kept while a listing still names it (an edit that removes the text lets it go).
  const keptRejected = rejected.filter(after).filter((ts) => !listed || listed.has(ts) || rejectedNow.includes(ts));
  return { checkpoint, seen: delivered.filter(after).sort(compareTs), ...(keptRejected.length ? { rejected: keptRejected } : {}) };
}
