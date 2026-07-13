export interface ParentUpdateAnnouncement {
  parentHeadId: string;
  completedIds: string[];
}

export interface ChildPromptSessionPort {
  // Pi 0.80.6's exported PromptOptions includes this internal RPC hook and
  // AgentSession.prompt invokes it immediately before model work (or on preflight failure).
  // BTW is intentionally version-bound to that behavior for late cancellation admission.
  prompt(text: string, options: { preflightResult(success: boolean): void }): Promise<void>;
  appendAnnouncement(announcement: ParentUpdateAnnouncement): Promise<void>;
  isIdle(): boolean;
  clearQueue(): void;
  abortCompaction(): void;
  abortBranchSummary(): void;
  abort(): Promise<void>;
}

export interface ChildPromptCoordinatorCallbacks {
  onAnnouncementDelivered(announcement: ParentUpdateAnnouncement): void;
  onAnnouncementDiscarded(announcement: ParentUpdateAnnouncement): void;
}

class CancelledPromptAdmission extends Error {
  constructor() {
    super("BTW prompt admission was cancelled.");
    this.name = "AbortError";
  }
}

/**
 * Owns BTW prompt admission independently of Pi's steer/follow-up queues.
 * Cancellation invalidates an async input/preflight before it can start an
 * agent, and an agent_start observed after cancellation is aborted immediately.
 */
export class ChildPromptCoordinator {
  private readonly port: ChildPromptSessionPort;
  private readonly callbacks: ChildPromptCoordinatorCallbacks;
  private promptGeneration = 0;
  private promptRunning = false;
  private promptTail = Promise.resolve();
  private readonly pendingAnnouncements: ParentUpdateAnnouncement[] = [];
  private closePromise: Promise<void> | undefined;
  private abortPromise: Promise<void> | undefined;
  private closing = false;
  private aborting = false;

  constructor(port: ChildPromptSessionPort, callbacks: ChildPromptCoordinatorCallbacks) {
    this.port = port;
    this.callbacks = callbacks;
  }

  prompt(text: string): Promise<void> {
    const value = text.trim();
    if (!value) return Promise.resolve();
    if (this.closing) return Promise.reject(new Error("BTW is closing; the prompt was not submitted."));
    if (this.aborting) return Promise.reject(new Error("BTW is aborting; wait for cancellation before submitting."));

    const generation = this.promptGeneration;
    const run = this.promptTail.catch(() => {}).then(async () => {
      if (this.isCancelled(generation)) return;
      this.promptRunning = true;
      try {
        await this.flushAnnouncements(generation);
        if (this.isCancelled(generation)) return;
        try {
          await this.port.prompt(value, {
            preflightResult: (success) => {
              if (!success) return;
              if (this.isCancelled(generation)) throw new CancelledPromptAdmission();
            },
          });
        } catch (error) {
          if (!(error instanceof CancelledPromptAdmission)) throw error;
        }
      } finally {
        let flushError: unknown;
        try {
          await this.flushAnnouncements(generation);
        } catch (error) {
          flushError = error;
        }
        this.promptRunning = false;
        try {
          // Close the narrow handoff where an announcement arrives after the
          // first flush observes an empty queue but before promptRunning clears.
          await this.flushAnnouncements(generation);
        } catch (error) {
          flushError ??= error;
        }
        if (flushError !== undefined) throw flushError;
      }
    });
    this.promptTail = run.catch(() => {});
    return run;
  }

  async enqueueAnnouncement(announcement: ParentUpdateAnnouncement): Promise<void> {
    if (this.closing || this.aborting) {
      this.callbacks.onAnnouncementDiscarded(announcement);
      return;
    }
    this.pendingAnnouncements.push(announcement);
    if (!this.promptRunning && this.port.isIdle()) {
      await this.flushAnnouncements(this.promptGeneration);
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
        await this.promptTail.catch(() => {});
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
        await this.promptTail.catch(() => {});
        this.discardQueuedWork();
      }
    })();
    return this.closePromise;
  }

  clearAfterExtensionWork(): void {
    this.discardQueuedWork();
  }

  private isCancelled(generation: number): boolean {
    return this.closing || this.aborting || generation !== this.promptGeneration;
  }

  private discardQueuedWork(): void {
    this.promptGeneration += 1;
    for (const announcement of this.pendingAnnouncements) {
      this.callbacks.onAnnouncementDiscarded(announcement);
    }
    this.pendingAnnouncements.length = 0;
    // Public AgentSession support covers steer/follow-up only. BTW never uses
    // nextTurn for its own hidden announcements; third-party nextTurn remains
    // an explicitly documented child-extension limitation.
    this.port.clearQueue();
  }

  private async flushAnnouncements(generation: number): Promise<void> {
    while (!this.isCancelled(generation) && this.pendingAnnouncements.length > 0) {
      const announcement = this.pendingAnnouncements.shift()!;
      try {
        await this.port.appendAnnouncement(announcement);
        this.callbacks.onAnnouncementDelivered(announcement);
      } catch (error) {
        this.callbacks.onAnnouncementDiscarded(announcement);
        throw error;
      }
    }
  }
}
