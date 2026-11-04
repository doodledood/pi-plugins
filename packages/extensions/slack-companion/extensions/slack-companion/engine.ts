// The companion's state and behavior, independent of Pi's wiring so it can be driven in tests.
//
// One owner of state: everything below changes only through Engine methods, and each change is
// persisted as one snapshot (only when something changed). Slack input can only narrow what
// happens (docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md): approvals are
// created from a helper's hand-off but resolved only through approve()/deny(), which only the
// owner's panel calls; nothing read from Slack resolves, removes or hides one.
import { randomUUID } from "node:crypto";
import { BackendNotReadyError, SendUncertainError, type Identity, type SlackBackend } from "./backend.ts";
import type { SlackCompanionConfig } from "./config.ts";
import { type Conversation, conversationKey, conversationsForLink, conversationsForSend, isDirectMessage, type ParsedLink } from "./conversation.ts";
import type { HelperBatch, HelperOutcome } from "./helper.ts";
import type { LockManager } from "./locks.ts";
import { approvedNote, deniedNote, firstLine, markMessage, waitingNote } from "./messages.ts";
import { compareTs, tsFromMillis } from "./format.ts";
import { readNew, type ReadPoint, type SlackMessage } from "./reader.ts";
import { findSecretShape, stripControl } from "./secrets.ts";
import { triageInput, type TriageInput } from "./triage.ts";

export type WatchStatus = "active" | "paused" | "stopped" | "error";

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
  context: SlackMessage[];
  /** Confirmed messages from others not handled yet. */
  inbox: SlackMessage[];
  sendsWithoutOwner: number;
  lastActivityAt: number;
  lastNote?: string;
  agentLineSent: boolean;
  spend: { day: string; usd: number };
  /** The first other person seen here: who a direct message is with, or who a thread is with. */
  partner?: { userId: string; name: string };
  /** At a DM's top level: was the latest agent post there this session's? */
  lastAgentPostOurs?: boolean;
  /** When this watch (re)started; an earlier "stop" is history, not a request to stop now. */
  since: string;
  /** When it last ended, for the owner's count of stops not yet seen. */
  endedAt?: number;
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

export interface LedgerEntry {
  id: string;
  watchKey: string;
  text: string;
  at: number;
  status: "sending" | "sent" | "uncertain" | "failed";
  ts?: string;
}

export interface EngineState {
  version: 1;
  autoStart: boolean;
  owner?: Identity;
  watches: WatchState[];
  approvals: Approval[];
  ledger: LedgerEntry[];
  tombstones: string[];
  /** Direct-message channel of each user id the session sent to by user id. */
  dmChannels: Record<string, string>;
}

export type SendOutcome = "sent" | "paused" | "blocked" | "revoked" | "uncertain" | "failed";

export const STATE_VERSION = 1;
const MAX_CONTEXT = 20;
const MAX_OWN_POSTS = 200;
const MAX_LEDGER = 100;
const MAX_TOMBSTONES = 200;
const MAX_ENDED_WATCHES = 20;
const MAX_RESOLVED_APPROVALS = 20;
const MAX_DM_CHANNELS = 200;

export function emptyState(): EngineState {
  return { version: STATE_VERSION, autoStart: true, watches: [], approvals: [], ledger: [], tombstones: [], dmChannels: {} };
}

export function isLive(watch: Pick<WatchState, "status">): boolean {
  return watch.status === "active" || watch.status === "paused";
}

export function pendingApprovals(state: Pick<EngineState, "approvals">, watchKey?: string): Approval[] {
  return state.approvals.filter((a) => a.status === "pending" && (!watchKey || a.watchKey === watchKey));
}

