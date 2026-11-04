// The companion's state and behavior, independent of Pi's wiring so it can be driven in tests.
//
// One owner of state: everything below changes only through Engine methods, and each change
// is persisted as one snapshot. Slack input can only narrow what happens
// (docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md): no path from a
// Slack message creates authority — approvals resolve only through approve()/deny(), which
// only the owner's panel and commands call.
import { randomUUID } from "node:crypto";
import { BackendError, SendUncertainError, type Identity, type SlackBackend } from "./backend.ts";
import type { SlackCompanionConfig } from "./config.ts";
import { type Conversation, conversationKey, isDirectMessage } from "./conversation.ts";
import type { HelperBatch, HelperOutcome } from "./helper.ts";
import type { LockManager } from "./locks.ts";
import { approvedNote, deniedNote, firstLine, markMessage, waitingNote } from "./messages.ts";
import { readNew, type ReadPoint, type SlackMessage } from "./reader.ts";
import { findSecretShape } from "./secrets.ts";

export type WatchStatus = "active" | "paused" | "stopped" | "error";

export interface WatchState {
  key: string;
  conversation: Conversation;
  label: string;
  startedBy: "send" | "attach";
  status: WatchStatus;
  reason?: string;
  point: ReadPoint;
  /** Messages this session posted here, by ts. */
  ownPosts: string[];
  /** Recent messages, for the helper's context. */
  context: SlackMessage[];
  /** Confirmed messages from others not handled yet. */
  inbox: SlackMessage[];
  sendsWithoutOwner: number;
  lastActivityAt: number;
  lastNote?: string;
  agentLineSent: boolean;
  spend: { day: string; usd: number };
}

export interface Approval {
  id: string;
  watchKey: string;
  requester: string;
  text: string;
  at: number;
  status: "pending" | "approved" | "denied";
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
}

export const STATE_VERSION = 1;
const MAX_CONTEXT = 20;
const MAX_OWN_POSTS = 200;
const MAX_LEDGER = 100;
const MAX_TOMBSTONES = 200;
const MAX_ENDED_WATCHES = 20;
const MAX_RESOLVED_APPROVALS = 20;

export function emptyState(): EngineState {
  return { version: STATE_VERSION, autoStart: true, watches: [], approvals: [], ledger: [], tombstones: [] };
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
  deliverApproved: (input: { watch: WatchState; approval: Approval; ownerName: string }) => void;
  /** Should the agent speak on this batch? Cheap model; records its own cost. */
  triage: (input: { watch: WatchState; batch: SlackMessage[]; addressed: boolean; ownerName: string }) => Promise<{ speak: boolean; usd: number }>;
  runHelper: (input: { watch: WatchState; batch: HelperBatch }) => Promise<HelperOutcome & { usd: number }>;
  locks: LockManager;
}

