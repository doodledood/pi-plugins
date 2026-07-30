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
import { isSeatLive } from "./seat.ts";
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
import {
  claimStop,
  ensureStopRecord,
  finishStop,
  openStopsForSession,
  stopIdFor,
} from "./stops.ts";
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

  private handedOff: boolean;
  private mandate: string | null;
  private latestAssistant: { text: string; stopReason: string | undefined } | undefined;
  private title: string | null = null;
  private titleRequested = false;
  private settleCount = 0;
  private closed = false;

  /** Not readonly: /hq_send_off turns an attended session into a managed one. */
  role: SessionRole;
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
    this.handedOff = false;
    this.mandate = null;
    this.kind = isManagedEnv(this.env) ? envKind(this.env) : "worker";
  }

  private get sessionId(): string {
    return this.ctx.sessionManager.getSessionId();
  }

  /** Internal workers are plumbing: they are not shown or triaged as work. */
  private get internal(): boolean {
    return INTERNAL_KINDS.has(this.kind);
  }

  /**
   * A session HQ did not start is the user's own. It is not on the board, gets no
   * title worker and is never triaged: HQ has nothing to say about it until the user
   * hands it over with /hq_send_off, which is the only thing this reporter then does.
   */
  private get mine(): boolean {
    return this.role !== "managed";
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
      drillingPacketIds: [],
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
    // Internal workers are plumbing, not work: they would fill the board with
    // rows for triage and drill processes that live for seconds.
    if (this.internal || this.mine) return;

    const next = this.state(fleetState, stopState);
    const previous = await this.store.readSessionState(this.sessionId);
    if (!previous) {
      await this.store.publishSessionState(next);
      return;
    }
    // Other processes own fields on this row — the titler owns the title, a drill
    // owns the drilling marker — so publish only what this session knows.
    this.title = previous.title ?? this.title;
    await this.store.patchSessionState(this.sessionId, {
      sessionFile: next.sessionFile,
      pid: next.pid,
      runtimeId: next.runtimeId,
      role: next.role,
      kind: next.kind,
      project: next.project,
      state: next.state,
      stopState: next.stopState,
      preview: next.preview,
      lastEventAt: next.lastEventAt,
      originSessionId: next.originSessionId,
      packetId: next.packetId,
    });
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
    // A provider error or a context overflow is a death, not a delivery: reported
    // as finished it would point triage at "close" instead of "respawn", and tell
    // the user work shipped that never ran.
    const stopReason = this.latestAssistant?.stopReason;
    if (stopReason === "aborted" || stopReason === "error" || stopReason === "length") {
      return "aborted";
    }
    if (this.latestAssistant?.text.trimEnd().endsWith("?")) return "stopped-with-question";
    return "idle-done";
  }

  async onAgentSettled(): Promise<void> {
    const stopState = this.classifyStop();
    await this.publish("done", stopState);
    if (this.mine || this.internal) return;
    await this.recordAndTriageStop(stopState);
  }

  /**
   * Hands this live session to HQ. The role flip is all it takes: the gate on
   * recording a stop is the role, so from here this session's own reporter starts
   * recording stops and HQ triages them. Called from /hq_send_off, which runs
   * between turns, so the session is settled and the stop can be recorded at once.
   */
  async handOff(mandate: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.role === "managed") {
      return { ok: false, reason: "HQ already owns this session" };
    }
    this.role = "managed";
    this.handedOff = true;
    this.mandate = mandate.trim() || null;
    await this.publish("done", this.classifyStop());
    await this.recordAndTriageStop(this.classifyStop());
    return { ok: true };
  }

  /**
   * Takes this session back from HQ. The reverse of handOff, and the reason it exists:
   * handing over is a decision the user makes in the moment, and a decision they can
   * only make comfortably if it can be undone. Any stop of this session that triage has
   * not finished is closed, so nothing picks it up afterwards.
   */
  async takeBack(): Promise<
    { ok: true; withdrawn: string[] } | { ok: false; reason: string }
  > {
    if (!this.handedOff) {
      return {
        ok: false,
        reason: this.role === "managed"
          ? "HQ started this session; end it rather than taking it back"
          : "this session is already yours",
      };
    }
    this.role = "attended";
    this.handedOff = false;
    this.mandate = null;
    for (const stop of await openStopsForSession(this.store.root, this.sessionId)) {
      await finishStop(this.store.root, stop.stopId, "taken-back", null);
    }
    const { withdrawn } = await this.store.releaseSession(this.sessionId);
    return { ok: true, withdrawn };
  }

  private async recordAndTriageStop(stopState: StopState): Promise<void> {
    const seated = isSeatLive(this.store.root, this.now());
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
      ...(this.handedOff ? { handedOff: true, mandate: this.mandate } : {}),
      status: "open",
      claimedByPid: null,
      claimedAt: null,
      outcome: null,
      packetId: null,
    });
    // A record that already existed belongs to a stop someone is handling; the
    // claim below is the cross-process guard, and this is the same-process one.
    if (!created) return;

    // The stop is on disk either way. Triage is HQ thinking on the user's behalf, so it
    // waits for someone to be at the desk: with no seat open there is nobody for a
    // packet to reach, and the seat sweeps unfinished stops when it opens. Nothing is
    // lost by waiting, and nothing is spent while the user is elsewhere. Checked before
    // the claim, so the stop is left plainly unclaimed for that sweep.
    if (!seated) return;

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
    if (this.title || this.titleRequested || this.internal || this.mine) return;
    if (this.env[TITLER_ENV] === "1") return;
    // Naming a session is for a board someone is looking at. With no seat open there is
    // no board, so there is no reason to spend a model call on it.
    if (!isSeatLive(this.store.root, this.now())) return;
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
    await this.publish("done", stopState);
    this.closed = true;
  }

  /** Test seam: the reporter's view of the latest assistant text. */
  get previewForTests(): string {
    return truncatePreview(this.latestAssistant?.text ?? "");
  }
}