/** How the owner sees a conversation: who it is with, never a raw id when a name is known. */
export function watchLabel(watch: Pick<WatchState, "conversation" | "partner">): string {
  const { conversation, partner } = watch;
  if (isDirectMessage(conversation.channelId)) return `${partner?.name ?? "someone"} (DM)`;
  return `#${conversation.channelId} thread${partner ? ` with ${partner.name}` : ""}`;
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

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class Engine {
  private state: EngineState = emptyState();
  private lastPersisted = "";
  private readonly running = new Map<string, { promise: Promise<void>; abort: AbortController }>();
  private readonly inFlightSends = new Set<string>();
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

  restore(state: EngineState | undefined): void {
    if (!state || state.version !== STATE_VERSION) return;
    this.state = { ...emptyState(), ...structuredClone(state) };
    this.lastPersisted = JSON.stringify(this.state);
    for (const watch of this.liveWatches()) {
      const lock = this.deps.locks.acquire(watch.key);
      if (!lock.ok) this.end(watch, "error", `another Pi session (pid ${lock.holder.pid}) now answers this conversation`, false);
    }
    this.save();
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
    const resolved = this.state.approvals.filter((a) => a.status !== "pending");
    if (resolved.length > MAX_RESOLVED_APPROVALS) {
      const drop = new Set(resolved.slice(0, resolved.length - MAX_RESOLVED_APPROVALS).map((a) => a.id));
      this.state.approvals = this.state.approvals.filter((a) => !drop.has(a.id));
    }
    this.state.ledger = this.state.ledger.slice(-MAX_LEDGER);
    this.state.tombstones = this.state.tombstones.slice(-MAX_TOMBSTONES);
    const dm = Object.entries(this.state.dmChannels);
    if (dm.length > MAX_DM_CHANNELS) this.state.dmChannels = Object.fromEntries(dm.slice(-MAX_DM_CHANNELS));
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
      watch.ownPosts = [...new Set([...watch.ownPosts, input.ts])].slice(-MAX_OWN_POSTS);
      watch.agentLineSent = true;
      watch.lastAgentPostOurs = true;
      watch.lastActivityAt = this.deps.now();
      // What the session asked, so the triage call and the helper know what a reply answers.
      if (input.text && !watch.context.some((m) => m.ts === input.ts)) {
        const self = this.state.owner;
        watch.context = [...watch.context, { ts: input.ts, userId: self?.userId ?? "self", userName: self?.name ?? "the owner's agent", text: input.text, agentFooter: true }].slice(-MAX_CONTEXT);
      }
    }
    this.save();
  }

  /** Start watching, or return the live watch already there. */
  private startWatch(conversation: Conversation, startedBy: "send" | "attach", fromTs: string | undefined): WatchState | undefined {
    const key = conversationKey(conversation);
    const existing = this.watch(key);
    if (existing && isLive(existing)) return existing;
    const lock = this.deps.locks.acquire(key);
    if (!lock.ok) {
      this.deps.notify("warning", `Slack: another Pi session (pid ${lock.holder.pid}) already answers ${watchLabel({ conversation })}; this session will not.`);
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
      // A send-started watch begins at its own message; an attached one at this moment.
      since: fromTs ?? tsFromMillis(this.deps.now()),
      ...(existing?.partner ? { partner: existing.partner } : {}),
    };
    this.state.watches = [...this.state.watches.filter((w) => w.key !== key), watch];
    return watch;
  }

  /**
   * `/slack <link>` or the watch tool: hand the unanswered part of someone else's conversation to
   * a helper. The part starts after the owner's last message there. That boundary is read from
   * the listing, unconfirmed: a forged owner line can only move it later, so fewer messages get
   * answered, never more.
   */
  async attach(link: ParsedLink): Promise<WatchState | undefined> {
    if (this.disposed) return undefined;
    let primary: WatchState | undefined;
    for (const conversation of conversationsForLink(link)) {
      const key = conversationKey(conversation);
      const existing = this.watch(key);
      if (existing && isLive(existing)) {
        primary ??= existing;
        continue;
      }
      let from: string | undefined = conversation.kind === "dm-top" ? link.messageTs : undefined;
      if (conversation.kind === "thread") {
        const owner = await this.owner();
        const listed = await this.deps.backend.readSince(conversation, undefined);
        from = [...listed].reverse().find((m) => m.userId === owner.userId)?.ts;
      }
      this.state.tombstones = this.state.tombstones.filter((t) => t !== key);
      const watch = this.startWatch(conversation, "attach", from);
      primary ??= watch;
    }
    this.save();
    // A pass already running may have listed its watches before this one existed: wait for it, then read.
    await this.poll();
    await this.poll();
    return primary;
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
      if (watch.status === "paused" && !watch.reason?.startsWith("spend cap")) {
        watch.status = "active";
        delete watch.reason;
      }
    }
    this.save();
    for (const watch of this.liveWatches()) this.schedule(watch);
  }

  resume(key: string): void {
    const watch = this.watch(key);
    if (!watch || watch.status !== "paused") return;
    watch.status = "active";
    watch.sendsWithoutOwner = 0;
    delete watch.reason;
    this.save();
    this.schedule(watch);
  }

  /** Watch an ended conversation again, from where it stopped reading. */
  rewatch(key: string): void {
    const watch = this.watch(key);
    if (!watch || isLive(watch)) return;
    const lock = this.deps.locks.acquire(key);
    if (!lock.ok) {
      this.deps.notify("warning", `Slack: another Pi session (pid ${lock.holder.pid}) answers ${watchLabel(watch)}.`);
      return;
    }
    this.state.tombstones = this.state.tombstones.filter((t) => t !== key);
    watch.status = "active";
    watch.sendsWithoutOwner = 0;
    watch.lastActivityAt = this.deps.now();
    watch.since = tsFromMillis(this.deps.now());
    delete watch.reason;
    this.save();
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
  private end(watch: WatchState, status: "stopped" | "error", reason: string, explicit: boolean): void {
    watch.status = status;
    watch.reason = reason;
    watch.endedAt = this.deps.now();
    watch.inbox = [];
    if (explicit && !this.state.tombstones.includes(watch.key)) this.state.tombstones.push(watch.key);
    this.running.get(watch.key)?.abort.abort();
    this.deps.locks.release(watch.key);
    if (status === "error" && !this.disposed) this.deps.notify("error", `Slack: stopped watching ${watchLabel(watch)}: ${reason}. Open the panel (/slack) and press w to watch it again.`);
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
      watch.lastNote = `you approved: ${firstLine(approval.text, 60)}`;
    }
    this.save();
    this.deps.deliverApproved({ approval, ownerName: owner.name });
    if (watch && isLive(watch)) await this.sendTracked(watch, approvedNote(owner.name, approval.text));
  }

  async deny(id: string): Promise<void> {
    const approval = this.state.approvals.find((a) => a.id === id && a.status === "pending");
    if (!approval || this.disposed) return;
    approval.status = "denied";
    approval.resolvedAt = this.deps.now();
    const watch = this.watch(approval.watchKey);
    if (watch) {
      watch.sendsWithoutOwner = 0;
      watch.lastNote = `you declined: ${firstLine(approval.text, 60)}`;
    }
    this.save();
    if (watch && isLive(watch)) await this.sendTracked(watch, deniedNote((await this.owner()).name, approval.text));
  }

  /** Read every watch once; start helpers where a batch waits. Overlapping calls share one pass. */
  poll(): Promise<void> {
    this.polling ??= (async () => {
      try {
        for (const watch of this.liveWatches()) {
          if (this.disposed) return;
          this.deps.locks.refresh(watch.key);
          await this.pollWatch(watch);
        }
      } finally {
        this.polling = undefined;
      }
    })();
    return this.polling;
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
      const outcome = await readNew(this.deps.backend, watch.conversation, watch.point, startedAt);
      if (this.disposed || !isLive(watch)) return;
      watch.point = outcome.next;
      this.ingest(watch, outcome.fresh, owner);
      // Quiet only when this read found nothing new: what arrived while Pi was closed is read first.
      const quietMs = this.deps.config().quietHours * 3_600_000;
      if (isLive(watch) && !outcome.fresh.length && !watch.inbox.length && startedAt - watch.lastActivityAt > quietMs) {
        this.end(watch, "stopped", `no messages for ${this.deps.config().quietHours} h`, false);
      }
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof BackendNotReadyError) return; // Pi is still starting the adapter; the next poll reads
      this.end(watch, "error", error instanceof Error ? error.message : String(error), false);
      this.save();
      return;
    }
    this.save();
    this.schedule(watch);
  }

  private ingest(watch: WatchState, fresh: SlackMessage[], owner: Identity): void {
    const own = new Set(watch.ownPosts);
    for (const sent of this.state.ledger) if (sent.watchKey === watch.key && sent.ts) own.add(sent.ts);
    const queued = new Set(watch.inbox.map((m) => m.ts));
    for (const message of fresh) {
      watch.lastActivityAt = this.deps.now();
      watch.context = [...watch.context.filter((m) => m.ts !== message.ts), message].slice(-MAX_CONTEXT);
      if (own.has(message.ts)) {
        watch.lastAgentPostOurs = true;
        continue;
      }
      if (isStopMessage(message.text) && compareTs(message.ts, watch.since) > 0) {
        this.end(watch, "stopped", `${message.userName} said stop`, true);
        return;
      }
      // Another of the owner's agents posted it: context only, never answered.
      if (message.userId === owner.userId && message.agentFooter) {
        watch.lastAgentPostOurs = false;
        continue;
      }
      if (!watch.partner && message.userId !== owner.userId) watch.partner = { userId: message.userId, name: message.userName };
      if (queued.has(message.ts)) continue;
      if (watch.conversation.kind === "dm-top" && watch.lastAgentPostOurs === false) {
        // The person may be answering another session's question: tell the owner, do not guess.
        this.deps.notify("info", `Slack: ${message.userName} wrote at the top level of ${watchLabel(watch)} after another session's message; not answered here: "${firstLine(message.text, 80)}"`);
        continue;
      }
      watch.inbox = [...watch.inbox, message];
      queued.add(message.ts);
    }
  }

  private schedule(watch: WatchState): void {
    if (this.disposed || watch.status !== "active" || !watch.inbox.length || this.running.has(watch.key)) return;
    const abort = new AbortController();
    const promise = this.process(watch, abort.signal)
      .catch((error) => {
        if (!this.disposed && isLive(watch)) {
          this.end(watch, "error", `the helper failed: ${(error as Error).message}`, false);
          this.save();
        }
      })
      .finally(() => {
        this.running.delete(watch.key);
        this.deps.changed();
        // Messages that arrived while the helper ran form the next batch.
        if (!this.disposed && watch.status === "active" && watch.inbox.length) this.schedule(watch);
      });
    this.running.set(watch.key, { promise, abort });
    this.deps.changed();
  }

  private overCap(watch: WatchState): boolean {
    const cap = this.deps.config().spendCapUsdPerDay;
    const today = dayOf(this.deps.now());
    if (watch.spend.day !== today) watch.spend = { day: today, usd: 0 };
    return cap !== undefined && watch.spend.usd >= cap;
  }

  private async process(watch: WatchState, signal: AbortSignal): Promise<void> {
    const batch = [...watch.inbox];
    const taken = new Set(batch.map((m) => m.ts));
    const finish = (note: string) => {
      watch.inbox = watch.inbox.filter((m) => !taken.has(m.ts));
      watch.lastNote = note;
      this.save();
    };
    if (this.overCap(watch)) {
      watch.status = "paused";
      watch.reason = `spend cap of $${this.deps.config().spendCapUsdPerDay} reached today`;
      this.deps.notify("warning", `Slack: paused ${watchLabel(watch)}: ${watch.reason}`);
      this.save();
      return;
    }
    const owner = await this.owner();
    const ownPosts = new Set(watch.ownPosts);
    const addressed = isDirectMessage(watch.conversation.channelId) || batch.some((m) => m.text.includes(`<@${owner.userId}`));
    const triage = await this.deps.triage(triageInput({ label: watchLabel(watch), ownerName: owner.name, addressed, context: watch.context, ownPosts, batch }));
    if (this.disposed || !isLive(watch)) return;
    watch.spend.usd += triage.usd;
    if (!triage.speak) {
      finish(`stayed silent on ${batch.length} message${batch.length === 1 ? "" : "s"}`);
      return;
    }
    watch.lastNote = "answering…";
    this.save();
    const helperBatch: HelperBatch = {
      conversationLabel: watchLabel(watch),
      ownerName: owner.name,
      inChannel: !isDirectMessage(watch.conversation.channelId),
      context: watch.context.filter((m) => !taken.has(m.ts)),
      messages: batch,
      waitingApprovals: pendingApprovals(this.state, watch.key).map((a) => a.text),
    };
    const outcome = await this.deps.runHelper({ watch, batch: helperBatch, signal });
    if (this.disposed || !isLive(watch)) return;
    watch.spend.usd += outcome.usd;
    const newRequests: string[] = [];
    for (const handoff of outcome.handoffs) {
      if (handoff.kind === "info") {
        this.deps.deliverInfo({ watch, senders: batch, text: handoff.text });
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
      finish(newRequests.length ? "asked you to approve" : outcome.handoffs.length ? "told your session" : "stayed silent");
      return;
    }
    const sent = await this.sendTracked(watch, parts.join("\n\n"));
    if (sent === "paused") {
      watch.lastNote = "reply held: paused";
      this.save();
      return; // the batch stays: it is answered when the owner resumes
    }
    const note = sent === "sent"
      ? (outcome.reply ? `replied: ${firstLine(outcome.reply.text, 60)}` : "asked you to approve")
      : sent === "blocked" ? "reply blocked: it looked like a secret"
        : sent === "revoked" ? "conversation ended before the reply"
          : "reply may not have gone out";
    finish(note);
    if (outcome.reply?.done && sent === "sent") {
      this.end(watch, "stopped", "the helper finished this conversation", false);
      this.save();
    }
  }

  /** The only way the package posts: marked, thread-bound, secret-checked, counted before it goes, and recorded. */
  async sendTracked(watch: WatchState, text: string): Promise<SendOutcome> {
    if (this.disposed || !isLive(watch)) return "revoked";
    const config = this.deps.config();
    const shape = findSecretShape(text);
    if (shape) {
      this.deps.notify("warning", `Slack: did not send a reply in ${watchLabel(watch)}: it contained something shaped like a ${shape}.`);
      return "blocked";
    }
    if (watch.status === "paused") return "paused";
    // Reserve the slot before awaiting anything, so concurrent sends cannot pass the limit.
    if (watch.sendsWithoutOwner >= config.pauseAfterSends) {
      this.pauseForLimit(watch);
      this.save();
      return "paused";
    }
    watch.sendsWithoutOwner += 1;
    const owner = await this.owner();
    const marked = markMessage(text, config.marker, owner.name, !watch.agentLineSent);
    const entry: LedgerEntry = { id: randomUUID(), watchKey: watch.key, text: marked, at: this.deps.now(), status: "sending" };
    this.state.ledger.push(entry);
    this.inFlightSends.add(entry.id);
    this.save();
    const threadTs = watch.conversation.kind === "thread" ? watch.conversation.threadTs : undefined;
    try {
      const { ts } = await this.deps.backend.send(watch.conversation.channelId, marked, threadTs);
      entry.status = "sent";
      entry.ts = ts;
      watch.ownPosts = [...watch.ownPosts, ts].slice(-MAX_OWN_POSTS);
      watch.agentLineSent = true;
      watch.lastAgentPostOurs = true;
    } catch (error) {
      entry.status = error instanceof SendUncertainError ? "uncertain" : "failed";
      if (!this.disposed) this.deps.notify("warning", `Slack: a reply in ${watchLabel(watch)} may not have gone out (${(error as Error).message}); it will be checked, not re-sent.`);
    } finally {
      this.inFlightSends.delete(entry.id);
    }
    if (watch.sendsWithoutOwner >= config.pauseAfterSends) this.pauseForLimit(watch);
    this.save();
    return entry.status === "sent" ? "sent" : entry.status === "uncertain" ? "uncertain" : "failed";
  }

  private pauseForLimit(watch: WatchState): void {
    if (watch.status !== "active") return;
    watch.status = "paused";
    watch.reason = `sent ${watch.sendsWithoutOwner} messages without you`;
    this.deps.notify("info", `Slack: paused ${watchLabel(watch)} after ${watch.sendsWithoutOwner} messages without you. Open the panel (/slack) to resume.`);
  }

  /** A send whose outcome is unknown is settled by reading the conversation, never by sending again. */
  private async reconcile(watch: WatchState): Promise<void> {
    const pending = this.state.ledger.filter((e) => e.watchKey === watch.key && !this.inFlightSends.has(e.id) && (e.status === "uncertain" || e.status === "sending"));
    if (!pending.length) return;
    const owner = await this.owner();
    // Everything after the checkpoint: a send made after the last read is in there, whatever the clocks say.
    const messages = await this.deps.backend.readSince(watch.conversation, watch.point.checkpoint);
    const known = new Set(this.state.ledger.map((e) => e.ts).filter(Boolean));
    for (const entry of pending) {
      const found = messages.find((m) => m.userId === owner.userId && !known.has(m.ts) && m.text.trim() === entry.text.trim());
      if (found) {
        known.add(found.ts);
        entry.status = "sent";
        entry.ts = found.ts;
        watch.ownPosts = [...watch.ownPosts, found.ts].slice(-MAX_OWN_POSTS);
      } else {
        entry.status = "failed";
        this.deps.notify("warning", `Slack: a reply in ${watchLabel(watch)} did not go out; it was not re-sent.`);
      }
    }
  }
}