export function isStopMessage(text: string): boolean {
  return text.trim().toLowerCase() === "stop";
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function labelFor(conversation: Conversation, partner?: string): string {
  const where = isDirectMessage(conversation.channelId) ? `DM${partner ? ` with ${partner}` : ""}` : `#${conversation.channelId}`;
  return conversation.kind === "thread" ? `${where} · thread` : where;
}

export class Engine {
  private state: EngineState = emptyState();
  private readonly running = new Map<string, Promise<void>>();
  private polling: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: EngineDeps) {}

  snapshot(): EngineState {
    return structuredClone(this.state);
  }

  restore(state: EngineState | undefined): void {
    if (!state || state.version !== STATE_VERSION) return;
    this.state = structuredClone(state);
    for (const watch of this.activeWatches()) {
      const lock = this.deps.locks.acquire(watch.key);
      if (!lock.ok) this.end(watch, "error", `another Pi session (pid ${lock.holder.pid}) now owns this conversation`);
    }
  }

  private save(): void {
    this.prune();
    this.deps.persist(structuredClone(this.state));
    this.deps.changed();
  }

  private prune(): void {
    const ended = this.state.watches.filter((w) => w.status === "stopped" || w.status === "error");
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
  }

  activeWatches(): WatchState[] {
    return this.state.watches.filter((w) => w.status === "active" || w.status === "paused");
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

  get autoStart(): boolean {
    return this.state.autoStart;
  }

  setAutoStart(on: boolean): void {
    this.state.autoStart = on;
    this.save();
  }

  isTombstoned(key: string): boolean {
    return this.state.tombstones.includes(key);
  }

  /** Would a send by main to this place be a send into a watched conversation, or start one? */
  sendWillBeWatched(channelId: string, threadTs: string | undefined): boolean {
    if (threadTs) {
      const key = conversationKey({ kind: "thread", channelId, threadTs });
      if (this.watch(key)?.status === "active" || this.watch(key)?.status === "paused") return true;
      return this.state.autoStart && !this.isTombstoned(key);
    }
    const top = conversationKey({ kind: "dm-top", channelId });
    if (isDirectMessage(channelId) && (this.watch(top)?.status === "active" || this.watch(top)?.status === "paused")) return true;
    return this.state.autoStart;
  }

  /** Was the agent line already sent in this conversation? */
  agentLineSentFor(channelId: string, threadTs: string | undefined): boolean {
    const keys = threadTs ? [conversationKey({ kind: "thread", channelId, threadTs })] : [conversationKey({ kind: "dm-top", channelId })];
    return keys.some((key) => this.watch(key)?.agentLineSent === true);
  }

  /** Main sent a message (any route). Start or continue watching, and remember the post. */
  async onMainSend(input: { channelId: string; ts: string; threadTs?: string }): Promise<void> {
    const conversations: Conversation[] = [];
    if (input.threadTs) conversations.push({ kind: "thread", channelId: input.channelId, threadTs: input.threadTs });
    else {
      conversations.push({ kind: "thread", channelId: input.channelId, threadTs: input.ts });
      if (isDirectMessage(input.channelId)) conversations.push({ kind: "dm-top", channelId: input.channelId });
    }
    for (const conversation of conversations) {
      const key = conversationKey(conversation);
      let watch = this.watch(key);
      if (!watch || watch.status === "stopped" || watch.status === "error") {
        if (!this.state.autoStart || this.isTombstoned(key)) continue;
        watch = this.startWatch(conversation, "send", input.ts);
        if (!watch) continue;
      }
      watch.ownPosts = [...watch.ownPosts, input.ts].slice(-MAX_OWN_POSTS);
      watch.agentLineSent = true;
      watch.lastActivityAt = this.deps.now();
    }
    this.save();
  }

  private startWatch(conversation: Conversation, startedBy: "send" | "attach", fromTs: string | undefined): WatchState | undefined {
    const key = conversationKey(conversation);
    const lock = this.deps.locks.acquire(key);
    if (!lock.ok) {
      this.deps.notify("warning", `Slack: another Pi session (pid ${lock.holder.pid}) already answers ${labelFor(conversation)}; this session will not.`);
      return undefined;
    }
    const watch: WatchState = {
      key,
      conversation,
      label: labelFor(conversation),
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
    };
    this.state.watches = [...this.state.watches.filter((w) => w.key !== key), watch];
    return watch;
  }

  /** `/slack <link>` or the watch tool: hand the unanswered part of someone else's conversation to a helper. */
  async attach(input: { channelId: string; messageTs: string; threadTs?: string }): Promise<WatchState | undefined> {
    const root = input.threadTs ?? input.messageTs;
    const conversation: Conversation = { kind: "thread", channelId: input.channelId, threadTs: root };
    const key = conversationKey(conversation);
    this.state.tombstones = this.state.tombstones.filter((t) => t !== key);
    const watch = this.startWatch(conversation, "attach", undefined);
    if (!watch) return undefined;
    if (isDirectMessage(input.channelId) && !input.threadTs) {
      const top: Conversation = { kind: "dm-top", channelId: input.channelId };
      this.state.tombstones = this.state.tombstones.filter((t) => t !== conversationKey(top));
      this.startWatch(top, "attach", input.messageTs);
    }
    this.save();
    await this.pollWatch(watch, { attaching: true });
    return watch;
  }

  /** Owner typed in main: counts reset, and watches paused for the send limit resume. */
  ownerInput(): void {
    let touched = false;
    for (const watch of this.activeWatches()) {
      if (watch.sendsWithoutOwner > 0 || watch.status === "paused") touched = true;
      watch.sendsWithoutOwner = 0;
      if (watch.status === "paused") {
        watch.status = "active";
        delete watch.reason;
      }
    }
    if (touched) {
      this.save();
      for (const watch of this.activeWatches()) this.schedule(watch);
    }
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

  stop(key: string, reason = "stopped by you"): void {
    const watch = this.watch(key);
    if (watch && (watch.status === "active" || watch.status === "paused")) this.end(watch, "stopped", reason);
    this.save();
  }

  stopAll(): void {
    for (const watch of this.activeWatches()) this.end(watch, "stopped", "stopped by you");
    this.save();
  }

  private end(watch: WatchState, status: "stopped" | "error", reason: string): void {
    watch.status = status;
    watch.reason = reason;
    watch.inbox = [];
    // A stopped conversation stays stopped: a later send cannot restart it.
    if (status === "stopped" && !this.state.tombstones.includes(watch.key)) this.state.tombstones.push(watch.key);
    for (const approval of this.state.approvals) if (approval.watchKey === watch.key && approval.status === "pending") approval.status = "denied";
    this.deps.locks.release(watch.key);
    if (status === "error") this.deps.notify("error", `Slack: stopped watching ${watch.label}: ${reason}`);
  }

  pendingApprovals(): Approval[] {
    return this.state.approvals.filter((a) => a.status === "pending");
  }

  /** Only the owner calls this, from the panel or a command. */
  async approve(id: string): Promise<void> {
    const approval = this.state.approvals.find((a) => a.id === id && a.status === "pending");
    if (!approval) return;
    const watch = this.watch(approval.watchKey);
    if (!watch) return;
    approval.status = "approved";
    watch.sendsWithoutOwner = 0;
    const owner = await this.owner();
    this.save();
    this.deps.deliverApproved({ watch, approval, ownerName: owner.name });
    await this.sendTracked(watch, approvedNote(owner.name, approval.text));
  }

  async deny(id: string): Promise<void> {
    const approval = this.state.approvals.find((a) => a.id === id && a.status === "pending");
    if (!approval) return;
    const watch = this.watch(approval.watchKey);
    approval.status = "denied";
    if (watch) watch.sendsWithoutOwner = 0;
    this.save();
    if (watch) await this.sendTracked(watch, deniedNote((await this.owner()).name, approval.text));
  }

  /** Read every watch once; start helpers where a batch waits. Overlapping calls share one pass. */
  poll(): Promise<void> {
    this.polling ??= (async () => {
      try {
        for (const watch of this.activeWatches()) await this.pollWatch(watch);
      } finally {
        this.polling = undefined;
      }
    })();
    return this.polling;
  }

  /** Wait for running helpers (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }

  dispose(): void {
    this.disposed = true;
    for (const watch of this.activeWatches()) this.deps.locks.release(watch.key);
  }

  private async pollWatch(watch: WatchState, options: { attaching?: boolean } = {}): Promise<void> {
    if (this.disposed || (watch.status !== "active" && watch.status !== "paused")) return;
    const now = this.deps.now();
    const quietMs = this.deps.config().quietHours * 3_600_000;
    if (now - watch.lastActivityAt > quietMs) {
      this.end(watch, "stopped", `no messages for ${this.deps.config().quietHours} h`);
      this.save();
      return;
    }
    let owner: Identity;
    try {
      owner = await this.owner();
      await this.reconcile(watch);
      const outcome = await readNew(this.deps.backend, watch.conversation, watch.point, now);
      watch.point = outcome.next;
      const fresh = outcome.fresh;
      let unanswered = fresh;
      if (options.attaching) {
        // Only what nobody answered yet: messages after the owner's last one.
        const lastOwner = fresh.map((m) => m.userId).lastIndexOf(owner.userId);
        unanswered = fresh.slice(lastOwner + 1);
      }
      this.ingest(watch, fresh, unanswered, owner);
    } catch (error) {
      this.end(watch, "error", error instanceof BackendError || error instanceof Error ? error.message : String(error));
      this.save();
      return;
    }
    this.save();
    this.schedule(watch);
  }

  private ingest(watch: WatchState, fresh: SlackMessage[], unanswered: SlackMessage[], owner: Identity): void {
    const own = new Set(watch.ownPosts);
    for (const sent of this.state.ledger) if (sent.watchKey === watch.key && sent.ts) own.add(sent.ts);
    const handled = new Set(unanswered.map((m) => m.ts));
    for (const message of fresh) {
      watch.lastActivityAt = this.deps.now();
      if (own.has(message.ts)) continue;
      if (isStopMessage(message.text)) {
        this.end(watch, "stopped", `${message.userName} said stop`);
        return;
      }
      if (watch.label.startsWith("DM") && message.userId !== owner.userId && !watch.label.includes(" with ")) {
        watch.label = watch.label.replace(/^DM/, `DM with ${message.userName}`);
      }
      watch.context = [...watch.context, message].slice(-MAX_CONTEXT);
      // Another of the owner's agents posted it: context only, never answered.
      if (message.userId === owner.userId && message.agentFooter) continue;
      if (handled.has(message.ts)) watch.inbox = [...watch.inbox, message];
    }
  }

  private schedule(watch: WatchState): void {
    if (this.disposed || watch.status !== "active" || !watch.inbox.length || this.running.has(watch.key)) return;
    const run = this.process(watch).finally(() => {
      this.running.delete(watch.key);
      // Messages that arrived while the helper ran form the next batch.
      if (watch.status === "active" && watch.inbox.length) this.schedule(watch);
    });
    this.running.set(watch.key, run);
  }

  private overCap(watch: WatchState): boolean {
    const cap = this.deps.config().spendCapUsdPerDay;
    const today = dayOf(this.deps.now());
    if (watch.spend.day !== today) watch.spend = { day: today, usd: 0 };
    return cap !== undefined && watch.spend.usd >= cap;
  }

  private async process(watch: WatchState): Promise<void> {
    const batch = [...watch.inbox];
    if (this.overCap(watch)) {
      watch.status = "paused";
      watch.reason = `spend cap of $${this.deps.config().spendCapUsdPerDay} reached today`;
      this.deps.notify("warning", `Slack: paused ${watch.label}: ${watch.reason}`);
      this.save();
      return;
    }
    const done = (note: string) => {
      const taken = new Set(batch.map((m) => m.ts));
      watch.inbox = watch.inbox.filter((m) => !taken.has(m.ts));
      watch.lastNote = note;
      this.save();
    };
    try {
      const owner = await this.owner();
      const addressed = isDirectMessage(watch.conversation.channelId) || batch.some((m) => /<@|\bagent\b/i.test(m.text));
      const triage = await this.deps.triage({ watch, batch, addressed, ownerName: owner.name });
      watch.spend.usd += triage.usd;
      if (!triage.speak) {
        done(`stayed silent on ${batch.length} message${batch.length === 1 ? "" : "s"}`);
        return;
      }
      const taken = new Set(batch.map((m) => m.ts));
      const helperBatch: HelperBatch = {
        conversationLabel: watch.label,
        ownerName: owner.name,
        inChannel: !isDirectMessage(watch.conversation.channelId),
        context: watch.context.filter((m) => !taken.has(m.ts)),
        messages: batch,
        waitingApprovals: this.pendingApprovals().filter((a) => a.watchKey === watch.key).map((a) => a.text),
      };
      const outcome = await this.deps.runHelper({ watch, batch: helperBatch });
      watch.spend.usd += outcome.usd;
      if (watch.status !== "active" && watch.status !== "paused") return;
      const newRequests: string[] = [];
      for (const handoff of outcome.handoffs) {
        if (handoff.kind === "info") {
          this.deps.deliverInfo({ watch, senders: batch, text: handoff.text });
        } else {
          const requester = [...new Set(batch.map((m) => m.userName))].join(", ");
          this.state.approvals.push({ id: randomUUID(), watchKey: watch.key, requester, text: handoff.text, at: this.deps.now(), status: "pending" });
          newRequests.push(handoff.text);
          this.deps.notify("info", `Slack: ${requester} asked for something that needs your OK — open the panel to approve or deny.`);
        }
      }
      const parts = [outcome.reply?.text, newRequests.length ? waitingNote(owner.name, newRequests) : undefined].filter(Boolean);
      if (parts.length) await this.sendTracked(watch, parts.join("\n\n"));
      done(outcome.reply ? `replied: ${firstLine(outcome.reply.text, 60)}` : newRequests.length ? "asked you to approve" : outcome.handoffs.length ? "told your session" : "stayed silent");
      if (outcome.reply?.done) {
        this.end(watch, "stopped", "the helper finished this conversation");
        this.save();
      }
    } catch (error) {
      this.end(watch, "error", `the helper failed: ${(error as Error).message}`);
      this.save();
    }
  }

  /** The only way the package posts: marked, thread-bound, secret-checked, counted before it goes, and recorded. */
  async sendTracked(watch: WatchState, text: string): Promise<boolean> {
    if (watch.status !== "active" && watch.status !== "paused") return false;
    const config = this.deps.config();
    const shape = findSecretShape(text);
    if (shape) {
      this.deps.notify("warning", `Slack: did not send a reply in ${watch.label}: it contained something shaped like a ${shape}.`);
      return false;
    }
    if (watch.status === "paused") return false;
    // Reserve the slot before awaiting anything, so concurrent sends cannot pass the limit.
    if (watch.sendsWithoutOwner >= config.pauseAfterSends) {
      this.pauseForLimit(watch);
      this.save();
      return false;
    }
    watch.sendsWithoutOwner += 1;
    const owner = await this.owner();
    const marked = markMessage(text, config.marker, owner.name, !watch.agentLineSent);
    const entry: LedgerEntry = { id: randomUUID(), watchKey: watch.key, text: marked, at: this.deps.now(), status: "sending" };
    this.state.ledger.push(entry);
    this.save();
    const threadTs = watch.conversation.kind === "thread" ? watch.conversation.threadTs : undefined;
    try {
      const { ts } = await this.deps.backend.send(watch.conversation.channelId, marked, threadTs);
      entry.status = "sent";
      entry.ts = ts;
      watch.ownPosts = [...watch.ownPosts, ts].slice(-MAX_OWN_POSTS);
      watch.agentLineSent = true;
    } catch (error) {
      entry.status = error instanceof SendUncertainError ? "uncertain" : "failed";
      this.deps.notify("warning", `Slack: a reply in ${watch.label} may not have gone out (${(error as Error).message}); it will be checked, not re-sent.`);
    }
    if (watch.sendsWithoutOwner >= config.pauseAfterSends) this.pauseForLimit(watch);
    this.save();
    return entry.status === "sent";
  }

  private pauseForLimit(watch: WatchState): void {
    if (watch.status !== "active") return;
    watch.status = "paused";
    watch.reason = `sent ${watch.sendsWithoutOwner} messages without you`;
    this.deps.notify("info", `Slack: paused ${watch.label} after ${watch.sendsWithoutOwner} messages without you. Open the panel to resume.`);
  }

  /** A send whose outcome is unknown is settled by reading the conversation, never by sending again. */
  private async reconcile(watch: WatchState): Promise<void> {
    const pending = this.state.ledger.filter((e) => e.watchKey === watch.key && (e.status === "uncertain" || e.status === "sending"));
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
        this.deps.notify("warning", `Slack: a reply in ${watch.label} did not go out; it was not re-sent.`);
      }
    }
  }
}
