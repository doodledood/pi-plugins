// The companion's state and behavior, independent of Pi's wiring so it can be driven in tests.
//
// One owner of state: everything below changes only through Engine methods, and each change is
// persisted as one snapshot (only when something changed; the snapshot keeps what a restart needs,
// each part bounded). Slack input can only narrow what
// happens (docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md): approvals are
// created from a helper's hand-off but resolved only through approve()/deny(), which only the
// owner's panel calls; nothing read from Slack resolves, removes or hides one.
import { randomUUID } from "node:crypto";
import { BackendError, FAILURE_HINTS, isPassingFailure, SendUncertainError, type Identity, type SlackBackend } from "./backend.ts";
import type { SlackCompanionConfig } from "./config.ts";
import { type Conversation, conversationKey, conversationsForLink, conversationsForSend, isDirectMessage, type ParsedLink } from "./conversation.ts";
import { type HelperBatch, type HelperOutcome, MAX_HELPER_TURNS } from "./helper.ts";
import type { LockHolder, LockManager } from "./locks.ts";
import { approvedNote, deniedNote, firstLine, markMessage, neutralize, ownerWords, waitingNote } from "./messages.ts";
import { compareTs, tsFromMillis } from "./format.ts";
import { readNew, type ReadPoint, type SlackMessage } from "./reader.ts";
import { findSecretShape, stripControl } from "./secrets.ts";
import { triageInput, type TriageInput } from "./triage.ts";

export type WatchStatus = "active" | "paused" | "stopped" | "error";

/**
 * Who a kept message came from, as the engine judged it when it read it (and corrected by markOwn
 * when it later learns a post was this session's): this session (main or its helper), another
 * agent of the owner's (another Pi session, or another tool posting as him), someone else's agent,
 * the owner by hand, or a person.
 */
export type Origin = "this session" | "owner's other agent" | "someone's agent" | "owner" | "person";
const ORIGINS: readonly Origin[] = ["this session", "owner's other agent", "someone's agent", "owner", "person"];

export interface ContextMessage extends SlackMessage {
  origin: Origin;
}

export interface WatchState {
  key: string;
  conversation: Conversation;
  startedBy: "send" | "attach";
  status: WatchStatus;
  reason?: string;
  point: ReadPoint;
  /** Messages this session posted here, by ts. */
  ownPosts: string[];
  /** Recent messages, the session's own included, for the helper's and the triage call's context. */
  context: ContextMessage[];
  /** Confirmed messages from others not handled yet. */
  inbox: SlackMessage[];
  sendsWithoutOwner: number;
  lastActivityAt: number;
  lastNote?: string;
  agentLineSent: boolean;
  /** Today's spend; `lifted` when the owner resumed past the cap for the rest of the day. */
  spend: { day: string; usd: number; lifted?: boolean };
  /** The first other person seen here: who a direct message is with, or who a thread is with. */
  partner?: { userId: string; name: string };
  /** At a DM's top level: was the latest agent post there this session's? */
  lastAgentPostOurs?: boolean;
  /** When this watch (re)started; an earlier "stop" is history, not a request to stop now. */
  since: string;
  /** When it last ended, for the owner's count of stops not yet seen. */
  endedAt?: number;
  /** Why it is paused. Owner input lifts only a send-limit pause; a spend-cap pause waits for the owner's resume. */
  pause?: "sendLimit" | "spendCap";
  /**
   * A reply the helper wrote while the watch was paused: sent as written on resume, never written
   * again; unless a rejoin read finds another session's post after `through`, the newest message it
   * answers, which drops it.
   */
  held?: { reply: string; through?: string };
  /** Reads in a row that failed for a reason that may pass; the watch stops at MAX_READ_FAILURES. */
  readFailures?: number;
  /** What happened lately, newest last, for the panel. */
  activity?: Array<{ at: number; text: string }>;
  /** A channel's name once read ("" when the server shows none); unset for direct messages. */
  channelName?: string;
  /** A post through someone else's agent was seen and the owner told; told once per conversation. */
  agentPostSeen?: boolean;
  /** Waiting messages dropped since the waiting list was last answered: the note shows this total. */
  droppedWaiting?: number;
  /**
   * This session took the conversation (back) after a gap: a restore, or watching again. Another
   * of the owner's sessions may have answered there meanwhile, so nothing is answered (a held
   * reply neither) until a read has caught up, and what waits from before such a session's post
   * is left to it. The number counts the reads so far; see MAX_REJOIN_READS.
   */
  rejoining?: number;
}

export interface Approval {
  id: string;
  watchKey: string;
  label: string;
  requester: string;
  text: string;
  at: number;
  status: "pending" | "approved" | "denied";
  resolvedAt?: number;
}

/** A send not settled yet. Settled sends leave the ledger: their ids live on in the watch's ownPosts. */
export interface LedgerEntry {
  id: string;
  watchKey: string;
  text: string;
  at: number;
  status: "sending" | "sent" | "uncertain" | "failed";
  ts?: string;
  /** Who the message speaks for: the owner's approval or decline note, or (unset) the helper. */
  by?: "owner";
}

export interface EngineState {
  version: typeof STATE_VERSION;
  autoStart: boolean;
  owner?: Identity;
  watches: WatchState[];
  approvals: Approval[];
  ledger: LedgerEntry[];
  tombstones: string[];
  /** Direct-message channel of each user id the session sent to by user id. */
  dmChannels: Record<string, string>;
  /** Error stops the owner has seen in the panel (by ui's errorId), so they stay seen across a reload. */
  seenErrors?: string[];
}

export type SendOutcome = "sent" | "paused" | "blocked" | "revoked" | "uncertain" | "failed";

/**
 * Bumped when a persisted field is removed, renamed or changes meaning, or a new one is required;
 * a snapshot of another version is not restored. An added optional field needs no bump: an older
 * snapshot simply lacks it.
 */
export const STATE_VERSION = 3 as const;
const MAX_CONTEXT = 12;
/** Characters of one message kept in the persisted context. */
const MAX_CONTEXT_TEXT = 1000;
/** Characters of a resolved request kept for the panel. */
const MAX_RESOLVED_TEXT = 400;
const MAX_ACTIVITY = 5;
/** Owner lines checked when attaching, to find the owner's last genuine message in a thread. */
const BOUNDARY_CHECKS = 25;
/** Messages waiting to be answered in one conversation; older ones beyond it stay as context only. */
const MAX_INBOX = 20;
/** Reads a rejoining watch waits for a read to catch up before it answers anyway (a burst that never ends). */
const MAX_REJOIN_READS = 5;
const DROPPED_NOTE = /^\d+ older dropped; /;
const AGENT_POSTS_NOTE = /^(an|\d+) agent posts? not answered; /;
/** Characters of a waiting message kept. */
const MAX_INBOX_TEXT = 4000;
/** Requests from one conversation that may wait for the owner at once. */
const MAX_PENDING_PER_WATCH = 10;
/** Reads in a row that may fail for a passing reason before the watch stops. */
export const MAX_READ_FAILURES = 5;
const MAX_OWN_POSTS = 200;
/** Main's sends kept for matching by text until read back (see mainSendsUnrecorded). */
const MAX_UNRECORDED_SENDS = 20;
const MAX_LEDGER = 100;
/** Stops remembered: a stopped conversation stays stopped across the last this many stops. */
export const MAX_TOMBSTONES = 1000;
const MAX_ENDED_WATCHES = 20;
const MAX_RESOLVED_APPROVALS = 10;
const MAX_DM_CHANNELS = 200;
const MAX_SEEN_ERRORS = 100;

