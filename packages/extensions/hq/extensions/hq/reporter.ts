/**
 * The reporter runs in every pi session HQ is installed in.
 *
 * In an attended session it does two harmless things: publishes the fleet row so
 * the glance can show it, and asks for a title. It never triages an attended
 * session and never sends it anything (INV-G13) — a human is in that seat.
 *
 * In a managed session it additionally records the stop and asks triage to
 * decide what the stop means.
 */

import { truncatePreview } from "./io.ts";
import { assistantFromMessages, firstUserText, type SessionContextLike } from "./host.ts";
import { TITLE_PROMPT } from "./prompts.ts";
import {
  envKind,
  INTERNAL_KINDS,
  isManagedEnv,
  ORIGIN_ENV,
  PACKET_ENV,
  type Spawner,
  TITLER_ENV,
} from "./spawn.ts";
import type { HqStore } from "./store.ts";
import { claimStop, ensureStopRecord, stopIdFor } from "./stops.ts";
import { TRIAGE_KICKOFF } from "./prompts.ts";
import type { FleetState, SessionKind, SessionRole, SessionState, StopState } from "./types.ts";

export interface ReporterOptions {
  store: HqStore;
  spawner: Spawner;
  ctx: SessionContextLike;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  runtimeId?: string;
  /** Model used only for generating a session title. */
  titleModel?: string;
  /** Injected in tests to observe triage requests without spawning. */
  onTriageRequested?: (stopId: string) => void;
}

export class SessionReporter {
  private readonly store: HqStore;
  private readonly spawner: Spawner;
  private readonly ctx: SessionContextLike;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly runtimeId: string;
  private readonly titleModel: string | undefined;
  private readonly onTriageRequested: ((stopId: string) => void) | undefined;

  private latestAssistant: { text: string; stopReason: string | undefined } | undefined;
  private title: string | null = null;
  private titleRequested = false;
  private settleCount = 0;
  private closed = false;

  readonly role: SessionRole;
  readonly kind: SessionKind | "titler";

  constructor(options: ReporterOptions) {
    this.store = options.store;
    this.spawner = options.spawner;
    this.ctx = options.ctx;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.runtimeId = options.runtimeId ?? `rt-${process.pid}-${Date.now()}`;
    this.titleModel = options.titleModel;
    this.onTriageRequested = options.onTriageRequested;
    this.role = isManagedEnv(this.env) ? "managed" : "attended";
    this.kind = isManagedEnv(this.env) ? envKind(this.env) : "worker";
  }

  private get sessionId(): string {
    return this.ctx.sessionManager.getSessionId();
  }

  /** Internal workers are plumbing: they are not shown or triaged as work. */
  private get internal(): boolean {
    return INTERNAL_KINDS.has(this.kind);
  }

  private state(fleetState: FleetState, stopState: StopState): SessionState {
    const at = this.now().toISOString();
    return {
      version: 1,
      sessionId: this.sessionId,
      sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
      pid: process.pid,
      runtimeId: this.runtimeId,
      role: this.role,
      kind: this.kind === "titler" ? "worker" : this.kind,
      project: this.ctx.cwd,
      title: this.title,
      state: fleetState,
      stopState,
      preview: truncatePreview(this.latestAssistant?.text ?? ""),
      startedAt: this.startedAt ?? at,
      lastEventAt: at,
      drillingPacketId: null,
      originSessionId: this.env[ORIGIN_ENV] ?? null,
      packetId: this.env[PACKET_ENV] ?? null,
    };
  }

  private startedAt: string | undefined;

  async start(): Promise<void> {
    await this.store.ensure();
    this.startedAt = this.now().toISOString();
    const existing = await this.store.readSessionState(this.sessionId);
    if (existing?.title) this.title = existing.title;
    if (existing?.startedAt) this.startedAt = existing.startedAt;
    await this.publish("idle", "idle-done");
  }

  private async publish(fleetState: FleetState, stopState: StopState): Promise<void> {
    if (this.closed) return;
    // Titler runs are noise on the board; they exist for a few seconds.
    if (this.kind === "titler") return;
    const next = this.state(fleetState, stopState);
    const previous = await this.store.readSessionState(this.sessionId);
    const preserved: SessionState = previous
      ? { ...next, drillingPacketId: previous.drillingPacketId }
      : next;
    await this.store.publishSessionState(preserved);
  }

  async onAgentStart(): Promise<void> {
    await this.publish("running", "working");
    await this.requestTitleIfNeeded();
  }

  onAgentEnd(messages: readonly unknown[]): void {
    const assistant = assistantFromMessages(messages);
    if (assistant) this.latestAssistant = assistant;
  }

  /** Classification is deliberately shallow; triage does the real reading. */
  classifyStop(): StopState {
    if (this.latestAssistant?.stopReason === "aborted") return "aborted";
    if (this.latestAssistant?.text.trimEnd().endsWith("?")) return "stopped-with-question";
    return "idle-done";
  }

  async onAgentSettled(): Promise<void> {
    const stopState = this.classifyStop();
    await this.publish(this.role === "managed" ? "done" : "idle", stopState);
    if (this.role !== "managed" || this.internal) return;
    await this.recordAndTriageStop(stopState);
  }

  private async recordAndTriageStop(stopState: StopState): Promise<void> {
    this.settleCount += 1;
    const stopId = stopIdFor(
      this.sessionId,
      this.ctx.sessionManager.getLeafId(),
      this.settleCount,
    );
    const at = this.now().toISOString();
    const { created } = await ensureStopRecord(this.store.root, {
      version: 1,
      stopId,
      sessionId: this.sessionId,
      sessionFile: this.ctx.sessionManager.getSessionFile() ?? null,
      project: this.ctx.cwd,
      kind: this.kind === "titler" ? "worker" : this.kind,
      stopState,
      preview: truncatePreview(this.latestAssistant?.text ?? ""),
      createdAt: at,
      status: "open",
      claimedByPid: null,
      claimedAt: null,
      outcome: null,
      packetId: null,
    });
    // A record that already existed belongs to a stop someone is handling; the
    // claim below is the cross-process guard, and this is the same-process one.
    if (!created) return;

    const won = await claimStop(this.store.root, stopId, process.pid, at);
    if (!won) return;

    this.onTriageRequested?.(stopId);
    await this.spawner({
      kind: "triage",
      prompt: TRIAGE_KICKOFF(stopId),
      cwd: this.ctx.cwd,
      env: { HQ_STOP_ID: stopId },
    });
  }

  private async requestTitleIfNeeded(): Promise<void> {
    if (this.title || this.titleRequested || this.internal) return;
    if (this.env[TITLER_ENV] === "1") return;
    const branch = this.ctx.sessionManager.getBranch?.() ?? [];
    const seed = firstUserText(branch);
    if (!seed) return;
    this.titleRequested = true;
    await this.spawner({
      kind: "titler",
      prompt: TITLE_PROMPT(this.sessionId, seed),
      cwd: this.ctx.cwd,
      ...(this.titleModel ? { model: this.titleModel } : {}),
      tools: ["hq_set_title"],
    });
  }

  async onShutdown(): Promise<void> {
    const stopState = this.classifyStop();
    await this.publish(this.role === "managed" ? "done" : "idle", stopState);
    this.closed = true;
  }

  /** Test seam: the reporter's view of the latest assistant text. */
  get previewForTests(): string {
    return truncatePreview(this.latestAssistant?.text ?? "");
  }
}
