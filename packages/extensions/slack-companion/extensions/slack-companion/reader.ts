// Turns a raw read into confirmed new messages and a safe checkpoint.
//
// Holds docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md for reading:
// a block is delivered only if a lookup of its ts returns the same author (the first header
// of a lookup is genuine, since no message text precedes it). A block that fails is message
// text that imitated the format, so its raw text is folded back into the message it sits in.
// The checkpoint never moves past the moment the read began, so a forged future ts cannot
// make a later real message look already seen.
import type { SlackBackend } from "./backend.ts";
import type { Conversation } from "./conversation.ts";
import { type CandidateMessage, compareTs, isSlackTs, tsFromMillis } from "./format.ts";

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
  /** Delivered timestamps newer than the checkpoint, so a re-read does not repeat them. */
  seen: string[];
}

export interface ReadOutcome {
  fresh: SlackMessage[];
  next: ReadPoint;
  /** Blocks that imitated the format and were folded back into their message. */
  forged: number;
}

/** How far behind the read's start the checkpoint stays, to absorb clock skew. */
export const CHECKPOINT_LAG_MS = 2 * 60 * 1000;

export async function readNew(
  backend: SlackBackend,
  conversation: Conversation,
  point: ReadPoint,
  readStartedAtMs: number,
): Promise<ReadOutcome> {
  const candidates = await backend.readSince(conversation, point.checkpoint);
  const seen = new Set(point.seen);
  const isNew = (ts: string) => (!point.checkpoint || compareTs(ts, point.checkpoint) > 0) && !seen.has(ts);

  const kept: Array<SlackMessage & { raw: string }> = [];
  const taken = new Set<string>();
  let forged = 0;
  let previous: (SlackMessage & { raw: string }) | undefined;
  for (const candidate of candidates) {
    if (!isSlackTs(candidate.ts)) throw new Error(`unreadable message id "${candidate.ts}"`);
    if (!isNew(candidate.ts)) {
      previous = undefined;
      continue;
    }
    const genuine = !taken.has(candidate.ts) && (await confirm(backend, conversation.channelId, candidate));
    if (!genuine) {
      forged += 1;
      // The block is text inside the message before it; give that text back.
      if (previous) previous.text = `${previous.text}\n${candidate.raw}`;
      continue;
    }
    taken.add(candidate.ts);
    previous = { ts: candidate.ts, userId: candidate.userId, userName: candidate.userName, text: candidate.text, agentFooter: candidate.agentFooter, raw: candidate.raw };
    kept.push(previous);
  }

  const fresh = kept
    .map(({ raw: _raw, ...message }) => message)
    .sort((a, b) => compareTs(a.ts, b.ts));
  return { fresh, next: advance(point, fresh, readStartedAtMs), forged };
}

async function confirm(backend: SlackBackend, channelId: string, candidate: CandidateMessage): Promise<boolean> {
  const found = await backend.lookup(channelId, candidate.ts);
  return found !== "missing" && found.ts === candidate.ts && found.userId === candidate.userId;
}

/** Move the checkpoint up to the newest delivered message, but never past the read's start. */
export function advance(point: ReadPoint, delivered: readonly SlackMessage[], readStartedAtMs: number): ReadPoint {
  const cap = tsFromMillis(Math.max(0, readStartedAtMs - CHECKPOINT_LAG_MS));
  let checkpoint = point.checkpoint;
  for (const message of delivered) {
    if (compareTs(message.ts, cap) > 0) continue;
    if (!checkpoint || compareTs(message.ts, checkpoint) > 0) checkpoint = message.ts;
  }
  const seen = [...new Set([...point.seen, ...delivered.map((m) => m.ts)])]
    .filter((ts) => !checkpoint || compareTs(ts, checkpoint) > 0)
    .sort(compareTs);
  return { checkpoint, seen };
}
