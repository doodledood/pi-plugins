export interface ParentUpdateAnnouncement {
  parentHeadId: string;
  completedIds: string[];
}

/**
 * How a prompt joins a running child, mirroring the main chat: `steer` (Enter)
 * reaches the model after the current tool batch, `followUp` (Alt+Enter) waits
 * until the run would otherwise stop. Either starts a run when the child is idle.
 */
export type QueuedPromptMode = "steer" | "followUp";

export interface QueuedPrompt {
  text: string;
  mode: QueuedPromptMode;
}

export interface ChildPromptSessionPort {
  /**
   * Submit through Pi's prompt path. `onAdmitted` fires once Pi has decided the
   * prompt's fate (run started, queued, or handled by an extension); the returned
   * promise settles only when a run it started ends.
   */
  prompt(text: string, mode: QueuedPromptMode, onAdmitted: () => void): Promise<void>;
  /**
   * Record a parent-update notice: appended at once when the child is idle, otherwise
   * queued into the running child under `mode`, next to the user prompt it precedes.
   */
  appendAnnouncement(announcement: ParentUpdateAnnouncement, mode: QueuedPromptMode): Promise<void>;
  isIdle(): boolean;
  /** Clear the session's steer/follow-up queues and return the user prompts they held. */
  clearQueue(): QueuedPrompt[];
  /** The user prompts the session's steer/follow-up queues hold, in delivery order. */
  queuedPrompts(): QueuedPrompt[];
  abortCompaction(): void;
  abortBranchSummary(): void;
  abort(): Promise<void>;
}

export interface ChildPromptCoordinatorCallbacks {
  onAnnouncementDelivered(announcement: ParentUpdateAnnouncement): void;
  onAnnouncementDiscarded(announcement: ParentUpdateAnnouncement): void;
  /** The set of prompts waiting for the child (held here or queued in the session) changed. */
  onQueueChange?(): void;
}

type HeldPrompt = QueuedPrompt & { settle(run: Promise<void>): void };

/**
 * Owns BTW prompt admission. Like the main chat, a prompt submitted while the
 * child runs joins that run as a steer or follow-up instead of waiting for it to
 * end. Only Pi's prompt preflight is serialized: two prompts racing through it
 * while the child is idle would both try to start a run, so each prompt waits
 * until the one before it has been admitted (run started or queued), never for
 * the run itself.
 *
 * Cancellation drops prompts still held here. A prompt already inside
 * session.prompt (input handlers, auth checks) cannot be withdrawn through public
 * API, so its agent_start is aborted immediately: abort/close keep their flag set
 * until every in-flight prompt settles, so that agent_start always observes the
 * cancellation.
 */
export class ChildPromptCoordinator {
  private readonly port: ChildPromptSessionPort;
  private readonly callbacks: ChildPromptCoordinatorCallbacks;
  private readonly held: HeldPrompt[] = [];
  private admitting = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pendingAnnouncements: ParentUpdateAnnouncement[] = [];
  private closePromise: Promise<void> | undefined;
  private abortPromise: Promise<void> | undefined;
  private closing = false;
  private aborting = false;

  constructor(port: ChildPromptSessionPort, callbacks: ChildPromptCoordinatorCallbacks) {
    this.port = port;
    this.callbacks = callbacks;
  }

  /** Settles when a run this prompt started ends; at once when it only queued or was dropped. */
  prompt(text: string, mode: QueuedPromptMode = "steer"): Promise<void> {
    const value = text.trim();
    if (!value) return Promise.resolve();
    if (this.closing) return Promise.reject(new Error("BTW is closing; the prompt was not submitted."));
    if (this.aborting) return Promise.reject(new Error("BTW is aborting; wait for cancellation before submitting."));

    let settle!: (run: Promise<void>) => void;
    const result = new Promise<void>((resolve, reject) => {
      settle = (run) => run.then(resolve, reject);
    });
    this.held.push({ text: value, mode, settle });
    this.callbacks.onQueueChange?.();
    void this.pump();
    return result;
  }

  /** Every prompt still waiting for the child, oldest first: queued in the session, then held here. */
  queued(): QueuedPrompt[] {
    return [...this.port.queuedPrompts(), ...this.held.map(({ text, mode }) => ({ text, mode }))];
  }

  /**
   * Take back every prompt still waiting for the child (main's Alt+Up). A prompt
   * already inside Pi's preflight cannot be withdrawn and still lands.
   */
  dequeue(): QueuedPrompt[] {
    const taken = [...this.port.clearQueue(), ...this.dropHeld()];
    this.callbacks.onQueueChange?.();
    return taken;
  }