export type RestoreOutcome = { ok: true } | { ok: false; keptRequests: number; lostWatches: string[]; autoStart: boolean };

export function emptyState(): EngineState {
  return { version: STATE_VERSION, autoStart: true, watches: [], approvals: [], ledger: [], tombstones: [], dmChannels: {} };
}

/**
 * A persisted snapshot, checked before it is trusted: entries come from the session file, which
 * another build of the package may have written. Anything unexpected is not restored.
 */
export function parseEngineState(data: unknown): EngineState | undefined {
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (d.version !== STATE_VERSION || typeof d.autoStart !== "boolean") return undefined;
  if (![d.watches, d.approvals, d.ledger, d.tombstones].every(Array.isArray) || !d.dmChannels || typeof d.dmChannels !== "object") return undefined;
  if (!(d.watches as unknown[]).every(watchOk) || !(d.approvals as unknown[]).every(approvalOk)) return undefined;
  return structuredClone(data) as EngineState;
}

/**
 * What a snapshot that cannot be restored still holds for the owner: the requests waiting on him,
 * every stop (so a stopped conversation does not restart), whether automatic starts were on (off
 * when unreadable: the owner turns them back on), and which watches were lost.
 */
export function salvageState(data: unknown): { approvals: Approval[]; tombstones: string[]; autoStart: boolean; lostWatches: string[] } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const approvals = (Array.isArray(d.approvals) ? d.approvals : []).filter(approvalOk).filter((a) => a.status === "pending");
  const tombstones = (Array.isArray(d.tombstones) ? d.tombstones : []).filter((t): t is string => typeof t === "string");
  const lostWatches = (Array.isArray(d.watches) ? d.watches : [])
    .filter((w: any) => w && (w.status === "active" || w.status === "paused"))
    .map((w: any) => (typeof w?.partner?.name === "string" ? clean(w.partner.name) : "a conversation"));
  return { approvals: structuredClone(approvals), tombstones, autoStart: d.autoStart === true, lostWatches };
}

function watchOk(w: any): boolean {
  return Boolean(w && typeof w.key === "string" && w.conversation && typeof w.conversation.channelId === "string"
    && typeof w.since === "string" && w.point && Array.isArray(w.point.seen) && Array.isArray(w.ownPosts) && Array.isArray(w.context) && Array.isArray(w.inbox)
    && w.context.every((m: any) => m && ORIGINS.includes(m.origin))
    && (w.held === undefined || (typeof w.held?.reply === "string" && (w.held.through === undefined || typeof w.held.through === "string"))));
}

function approvalOk(a: any): a is Approval {
  return Boolean(a && typeof a.id === "string" && typeof a.text === "string" && typeof a.label === "string"
    && typeof a.watchKey === "string" && typeof a.requester === "string" && typeof a.at === "number"
    && (a.resolvedAt === undefined || typeof a.resolvedAt === "number")
    && ["pending", "approved", "denied"].includes(a.status));
}

/** A display name or message from Slack, as the package keeps it: no terminal control sequences, no package markers. */
function clean(text: string): string {
  return neutralize(stripControl(text));
}

export function isLive(watch: Pick<WatchState, "status">): boolean {
  return watch.status === "active" || watch.status === "paused";
}

export function pendingApprovals(state: Pick<EngineState, "approvals">, watchKey?: string): Approval[] {
  return state.approvals.filter((a) => a.status === "pending" && (!watchKey || a.watchKey === watchKey));
}

/** Why this session may not watch a conversation, for a notice or a stop reason. */
function lockTaken(lock: { holder: LockHolder } | { damaged: true }): string {
  return "holder" in lock
    ? `another Pi session (pid ${lock.holder.pid}) answers this conversation`
    : "this conversation's lock file cannot be read yet (another Pi session may be taking it); try again in a minute";
}

/** The mark after a person's name that says a conversation is a direct message. */
export const DM_MARK = "(DM)";

/** A direct message as the owner sees it: the person and the mark, or, before the name is known, what it is. The one place it is spelled. */
export function dmLabel(name: string | undefined): string {
  return name ? `${name} ${DM_MARK}` : "a direct message";
}

/** How the owner sees a conversation: who it is with first, then where; a raw id only when no name is known. */
export function watchLabel(watch: Pick<WatchState, "conversation" | "partner" | "channelName">): string {
  const { conversation, partner } = watch;
  if (isDirectMessage(conversation.channelId)) return dmLabel(partner?.name);
  const where = watch.channelName ? `#${watch.channelName}` : `#${conversation.channelId}`;
  return partner ? `${threadOf(partner.name)}${where}` : `a thread in ${where}`;
}

/** The one spelling of "a person's thread in" before a channel. */
export function threadOf(person: string): string {
  return `${person}'s thread in `;
}

export interface EngineDeps {
  backend: SlackBackend;
  config: () => SlackCompanionConfig;
  now: () => number;
  persist: (state: EngineState) => void;
  notify: (level: "info" | "warning" | "error", text: string) => void;
  changed: () => void;
  /** Hand information to main as the senders' words. */
  deliverInfo: (input: { watch: WatchState; senders: SlackMessage[]; text: string }) => void;
  /** Hand an approved action to main. */
  deliverApproved: (input: { approval: Approval; ownerName: string }) => void;
  /** Should the agent speak on this batch? Cheap model; records its own cost. */
  triage: (input: TriageInput) => Promise<{ speak: boolean; usd: number }>;
  runHelper: (input: { watch: WatchState; batch: HelperBatch; signal: AbortSignal }) => Promise<HelperOutcome & { usd: number }>;
  locks: LockManager;
}

export function isStopMessage(text: string): boolean {
  return text.trim().toLowerCase() === "stop";
}

/** What the line and panel say after a send, by its outcome. */
const NOTE_FOR: Record<SendOutcome, (reply: string) => string> = {
  sent: (reply) => (reply ? `helper replied: ${firstLine(reply, 60)}` : "helper asked you to approve"),
  paused: () => "helper's reply held until you resume",
  blocked: () => "helper's reply blocked: it looked like a secret",
  revoked: () => "conversation ended before the helper replied",
  uncertain: () => "helper's reply may not have gone out; checking",
  failed: () => "helper's reply did not go out",
};

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Only the owner restarts a conversation someone stopped; the model-callable tool may not. */
export class StoppedConversationError extends Error {
  override name = "StoppedConversationError";
  constructor() {
    super("Someone stopped that conversation. Only the owner can watch it again: /slack <link>, or w in the Slack panel.");
  }
}