  async enqueueAnnouncement(announcement: ParentUpdateAnnouncement): Promise<void> {
    if (this.closing || this.aborting) {
      this.callbacks.onAnnouncementDiscarded(announcement);
      return;
    }
    this.pendingAnnouncements.push(announcement);
    if (!this.admitting && this.inFlight.size === 0 && this.port.isIdle()) {
      await this.flushAnnouncements();
    }
  }

  /** Called synchronously from the session event subscription. */
  onAgentStart(): void {
    if (!this.closing && !this.aborting) return;
    // AgentSession.abort() synchronously aborts the core agent before awaiting
    // idle, so a provider/tool path that started late receives cancellation.
    void this.port.abort().catch(() => {});
  }

  abort(): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    if (this.closing) return this.closePromise ?? Promise.resolve();
    this.aborting = true;
    this.discardQueuedWork();
    this.abortPromise = (async () => {
      this.port.abortCompaction();
      this.port.abortBranchSummary();
      try {
        await this.port.abort();
      } finally {
        await this.settleInFlight();
        // Extensions can react during abort; clear steer/follow-up work again.
        this.discardQueuedWork();
      }
    })().finally(() => {
      this.aborting = false;
      this.abortPromise = undefined;
    });
    return this.abortPromise;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.discardQueuedWork();
    this.closePromise = (async () => {
      this.port.abortCompaction();
      this.port.abortBranchSummary();
      try {
        await this.port.abort();
      } finally {
        await this.settleInFlight();
        this.discardQueuedWork();
      }
    })();
    return this.closePromise;
  }

  clearAfterExtensionWork(): void {
    this.discardQueuedWork();
  }

  private get cancelled(): boolean {
    return this.closing || this.aborting;
  }

  /** Admit held prompts one at a time; each waits only for the previous admission. */
  private async pump(): Promise<void> {
    if (this.admitting) return;
    this.admitting = true;
    try {
      while (!this.cancelled && this.held.length > 0) {
        // Each prompt carries pending parent-update notices in just ahead of it,
        // under the same delivery mode. A notice alone never enters a running
        // child: it would make the run take an extra model turn for hidden text.
        try {
          await this.flushAnnouncements(this.held[0]!.mode);
        } catch (error) {
          this.held.shift()?.settle(Promise.reject(error));
          this.callbacks.onQueueChange?.();
          continue;
        }
        if (this.cancelled) break;
        const next = this.held.shift()!;
        this.callbacks.onQueueChange?.();
        let admitted!: () => void;
        const admission = new Promise<void>((resolve) => { admitted = resolve; });
        const run = this.track(this.port.prompt(next.text, next.mode, admitted));
        next.settle(run);
        await Promise.race([admission, run.catch(() => {})]);
        // Pi has queued it or started its run; the session queue may now show it.
        this.callbacks.onQueueChange?.();
      }
    } finally {
      this.admitting = false;
    }
  }

  private track(run: Promise<void>): Promise<void> {
    this.inFlight.add(run);
    const settled = run.finally(async () => {
      this.inFlight.delete(run);
      // Notices held during the run land once nothing is running or being admitted.
      if (!this.admitting && this.inFlight.size === 0 && this.port.isIdle()) {
        await this.flushAnnouncements();
      }
    });
    return settled;
  }

  private async settleInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private dropHeld(): QueuedPrompt[] {
    const dropped = this.held.splice(0);
    for (const prompt of dropped) prompt.settle(Promise.resolve());
    return dropped.map(({ text, mode }) => ({ text, mode }));
  }

  private discardQueuedWork(): void {
    this.dropHeld();
    for (const announcement of this.pendingAnnouncements) {
      this.callbacks.onAnnouncementDiscarded(announcement);
    }
    this.pendingAnnouncements.length = 0;
    // Public AgentSession support covers steer/follow-up only. BTW never uses
    // nextTurn for its own hidden announcements; third-party nextTurn remains
    // an explicitly documented child-extension limitation.
    this.port.clearQueue();
    this.callbacks.onQueueChange?.();
  }

  private async flushAnnouncements(mode: QueuedPromptMode = "steer"): Promise<void> {
    while (!this.cancelled && this.pendingAnnouncements.length > 0) {
      const announcement = this.pendingAnnouncements.shift()!;
      try {
        await this.port.appendAnnouncement(announcement, mode);
        this.callbacks.onAnnouncementDelivered(announcement);
      } catch (error) {
        this.callbacks.onAnnouncementDiscarded(announcement);
        throw error;
      }
    }
  }
}