export class Engine {
  private state: EngineState = emptyState();
  private lastPersisted = "";
  private readonly running = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  private readonly inFlightSends = new Set<string>();
  /**
   * Messages main is sending, or sent with a result that named no message, by their marked text:
   * read back before their ts is known, they are this session's own, not another session's.
   */
  private readonly mainSendsUnrecorded = new Map<string, { text: string; channelId: string; threadTs?: string }>();
  private polling: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: EngineDeps) {}

  snapshot(): EngineState {
    return structuredClone(this.state);
  }

  /** Is a helper answering in this conversation right now? */
  isAnswering(key: string): boolean {
    return this.running.has(key);
  }

  /**
   * Restore a persisted snapshot. One that cannot be trusted (another version, or damaged) is not
   * restored, but the requests waiting on the owner in it are kept, and the watches lost are named.
   */
  restore(data: unknown): RestoreOutcome {
    if (data === undefined) return { ok: true };
    const state = parseEngineState(data);
    if (!state) {
      const { approvals, tombstones, autoStart, lostWatches } = salvageState(data);
      this.state = { ...emptyState(), approvals, tombstones, autoStart };
      this.save();
      return { ok: false, keptRequests: approvals.length, lostWatches, autoStart };
    }
    this.state = { ...emptyState(), ...state };
    this.lastPersisted = JSON.stringify(this.state);
    for (const watch of this.liveWatches()) {
      const lock = this.deps.locks.acquire(watch.key);
      if (!lock.ok) this.end(watch, "error", lockTaken(lock), false, { lockLost: true });
      else watch.rejoining = 0; // closed for a while: another session may have answered meanwhile
    }
    this.save();
    return { ok: true };
  }

  /** Persist only when something changed, so idle polls add nothing to the session file. */
  private save(): void {
    if (this.disposed) return;
    this.prune();
    const serialized = JSON.stringify(this.state);
    if (serialized === this.lastPersisted) return;
    this.lastPersisted = serialized;
    this.deps.persist(structuredClone(this.state));
    this.deps.changed();
  }

  private prune(): void {
    const ended = this.state.watches.filter((w) => !isLive(w));
    if (ended.length > MAX_ENDED_WATCHES) {
      const drop = new Set(ended.slice(0, ended.length - MAX_ENDED_WATCHES).map((w) => w.key));
      this.state.watches = this.state.watches.filter((w) => !drop.has(w.key));
    }
    for (const a of this.state.approvals) if (a.status !== "pending" && a.text.length > MAX_RESOLVED_TEXT) a.text = `${a.text.slice(0, MAX_RESOLVED_TEXT)}…`;
    const resolved = this.state.approvals.filter((a) => a.status !== "pending");
    if (resolved.length > MAX_RESOLVED_APPROVALS) {
      const drop = new Set(resolved.slice(0, resolved.length - MAX_RESOLVED_APPROVALS).map((a) => a.id));
      this.state.approvals = this.state.approvals.filter((a) => !drop.has(a.id));
    }
    this.state.ledger = this.state.ledger.filter((e) => e.status === "sending" || e.status === "uncertain").slice(-MAX_LEDGER);
    this.state.tombstones = this.state.tombstones.slice(-MAX_TOMBSTONES);
    if (this.state.seenErrors && this.state.seenErrors.length > MAX_SEEN_ERRORS) this.state.seenErrors = this.state.seenErrors.slice(-MAX_SEEN_ERRORS);
    const dm = Object.entries(this.state.dmChannels);
    if (dm.length > MAX_DM_CHANNELS) this.state.dmChannels = Object.fromEntries(dm.slice(-MAX_DM_CHANNELS));
  }

  /** The owner saw these error stops in the panel. */
  markErrorsSeen(ids: readonly string[]): void {
    const seen = new Set(this.state.seenErrors ?? []);
    const fresh = ids.filter((id) => !seen.has(id));
    if (!fresh.length) return;
    this.state.seenErrors = [...seen, ...fresh];
    this.save();
  }

  liveWatches(): WatchState[] {
    return this.state.watches.filter(isLive);
  }

  watch(key: string): WatchState | undefined {
    return this.state.watches.find((w) => w.key === key);
  }

  /** The owner, asked of Slack once and kept. */
  async owner(): Promise<Identity> {
    if (!this.state.owner) {
      this.state.owner = await this.deps.backend.whoAmI();
      this.save();
    }
    return this.state.owner;
  }

  setAutoStart(on: boolean): void {
    this.state.autoStart = on;
    this.save();
  }

  isTombstoned(key: string): boolean {
    return this.state.tombstones.includes(key);
  }

  /** The DM channel for a send addressed to a user id, once a send has revealed it. */
  channelFor(channelId: string): string {
    return this.state.dmChannels[channelId] ?? channelId;
  }

  /** Would a send by main to this place go into a watched conversation, or start one? */
  sendWillBeWatched(channelId: string, threadTs: string | undefined): boolean {
    const channel = this.channelFor(channelId);
    const conversations = conversationsForSend({ channelId: channel, ...(threadTs ? { threadTs } : {}) });
    if (conversations.some((c) => { const w = this.watch(conversationKey(c)); return w !== undefined && isLive(w); })) return true;
    if (!this.state.autoStart) return false;
    // A reply goes into its thread, unless that thread was stopped; a new message starts its own thread.
    return threadTs ? !this.isTombstoned(conversationKey({ kind: "thread", channelId: channel, threadTs })) : true;
  }

  /** Was the agent line already sent where this send goes? */
  agentLineSentFor(channelId: string, threadTs: string | undefined): boolean {
    const channel = this.channelFor(channelId);
    const keys = threadTs ? [conversationKey({ kind: "thread", channelId: channel, threadTs })] : isDirectMessage(channel) ? [conversationKey({ kind: "dm-top", channelId: channel })] : [];
    return keys.some((key) => this.watch(key)?.agentLineSent === true);
  }

  /**
   * Main is about to send this marked text to a channel (or a user id, for a direct message) and
   * perhaps a thread. Kept even when the result is an error: the message may have gone out anyway.
   */
  mainSendStarting(callId: string, send: { text: string; channelId: string; threadTs?: string }): void {
    this.mainSendsUnrecorded.set(callId, { ...send, text: send.text.trim() });
    // Results that never name their message stay until read back; keep only the latest few.
    while (this.mainSendsUnrecorded.size > MAX_UNRECORDED_SENDS) this.mainSendsUnrecorded.delete(this.mainSendsUnrecorded.keys().next().value!);
  }

  /** Main's send named its message (onMainSend records it): it no longer needs matching by text. */
  mainSendRecorded(callId: string): void {
    this.mainSendsUnrecorded.delete(callId);
  }

  /**
   * Is this owner post one of this session's own whose ts is not recorded yet: main's send still
   * running or whose result named no message, or a helper or owner-note send not settled yet?
   */
  private ownUnrecorded(watch: WatchState, raw: SlackMessage): "main" | "tracked" | undefined {
    const text = raw.text.trim();
    for (const [callId, sent] of this.mainSendsUnrecorded) {
      if (sent.text !== text || !this.sendReadHere(watch, sent, raw.ts)) continue;
      this.mainSendsUnrecorded.delete(callId);
      return "main";
    }
    // A tracked send settles by its own result or by reconcile, which then records the ts (reconcile
    // looks for a ts it does not know yet, so it is not recorded here).
    return this.state.ledger.some((e) => e.watchKey === watch.key && (e.status === "sending" || e.status === "uncertain") && e.text.trim() === text) ? "tracked" : undefined;
  }

  /**
   * Could main's send show up in this watch as the post `ts`? In its channel (a user id names the
   * direct message with that person, once known, or a direct message whose person is not known
   * yet); in its thread when it named one; else at the top level, or as the first message of the
   * thread it starts.
   */
  private sendReadHere(watch: WatchState, sent: { channelId: string; threadTs?: string }, ts: string): boolean {
    const { conversation } = watch;
    const channel = this.channelFor(sent.channelId);
    const sameChannel = channel === conversation.channelId
      || (channel === sent.channelId && /^[UW]/.test(sent.channelId) && isDirectMessage(conversation.channelId) && (watch.partner?.userId ?? sent.channelId) === sent.channelId);
    if (!sameChannel) return false;
    if (sent.threadTs) return conversation.kind === "thread" && conversation.threadTs === sent.threadTs;
    return conversation.kind !== "thread" || conversation.threadTs === ts;
  }

  /**
   * Record that the post `ts` is this session's own: in ownPosts and, when the message is kept, in
   * its origin. The one place both change, so they never disagree.
   */
  private markOwn(watch: WatchState, ts: string): void {
    if (!watch.ownPosts.includes(ts)) watch.ownPosts = [...watch.ownPosts, ts].slice(-MAX_OWN_POSTS);
    const kept = watch.context.find((m) => m.ts === ts);
    if (kept) kept.origin = "this session";
  }

  /** Main sent a message (any route). Start or continue watching, and remember the post. */
  async onMainSend(input: { channelId: string; ts: string; threadTs?: string; addressedTo?: string; text?: string }): Promise<void> {
    if (this.disposed) return;
    if (input.addressedTo && input.addressedTo !== input.channelId) this.state.dmChannels[input.addressedTo] = input.channelId;
    for (const conversation of conversationsForSend(input)) {
      const key = conversationKey(conversation);
      let watch = this.watch(key);
      if (!watch || !isLive(watch)) {
        if (!this.state.autoStart || this.isTombstoned(key)) continue;
        watch = this.startWatch(conversation, "send", input.ts);
        if (!watch) continue;
      }
      this.markOwn(watch, input.ts);
      watch.agentLineSent = true;
      watch.lastAgentPostOurs = true;
      watch.lastActivityAt = this.deps.now();
      // What the session asked, so the triage call and the helper know what a reply answers.
      if (input.text && !watch.context.some((m) => m.ts === input.ts)) {
        const self = this.state.owner;
        // Kept as main wrote it: the marker and the agent line are the package's, not its words.
        this.remember(watch, { ts: input.ts, userId: self?.userId ?? "self", userName: self?.name ?? "the owner's agent", text: ownerWords(input.text, this.deps.config().marker), agentFooter: true, origin: "this session" });
      }
    }
    this.save();
  }

  /** Start watching, or return the live watch already there. */
  private startWatch(conversation: Conversation, startedBy: "send" | "attach", fromTs: string | undefined): WatchState | undefined {
    const key = conversationKey(conversation);
    const existing = this.watch(key);
    if (existing && isLive(existing)) return existing;
    if (this.disposed) return undefined;
    const lock = this.deps.locks.acquire(key);
    if (!lock.ok) {
      this.deps.notify("warning", `Slack: not watching ${watchLabel({ conversation })} here: ${lockTaken(lock)}.`);
      return undefined;
    }
    const watch: WatchState = {
      key,
      conversation,
      startedBy,
      status: "active",
      point: { checkpoint: fromTs, seen: [] },
      ownPosts: [],
      context: [],
      inbox: [],
      sendsWithoutOwner: 0,
      lastActivityAt: this.deps.now(),
      agentLineSent: false,
      spend: { day: dayOf(this.deps.now()), usd: 0 },
      // A send-started watch begins at its own message; an attached one at this moment, so a
      // "stop" written before the owner attached is history.
      since: startedBy === "send" && fromTs ? fromTs : tsFromMillis(this.deps.now()),
      ...(existing?.channelName !== undefined ? { channelName: existing.channelName } : {}),
    };
    // Who it is with: known from an earlier watch here, or from another watch in the same DM.
    const sibling = isDirectMessage(conversation.channelId) ? this.state.watches.find((w) => w.conversation.channelId === conversation.channelId && w.partner) : undefined;
    const partner = existing?.partner ?? sibling?.partner;
    if (partner) watch.partner = partner;
    this.state.watches = [...this.state.watches.filter((w) => w.key !== key), watch];
    return watch;
  }

  /**
   * `/slack <link>` or the watch tool: hand the unanswered part of someone else's conversation to
   * a helper. The part starts after the owner's last message there, confirmed like any message
   * read (it belongs to the thread, its lookup names the owner, it is not in the future); a forged
   * owner line is skipped, and with no confirmed one the whole thread is the unanswered part.
   */
  async attach(link: ParsedLink, options: { byOwner: boolean }): Promise<WatchState | undefined> {
    if (this.disposed) return undefined;
    if (!options.byOwner && this.isStoppedLink(link)) throw new StoppedConversationError();
    // Read Slack for every conversation first; then decide and start them all with no await in
    // between, so a stop that lands while Slack is read refuses the whole attach, not part of it.
    const plans: Array<{ conversation: Conversation; from: string | undefined }> = [];
    for (const conversation of conversationsForLink(link)) {
      const existing = this.watch(conversationKey(conversation));
      if (existing && isLive(existing)) continue;
      const from = conversation.kind === "thread" ? await this.ownerBoundary(conversation) : link.messageTs;
      plans.push({ conversation, from });
    }
    if (this.disposed) return undefined; // the session ended while Slack was read: take no lock
    if (!options.byOwner && this.isStoppedLink(link)) throw new StoppedConversationError();
    let primary: WatchState | undefined;
    for (const conversation of conversationsForLink(link)) {
      const key = conversationKey(conversation);
      const plan = plans.find((p) => conversationKey(p.conversation) === key);
      if (!plan) {
        primary ??= this.watch(key);
        continue;
      }
      this.state.tombstones = this.state.tombstones.filter((t) => t !== key);
      primary ??= this.startWatch(conversation, "attach", plan.from);
    }
    this.save();
    await this.readSoon();
    return primary;
  }


  /** The owner's last genuine message in a thread, checked like any message read; at most a few candidates are checked. */
  private async ownerBoundary(conversation: Extract<Conversation, { kind: "thread" }>): Promise<string | undefined> {
    const owner = await this.owner();
    const nowTs = tsFromMillis(this.deps.now());
    const listed = await this.deps.backend.readSince(conversation, undefined);
    // Newest first, at most BOUNDARY_CHECKS checked: forged owner lines cost a check each and are skipped.
    const candidates = [...listed].reverse().filter((m) => m.userId === owner.userId && compareTs(m.ts, nowTs) <= 0).slice(0, BOUNDARY_CHECKS);
    for (const candidate of candidates) {
      if (!(await this.deps.backend.belongsTo(conversation, candidate.ts))) continue;
      const genuine = await this.deps.backend.lookupMessage(conversation.channelId, candidate.ts);
      if (genuine.ts === candidate.ts && genuine.userId === owner.userId) return candidate.ts;
    }
    if (candidates.length === BOUNDARY_CHECKS) {
      this.deps.notify("warning", `Slack: could not confirm your last reply in ${watchLabel({ conversation })}; the helper sees the whole thread.`);
    }
    return undefined;
  }

  /** Did someone stop a conversation this link names (so only the owner may restart it)? */
  isStoppedLink(link: ParsedLink): boolean {
    return conversationsForLink(link).some((c) => this.isTombstoned(conversationKey(c)));
  }

  /** Stop the conversations a link names (the watch tool's stop). */
  stopLink(link: ParsedLink, reason: string): boolean {
    let stopped = false;
    for (const conversation of conversationsForLink(link)) {
      const watch = this.watch(conversationKey(conversation));
      if (watch && isLive(watch)) {
        this.end(watch, "stopped", reason, true);
        stopped = true;
      }
    }
    this.save();
    return stopped;
  }

  /** Owner typed in main: counts reset, and watches paused for the send limit resume. */
  ownerInput(): void {
    if (this.disposed) return;
    for (const watch of this.liveWatches()) {
      watch.sendsWithoutOwner = 0;
      if (watch.status === "paused" && watch.pause === "sendLimit") {
        watch.status = "active";
        delete watch.reason;
        delete watch.pause;
      }
    }
    this.save();
    for (const watch of this.liveWatches()) this.schedule(watch);
  }

  /** The owner's resume. A spend-cap pause is lifted for the rest of the day: resuming is the owner's OK to spend. */
  resume(key: string): void {
    const watch = this.watch(key);
    if (!watch || watch.status !== "paused") return;
    if (watch.pause === "spendCap") watch.spend.lifted = true;
    watch.status = "active";
    watch.sendsWithoutOwner = 0;
    delete watch.reason;
    delete watch.pause;
    this.note(watch, "resumed by you");
    this.save();
    this.schedule(watch);
  }

  /** Watch an ended conversation again, from where it stopped reading. */
  rewatch(key: string): void {
    const watch = this.watch(key);
    if (!watch || isLive(watch)) return;
    const lock = this.deps.locks.acquire(key);
    if (!lock.ok) {
      this.deps.notify("warning", `Slack: cannot watch ${watchLabel(watch)} again: ${lockTaken(lock)}.`);
      return;
    }
    this.state.tombstones = this.state.tombstones.filter((t) => t !== key);
    watch.status = "active";
    watch.sendsWithoutOwner = 0;
    watch.lastActivityAt = this.deps.now();
    watch.since = tsFromMillis(this.deps.now());
    delete watch.reason;
    delete watch.readFailures;
    // Ended for a while: read before answering what waited, in case another session answered it.
    watch.rejoining = 0;
    this.note(watch, "watching again");
    this.save();
    void this.readSoon();
  }

  stop(key: string, reason = "stopped by you"): void {
    const watch = this.watch(key);
    if (watch && isLive(watch)) this.end(watch, "stopped", reason, true);
    this.save();
  }

  stopAll(): void {
    for (const watch of this.liveWatches()) this.end(watch, "stopped", "stopped by you", true);
    this.save();
  }

  /**
   * End a watch. Only an explicit stop (the owner's, or someone's "stop") keeps the conversation
   * from restarting on a later send; a quiet end, a finished conversation or an error does not.
   * Waiting approvals stay waiting: only the owner resolves them.
   */
  private end(watch: WatchState, status: "stopped" | "error", reason: string, explicit: boolean, options: { lockLost?: boolean } = {}): void {
    watch.status = status;
    watch.reason = stripControl(reason);
    watch.endedAt = this.deps.now();
    // A stop with an error keeps what was waiting: watching again (w) answers it. Not after a lock
    // loss: the session that took over may answer them, and a later read here cannot tell; they
    // are dropped, and the owner is told how many and from whom.
    if (options.lockLost && watch.inbox.length) {
      const people = [...new Set(watch.inbox.map((m) => m.userName))].join(", ");
      const count = watch.inbox.length;
      this.deps.notify("warning", `Slack: ${count} message${count === 1 ? "" : "s"} waiting in ${watchLabel(watch)} (from ${people}) ${count === 1 ? "was" : "were"} not answered here: another Pi session took the conversation over. Check them in Slack.`);
    }
    if (status === "stopped" || options.lockLost) watch.inbox = [];
    delete watch.rejoining;
    delete watch.pause;
    delete watch.readFailures;
    // A conversation that ended quietly keeps what the panel needs, not its conversation; one that
    // stopped with an error keeps its context, since it is usually watched again (w).
    if (status === "stopped") {
      const root = watch.conversation.kind === "thread" ? watch.conversation.threadTs : undefined;
      watch.context = watch.context.filter((m) => m.ts === root);
      // The kept root stays this session's own when it was (watching again reads it as such).
      watch.ownPosts = watch.ownPosts.filter((ts) => ts === root || !watch.point.checkpoint || compareTs(ts, watch.point.checkpoint) > 0);
    }
    if (watch.held) {
      delete watch.held;
      this.note(watch, "a held reply was not sent");
    }
    if (explicit && !this.state.tombstones.includes(watch.key)) this.state.tombstones.push(watch.key);
    this.running.get(watch.key)?.abort.abort();
    this.deps.locks.release(watch.key);
    if (status === "error" && !this.disposed) this.deps.notify("error", `Slack: stopped watching ${watchLabel(watch)}: ${watch.reason}. Open the panel (/slack) and press w to watch it again.`);
  }

  pendingApprovals(): Approval[] {
    return pendingApprovals(this.state);
  }

  /** Only the owner calls this, from the panel. */
  async approve(id: string): Promise<void> {
    const approval = this.state.approvals.find((a) => a.id === id && a.status === "pending");
    if (!approval || this.disposed) return;
    approval.status = "approved";
    approval.resolvedAt = this.deps.now();
    const owner = await this.owner();
    const watch = this.watch(approval.watchKey);
    if (watch) {
      watch.sendsWithoutOwner = 0;
      this.note(watch, `you approved: ${firstLine(approval.text, 60)}`);
    }
    this.save();
    this.deps.deliverApproved({ approval, ownerName: owner.name });
    if (watch && isLive(watch)) {
      await this.sendTracked(watch, approvedNote(owner.name, approval.text), { fromOwner: true });
      this.save();
    }
  }

  async deny(id: string): Promise<void> {
    const approval = this.state.approvals.find((a) => a.id === id && a.status === "pending");
    if (!approval || this.disposed) return;
    approval.status = "denied";
    approval.resolvedAt = this.deps.now();
    const watch = this.watch(approval.watchKey);
    if (watch) {
      watch.sendsWithoutOwner = 0;
      this.note(watch, `you declined: ${firstLine(approval.text, 60)}`);
    }
    this.save();
    if (watch && isLive(watch)) {
      await this.sendTracked(watch, deniedNote((await this.owner()).name, approval.text), { fromOwner: true });
      this.save();
    }
  }

  /**
   * Read now, for a watch that just started or came back: a pass already running listed its
   * watches before, so wait for it, then read. A failure is told to the owner, never left unhandled
   * (Pi exits on an unhandled rejection).
   */
  private async readSoon(): Promise<void> {
    try {
      if (this.polling) await this.polling.catch(() => undefined);
      await this.poll();
    } catch (error) {
      if (!this.disposed) this.deps.notify("error", `Slack: reading failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Read every watch once; start helpers where a batch waits. Overlapping calls share one pass. */
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    // The pass is stored before its body runs and cleared only if it is still the stored one: a
    // pass that finished without awaiting anything must not leave itself behind as "running".
    const pass = this.pollPass();
    this.polling = pass;
    const clear = () => {
      if (this.polling === pass) this.polling = undefined;
    };
    pass.then(clear, clear); // callers awaiting the pass still see its error
    return pass;
  }

  private async pollPass(): Promise<void> {
    for (const watch of this.liveWatches()) {
      if (this.disposed) return;
      // It may have ended while an earlier watch was read (its helper finished, or the owner stopped it).
      if (!isLive(watch)) continue;
      if (!this.deps.locks.holds(watch.key)) {
        this.end(watch, "error", "another Pi session took this conversation over", false, { lockLost: true });
        this.save();
        continue;
      }
      await this.pollWatch(watch);
    }
  }

  /** Wait for running helpers. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((r) => r.promise));
  }

  dispose(): void {
    this.disposed = true;
    for (const run of this.running.values()) run.abort.abort();
    for (const watch of this.liveWatches()) this.deps.locks.release(watch.key);
  }

  private async pollWatch(watch: WatchState): Promise<void> {
    if (this.disposed || !isLive(watch)) return;
    const startedAt = this.deps.now();
    let owner: Identity;
    try {
      owner = await this.owner();
      await this.reconcile(watch);
      if (!isDirectMessage(watch.conversation.channelId) && watch.channelName === undefined) {
        watch.channelName = (await this.deps.backend.channelName(watch.conversation.channelId)) ?? "";
      }
      const outcome = await readNew(this.deps.backend, watch.conversation, watch.point, startedAt);
      if (this.disposed || !isLive(watch)) return;
      watch.point = outcome.next;
      if (watch.readFailures) {
        delete watch.readFailures;
        this.note(watch, "reading again");
      }
      if (outcome.forged) {
        this.note(watch, `skipped ${outcome.forged} unconfirmed message id${outcome.forged === 1 ? "" : "s"}`);
        this.deps.notify("warning", `Slack: in ${watchLabel(watch)}, ${outcome.forged} message id${outcome.forged === 1 ? " was" : "s were"} not found in the conversation and skipped (deleted, or text imitating Slack's format).`);
      }
      this.ingest(watch, outcome.fresh, owner);
      // A rejoining watch answers once a read has caught up: a post from another of the owner's
      // sessions, still waiting to be read, may already answer what waits here.
      if (watch.rejoining !== undefined) {
        watch.rejoining += 1;
        if (outcome.deferred === 0 || watch.rejoining >= MAX_REJOIN_READS) delete watch.rejoining;
      }
      // Quiet only when this read found nothing new: what arrived while Pi was closed is read first.
      const quietMs = this.deps.config().quietHours * 3_600_000;
      if (isLive(watch) && !outcome.fresh.length && !watch.inbox.length && startedAt - watch.lastActivityAt > quietMs) {
        this.end(watch, "stopped", `no messages for ${this.deps.config().quietHours} h`, false);
      }
    } catch (error) {
      if (this.disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      // A failure that may pass (a rate limit, a dropped connection) leaves the read point as it
      // was and reads again next time; only repeated or lasting failures stop the watch.
      if (isPassingFailure(error) && (watch.readFailures ?? 0) + 1 < MAX_READ_FAILURES) {
        watch.readFailures = (watch.readFailures ?? 0) + 1;
        const code = error instanceof BackendError ? error.code : undefined;
        this.note(watch, code === "not_ready" ? "Slack is still starting; trying again" : `could not read Slack (${code ?? "error"}); trying again`);
        this.save();
        return;
      }
      const hint = error instanceof BackendError ? FAILURE_HINTS[error.code ?? ""] : undefined;
      const repeated = isPassingFailure(error) ? `Slack reads failed ${MAX_READ_FAILURES} times in a row; stopped so nothing is skipped` : undefined;
      this.end(watch, "error", `${hint ?? repeated ?? "Slack could not be read"} (${firstLine(message, 80)})`, false);
      this.save();
      return;
    }
    // A batch about to be handled is saved by the step that handles it (its save before a send
    // holds this read point), so the read itself appends nothing then.
    if (watch.status === "active" && watch.inbox.length && !this.running.has(watch.key)) this.deps.changed();
    else this.save();
    this.schedule(watch);
  }

  private ingest(watch: WatchState, fresh: SlackMessage[], owner: Identity): void {
    const own = new Set(watch.ownPosts);
    const queued = new Set(watch.inbox.map((m) => m.ts));
    const answeredElsewhere: SlackMessage[] = [];
    let heldAnsweredElsewhere = false;
    const marker = this.deps.config().marker;
    for (const raw of fresh) {
      // The owner's agents' posts are kept as main wrote them: the marker and agent line are the package's.
      const text = stripControl(raw.userId === owner.userId && raw.agentFooter ? ownerWords(raw.text, marker) : raw.text);
      const message: SlackMessage = { ...raw, userName: clean(raw.userName), text };
      watch.lastActivityAt = this.deps.now();
      const byOwner = raw.userId === owner.userId;
      const unrecorded = !own.has(message.ts) && byOwner ? this.ownUnrecorded(watch, raw) : undefined;
      const ownPost = own.has(message.ts) || unrecorded !== undefined;
      const origin: Origin = ownPost ? "this session" : byOwner ? (raw.agentFooter ? "owner's other agent" : "owner") : raw.agentFooter ? "someone's agent" : "person";
      this.remember(watch, { ...message, origin });
      if (unrecorded === "main") this.markOwn(watch, message.ts);
      // The owner or this session spoke after them: earlier agent posts are no longer waiting on him.
      if (origin === "owner" || origin === "this session") this.clearAgentPostsNote(watch);
      if (ownPost) {
        watch.lastAgentPostOurs = true;
        continue;
      }
      if (isStopMessage(message.text) && compareTs(message.ts, watch.since) > 0) {
        this.end(watch, "stopped", `${message.userName} said stop`, true);
        return;
      }
      // Another of the owner's agents posted it: context only, never answered. While this watch
      // rejoins after a gap, that session may have answered what waits here from before its post, so
      // that is left to it, and the owner is told. While this session held the conversation
      // throughout, no other session read it, and nothing is left.
      if (message.userId === owner.userId && message.agentFooter) {
        watch.lastAgentPostOurs = false;
        if (watch.rejoining !== undefined) {
          const before = watch.inbox.filter((m) => compareTs(m.ts, message.ts) < 0);
          if (before.length) {
            answeredElsewhere.push(...before);
            watch.inbox = watch.inbox.filter((m) => compareTs(m.ts, message.ts) > 0);
          }
          // A reply held for messages from before that post: that session may have answered them.
          if (watch.held?.through && compareTs(watch.held.through, message.ts) < 0) heldAnsweredElsewhere = true;
        }
        continue;
      }
      // Someone else's agent (a post with the agent footer under their name): context only, so two
      // agents never answer each other in a loop. One note counts those since the owner or this
      // session last spoke (the line shows it; the panel shows the post), and the owner is told
      // once per conversation.
      if (message.agentFooter) {
        const count = this.agentPostsSinceOwner(watch);
        this.note(watch, count === 1 ? "an agent post not answered; check it" : `${count} agent posts not answered; check them`, { replacing: AGENT_POSTS_NOTE });
        if (!watch.agentPostSeen) {
          watch.agentPostSeen = true;
          this.deps.notify("info", `Slack: in ${watchLabel(watch)}, ${message.userName}'s agent posted. Agent posts are not answered, so two agents never answer each other; answer it yourself if it needs you: "${firstLine(message.text, 80)}"`);
        }
        continue;
      }
      if (!watch.partner && message.userId !== owner.userId) this.setPartner(watch, { userId: message.userId, name: message.userName });
      if (queued.has(message.ts)) continue;
      if (watch.conversation.kind === "dm-top" && watch.lastAgentPostOurs === false) {
        // The person may be answering another session's question: tell the owner, do not guess.
        this.deps.notify("info", `Slack: ${message.userName} wrote at the top level of ${watchLabel(watch)} after another session's message; not answered here: "${firstLine(message.text, 80)}"`);
        continue;
      }
      const kept = message.text.length > MAX_INBOX_TEXT ? { ...message, text: `${message.text.slice(0, MAX_INBOX_TEXT)}…` } : message;
      watch.inbox = [...watch.inbox, kept];
      queued.add(message.ts);
    }
    if (heldAnsweredElsewhere) {
      delete watch.held;
      this.note(watch, "held reply dropped: another session answered");
      this.deps.notify("info", `Slack: the reply held in ${watchLabel(watch)} is not sent: while this session was away, another of your Pi sessions posted after the messages it answers. Check in Slack that they were answered.`);
    }
    if (answeredElsewhere.length) {
      const people = [...new Set(answeredElsewhere.map((m) => m.userName))].join(", ");
      const count = answeredElsewhere.length;
      this.note(watch, `left ${count} message${count === 1 ? "" : "s"} to another of your sessions; check them in Slack`);
      this.deps.notify("info", `Slack: ${count} message${count === 1 ? "" : "s"} in ${watchLabel(watch)} (from ${people}; latest: "${firstLine(answeredElsewhere.at(-1)!.text, 80)}") ${count === 1 ? "is" : "are"} not answered here: while this session was away, another of your Pi sessions posted after ${count === 1 ? "it" : "them"}. Check in Slack that ${count === 1 ? "it was" : "they were"} answered.`);
    }
    if (watch.inbox.length > MAX_INBOX) {
      // A busy conversation (while paused, or a backlog) could queue without end: the newest wait,
      // older ones are dropped, and one running total in the latest note says how many.
      watch.droppedWaiting = (watch.droppedWaiting ?? 0) + watch.inbox.length - MAX_INBOX;
      watch.inbox = watch.inbox.slice(-MAX_INBOX);
      const total = watch.droppedWaiting;
      const who = watch.status === "paused" ? `${MAX_INBOX} wait for you` : `the newest ${MAX_INBOX} go to the helper`;
      this.note(watch, `${total} older dropped; ${who}`, { replacing: DROPPED_NOTE });
    }
  }

  /**
   * Who a conversation is with. A direct message has one other person, so every watch in it (its
   * top level and its threads) takes the name the first of them learns.
   */
  private setPartner(watch: WatchState, partner: { userId: string; name: string }): void {
    watch.partner = partner;
    if (!isDirectMessage(watch.conversation.channelId)) return;
    for (const sibling of this.state.watches) {
      if (sibling.conversation.channelId === watch.conversation.channelId && !sibling.partner) sibling.partner = partner;
    }
  }

  /** Remove answered messages from the waiting list; once it is empty, the dropped count starts over. */
  private takeFromInbox(watch: WatchState, taken: ReadonlySet<string>): void {
    watch.inbox = watch.inbox.filter((m) => !taken.has(m.ts));
    if (!watch.inbox.length) delete watch.droppedWaiting;
  }

  /** Keep a message as context, its text cut to what a restart needs. */
  private remember(watch: WatchState, message: ContextMessage): void {
    const kept = message.text.length > MAX_CONTEXT_TEXT ? { ...message, text: `${message.text.slice(0, MAX_CONTEXT_TEXT)}…` } : message;
    watch.context = [...watch.context.filter((m) => m.ts !== message.ts), kept].slice(-MAX_CONTEXT);
  }

  /** Posts through someone else's agent kept since the owner or this session last spoke there. */
  private agentPostsSinceOwner(watch: WatchState): number {
    let count = 0;
    for (const m of [...watch.context].reverse()) {
      if (m.origin === "owner" || m.origin === "this session") break;
      if (m.origin === "someone's agent") count += 1;
    }
    return count;
  }

  /** Drop the agent-post count note: nothing it counted waits on the owner now. */
  private clearAgentPostsNote(watch: WatchState): void {
    const activity = (watch.activity ?? []).filter((entry) => !AGENT_POSTS_NOTE.test(entry.text));
    if (activity.length === (watch.activity ?? []).length) return;
    watch.activity = activity;
    if (watch.lastNote && AGENT_POSTS_NOTE.test(watch.lastNote)) {
      const previous = activity.at(-1)?.text;
      if (previous) watch.lastNote = previous;
      else delete watch.lastNote;
    }
  }

  /** What the helper did, for the line (last note) and the panel (the last few, with times). */
  private note(watch: WatchState, text: string, options: { replacing?: RegExp } = {}): void {
    const clean = stripControl(text);
    watch.lastNote = clean;
    // A running count replaces its previous entry, so it does not push out what the helper did.
    const previous = (watch.activity ?? []).filter((entry) => !options.replacing?.test(entry.text));
    watch.activity = [...previous, { at: this.deps.now(), text: clean }].slice(-MAX_ACTIVITY);
  }

  private schedule(watch: WatchState): void {
    if (this.disposed || watch.status !== "active" || (!watch.inbox.length && !watch.held) || this.running.has(watch.key)) return;
    if (watch.rejoining !== undefined) return; // a read catches up first
    const abort = new AbortController();
    const promise = this.process(watch, abort.signal)
      .catch((error) => {
        // A run this engine stopped (the watch ended, perhaps to be watched again) is not a failure.
        if (!this.disposed && !abort.signal.aborted && isLive(watch)) {
          this.end(watch, "error", `the helper failed: ${(error as Error).message}`, false);
          this.save();
        }
      })
      .finally(() => {
        this.running.delete(watch.key);
        this.deps.changed();
        // Messages that arrived while the helper ran form the next batch.
        if (!this.disposed && watch.status === "active" && (watch.inbox.length || watch.held)) this.schedule(watch);
      });
    this.running.set(watch.key, { promise, abort });
    this.deps.changed();
  }

  private overCap(watch: WatchState): boolean {
    const cap = this.deps.config().spendCapUsdPerDay;
    const today = dayOf(this.deps.now());
    if (watch.spend.day !== today) watch.spend = { day: today, usd: 0 };
    return cap !== undefined && !watch.spend.lifted && watch.spend.usd >= cap;
  }

  private async process(watch: WatchState, signal: AbortSignal): Promise<void> {
    if (watch.held) {
      // Written before the pause: sent as written, so its hand-offs and requests are not made twice.
      const held = watch.held.reply;
      const sent = await this.sendTracked(watch, held, { commit: () => { delete watch.held; } });
      // Every outcome but a pause settles the held reply (sent, blocked as secret-shaped, or the
      // conversation ended); keeping it would schedule the same attempt again without end.
      if (sent !== "paused") delete watch.held;
      if (sent === "paused" || this.disposed || signal.aborted || !isLive(watch)) {
        this.save();
        return;
      }
      this.note(watch, NOTE_FOR[sent](held));
      this.save();
      if (!watch.inbox.length) return;
    }
    const batch = [...watch.inbox];
    const taken = new Set(batch.map((m) => m.ts));
    const finish = (note: string) => {
      this.takeFromInbox(watch, taken);
      this.note(watch, note);
      this.save();
    };
    if (this.overCap(watch)) {
      watch.status = "paused";
      watch.pause = "spendCap";
      watch.reason = `spend cap of $${this.deps.config().spendCapUsdPerDay} reached today`;
      this.deps.notify("warning", `Slack: paused ${watchLabel(watch)}: ${watch.reason}`);
      this.save();
      return;
    }
    const owner = await this.owner();
    const ownPosts = new Set(watch.ownPosts);
    const addressed = isDirectMessage(watch.conversation.channelId) || batch.some((m) => m.text.includes(`<@${owner.userId}`));
    const triage = await this.deps.triage(triageInput({ label: watchLabel(watch), ownerName: owner.name, addressed, context: watch.context, ownPosts, batch }));
    if (this.disposed || signal.aborted || !isLive(watch)) return;
    watch.spend.usd += triage.usd;
    if (!triage.speak) {
      finish(`helper stayed silent on ${batch.length} message${batch.length === 1 ? "" : "s"}`);
      return;
    }
    const helperBatch: HelperBatch = {
      conversationLabel: watchLabel(watch),
      ownerName: owner.name,
      inChannel: !isDirectMessage(watch.conversation.channelId),
      context: watch.context.filter((m) => !taken.has(m.ts)),
      messages: batch,
      waitingApprovals: pendingApprovals(this.state, watch.key).map((a) => a.text),
      requestRoom: Math.max(0, MAX_PENDING_PER_WATCH - pendingApprovals(this.state, watch.key).length),
    };
    const outcome = await this.deps.runHelper({ watch, batch: helperBatch, signal });
    if (this.disposed || signal.aborted || !isLive(watch)) return;
    watch.spend.usd += outcome.usd;
    if (outcome.stoppedAtTurnLimit) this.deps.notify("warning", `Slack: the helper in ${watchLabel(watch)} was stopped after ${MAX_HELPER_TURNS} turns.`);
    const newRequests: string[] = [];
    for (const handoff of outcome.handoffs) {
      if (handoff.kind === "info") {
        this.deps.deliverInfo({ watch, senders: batch, text: handoff.text });
      } else if (pendingApprovals(this.state, watch.key).length >= MAX_PENDING_PER_WATCH) {
        this.deps.notify("warning", `Slack: ${watchLabel(watch)} already has ${MAX_PENDING_PER_WATCH} requests waiting for you; a new one was not added.`);
      } else {
        const requester = [...new Set(batch.map((m) => m.userName))].join(", ");
        const text = stripControl(handoff.text);
        this.state.approvals.push({ id: randomUUID(), watchKey: watch.key, label: watchLabel(watch), requester, text, at: this.deps.now(), status: "pending" });
        newRequests.push(text);
        this.deps.notify("info", `Slack: ${requester} asked for something that needs your OK — open the panel (/slack) to approve or deny.`);
      }
    }
    const parts = [outcome.reply?.text, newRequests.length ? waitingNote(owner.name, newRequests) : undefined].filter((p): p is string => Boolean(p));
    if (!parts.length) {
      finish(newRequests.length ? "helper asked you to approve" : outcome.handoffs.length ? "helper told your session" : "helper stayed silent");
      return;
    }
    const reply = parts.join("\n\n");
    const sent = await this.sendTracked(watch, reply, { commit: () => { this.takeFromInbox(watch, taken); } });
    if (this.disposed || signal.aborted) {
      // Stopped during the send (and perhaps watched again since): this run's step is settled by
      // the commit; it must not end, note or finish a watch that is no longer its own.
      this.save();
      return;
    }
    if (sent === "paused") {
      // The batch is handled; only its reply waits, and goes out as written on resume.
      const through = batch.at(-1)?.ts;
      watch.held = { reply, ...(through ? { through } : {}) };
      finish("helper's reply held until you resume");
      return;
    }
    finish(NOTE_FOR[sent](outcome.reply?.text ?? ""));
    if (outcome.reply?.done && sent === "sent") {
      this.end(watch, "stopped", "the helper finished this conversation", false);
      this.save();
    }
  }

  /**
   * The only way the package posts: marked, thread-bound, secret-checked, counted before it goes,
   * and recorded. A note the owner's own action caused (approved, declined) is not held by a pause
   * and does not count toward it.
   */
  async sendTracked(watch: WatchState, text: string, options: { fromOwner?: boolean; commit?: () => void } = {}): Promise<SendOutcome> {
    if (this.disposed || !isLive(watch)) return "revoked";
    const config = this.deps.config();
    const shape = findSecretShape(text);
    if (shape) {
      this.deps.notify("warning", `Slack: did not send ${options.fromOwner ? "your note" : "a reply"} in ${watchLabel(watch)}: it contained something shaped like a ${shape}.`);
      return "blocked";
    }
    if (!options.fromOwner) {
      if (watch.status === "paused") return "paused";
      // Reserve the slot before awaiting anything, so concurrent sends cannot pass the limit.
      if (watch.sendsWithoutOwner >= config.pauseAfterSends) {
        this.pauseForLimit(watch);
        this.save();
        return "paused";
      }
      watch.sendsWithoutOwner += 1;
    }
    const owner = await this.owner();
    const marked = markMessage(text, config.marker, owner.name, !watch.agentLineSent);
    const entry: LedgerEntry = { id: randomUUID(), watchKey: watch.key, text: marked, at: this.deps.now(), status: "sending", ...(options.fromOwner ? { by: "owner" as const } : {}) };
    // The step this send completes is recorded in the same save as the send itself, so a crash
    // during the send is settled by reconcile and the step is never redone.
    options.commit?.();
    this.state.ledger.push(entry);
    this.inFlightSends.add(entry.id);
    this.save();
    const threadTs = watch.conversation.kind === "thread" ? watch.conversation.threadTs : undefined;
    try {
      const { ts } = await this.deps.backend.send(watch.conversation.channelId, marked, threadTs);
      entry.status = "sent";
      entry.ts = ts;
      this.markOwn(watch, ts);
      watch.agentLineSent = true;
      watch.lastAgentPostOurs = true;
    } catch (error) {
      entry.status = error instanceof SendUncertainError ? "uncertain" : "failed";
      if (!this.disposed) this.deps.notify("warning", `Slack: ${options.fromOwner ? "your note" : "a reply"} in ${watchLabel(watch)} may not have gone out (${(error as Error).message}); it will be checked, not re-sent.`);
    } finally {
      this.inFlightSends.delete(entry.id);
    }
    if (!options.fromOwner && watch.sendsWithoutOwner >= config.pauseAfterSends) this.pauseForLimit(watch);
    // No save here: the caller saves once its step is done. The save before the send already holds
    // the ledger entry, so a crash in between is settled by reconcile, never by sending again.
    return entry.status === "sent" ? "sent" : entry.status === "uncertain" ? "uncertain" : "failed";
  }

  private pauseForLimit(watch: WatchState): void {
    if (watch.status !== "active") return;
    watch.status = "paused";
    watch.pause = "sendLimit";
    const sent = `${watch.sendsWithoutOwner} message${watch.sendsWithoutOwner === 1 ? "" : "s"} without you`;
    watch.reason = `sent ${sent}`;
    this.deps.notify("info", `Slack: paused ${watchLabel(watch)} after ${sent}. Open the panel (/slack) to resume.`);
  }

  /** A send whose outcome is unknown is settled by reading the conversation, never by sending again. */
  private async reconcile(watch: WatchState): Promise<void> {
    const pending = this.state.ledger.filter((e) => e.watchKey === watch.key && !this.inFlightSends.has(e.id) && (e.status === "uncertain" || e.status === "sending"));
    if (!pending.length) return;
    const owner = await this.owner();
    // Everything after the checkpoint: a send made after the last read is in there, whatever the clocks say.
    const messages = await this.deps.backend.readSince(watch.conversation, watch.point.checkpoint);
    const known = new Set(watch.ownPosts);
    // A listed match is confirmed like any message read: it belongs here and its lookup names the owner.
    const confirmed = async (ts: string, text: string) => {
      if (!(await this.deps.backend.belongsTo(watch.conversation, ts))) return false;
      const genuine = await this.deps.backend.lookupMessage(watch.conversation.channelId, ts);
      return genuine.userId === owner.userId && genuine.text.trim() === text.trim();
    };
    for (const entry of pending) {
      let found: (typeof messages)[number] | undefined;
      for (const m of messages) {
        if (m.userId === owner.userId && !known.has(m.ts) && m.text.trim() === entry.text.trim() && (await confirmed(m.ts, entry.text))) {
          found = m;
          break;
        }
      }
      if (found) {
        known.add(found.ts);
        entry.status = "sent";
        entry.ts = found.ts;
        this.markOwn(watch, found.ts);
        this.note(watch, entry.by === "owner" ? "your note went out" : "helper's reply went out");
      } else {
        entry.status = "failed";
        this.note(watch, `${entry.by === "owner" ? "your note" : "helper's reply"} did not go out; not sent again`);
        this.deps.notify("warning", `Slack: ${entry.by === "owner" ? "your note" : "a reply"} in ${watchLabel(watch)} did not go out; it was not re-sent.`);
      }
    }
  }
}

