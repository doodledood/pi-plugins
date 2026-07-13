import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { settleExactCustomOverlay } from "./src/custom-overlay.ts";
import { snapshotParent } from "./src/fork.ts";
import {
  createChildRuntime,
  type ChildRuntimeHandle,
  type CreateChildRuntimeInput,
} from "./src/runtime.ts";
import { enableBtwMouseInput, type BtwMouseInputScope } from "./src/mouse.ts";
import { BTW_OVERLAY_OPTIONS, BtwOverlay } from "./src/ui.ts";

const EXTENSION_ROOT = dirname(fileURLToPath(import.meta.url));
export const SUPPORTED_PI_VERSION = "0.80.6";

export function assertSupportedPiVersion(version = VERSION): void {
  if (version !== SUPPORTED_PI_VERSION) {
    throw new Error(
      `@doodledood/pi-btw requires Pi ${SUPPORTED_PI_VERSION}; running Pi is ${version}. ` +
      "BTW is version-bound because prompt cancellation relies on Pi's preflightResult behavior.",
    );
  }
}

type RuntimeFactory = (input: CreateChildRuntimeInput) => Promise<ChildRuntimeHandle>;

type OverlayResources = {
  generation: number;
  panel: BtwOverlay;
  handle: OverlayHandle | undefined;
  tui: TUI;
  done: () => void;
  mouseScope: BtwMouseInputScope | undefined;
  disposed: boolean;
  panelDisposed: boolean;
  settled: boolean;
};

type ClosedState = { phase: "closed" };

type OpeningState = {
  phase: "opening";
  generation: number;
  promise: Promise<void>;
  overlay: OverlayResources | undefined;
  pendingPrompts: string[];
  settleOverlayReady: () => void;
  overlayReady: Promise<void>;
};

type OpenState = {
  phase: "open";
  generation: number;
  overlay: OverlayResources;
  runtime: ChildRuntimeHandle;
};

type ClosingState = {
  phase: "closing";
  generation: number;
  promise: Promise<void>;
  overlay: OverlayResources | undefined;
  runtime: ChildRuntimeHandle | undefined;
};

type ControllerState = ClosedState | OpeningState | OpenState | ClosingState;

function createOpeningState(generation: number): OpeningState {
  let settled = false;
  let resolveReady!: () => void;
  const overlayReady = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return {
    phase: "opening",
    generation,
    promise: Promise.resolve(),
    overlay: undefined,
    pendingPrompts: [],
    overlayReady,
    settleOverlayReady: () => {
      if (settled) return;
      settled = true;
      resolveReady();
    },
  };
}

export class BtwController {
  private readonly pi: ExtensionAPI;
  private readonly runtimeFactory: RuntimeFactory;
  private state: ControllerState = { phase: "closed" };
  private nextGeneration = 0;
  private abortPromise: Promise<void> | undefined;
  private parentRunning = false;

  constructor(pi: ExtensionAPI, runtimeFactory: RuntimeFactory = createChildRuntime) {
    this.pi = pi;
    this.runtimeFactory = runtimeFactory;
  }

  get isOpen(): boolean {
    return this.currentOverlay() !== undefined;
  }

  private controllerState(): ControllerState {
    return this.state;
  }

  private currentOverlay(): OverlayResources | undefined {
    return this.state.phase === "closed" ? undefined : this.state.overlay;
  }

  private currentRuntime(): ChildRuntimeHandle | undefined {
    return this.state.phase === "open" || this.state.phase === "closing"
      ? this.state.runtime
      : undefined;
  }

  private stateOwnsGeneration(generation: number): boolean {
    return this.state.phase !== "closed" && this.state.generation === generation;
  }

  private overlayForGeneration(generation: number): OverlayResources | undefined {
    return this.stateOwnsGeneration(generation) ? this.currentOverlay() : undefined;
  }

  setParentRunning(running: boolean): void {
    this.parentRunning = running;
    this.currentOverlay()?.panel.setParentRunning(running);
  }

  async announceParentUpdate(): Promise<void> {
    const runtime = this.currentRuntime();
    if (!runtime) return;

    try {
      await runtime.announceParentUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.currentOverlay()?.panel.addNotice(
        `Could not record parent-update availability: ${message}`,
        "error",
      );
    }
  }

  /** Dispose only the supplied overlay. Repeated calls also settle a handle that arrived late. */
  private disposeOverlay(overlay: OverlayResources | undefined): void {
    if (!overlay) return;
    overlay.disposed = true;

    const mouseScope = overlay.mouseScope;
    overlay.mouseScope = undefined;
    try {
      mouseScope?.dispose();
    } catch {
      // Terminal teardown is best-effort when Pi is already shutting down.
    }

    if (overlay.handle && !overlay.settled) {
      overlay.settled = true;
      try {
        settleExactCustomOverlay(overlay.tui, overlay.handle, overlay.done);
      } catch {
        // Pi may already be tearing down its overlay stack.
      }
    }

    if (!overlay.panelDisposed) {
      overlay.panelDisposed = true;
      try {
        overlay.panel.dispose();
      } catch {
        // Component disposal must not strand the child runtime.
      }
    }
  }

  private focus(overlay: OverlayResources): void {
    overlay.handle?.focus();
    overlay.panel.focusEditor();
  }

  async open(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const prompt = args.trim();
    if (prompt.toLowerCase() === "done") {
      await this.close("Closed with /btw done.");
      return;
    }

    if (ctx.mode !== "tui") {
      ctx.ui.notify("/btw requires Pi's interactive TUI.", "error");
      return;
    }

    if (this.state.phase === "closing") await this.state.promise;

    if (this.state.phase === "opening") {
      const opening = this.state;
      await opening.promise;
      // A failed or superseded opening owns none of this concurrent command's text.
      const settledState = this.controllerState();
      if (settledState.phase !== "open" || settledState.generation !== opening.generation) return;
      this.focus(settledState.overlay);
      if (prompt) this.submit(prompt);
      return;
    }

    if (this.state.phase === "open") {
      this.focus(this.state.overlay);
      if (prompt) this.submit(prompt);
      return;
    }

    const opening = createOpeningState(++this.nextGeneration);
    this.state = opening;
    if (prompt) opening.pendingPrompts.push(prompt);
    opening.promise = this.openGeneration(opening, ctx).finally(() => {
      if (this.state === opening) this.state = { phase: "closed" };
    });
    await opening.promise;
  }

  private async openGeneration(
    opening: OpeningState,
    ctx: ExtensionCommandContext,
  ): Promise<void> {
    this.parentRunning = !ctx.isIdle();
    let snapshot;
    try {
      snapshot = snapshotParent(ctx, ctx.model, this.pi.getThinkingLevel(), this.pi.getActiveTools());
    } catch (error) {
      opening.pendingPrompts.length = 0;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(message, "error");
      return;
    }

    void ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => {
        const panel = new BtwOverlay(tui, theme, {
          onSubmit: (text) => this.submitForGeneration(opening.generation, text),
          onMain: () => this.unfocus(opening.generation),
          onClose: () => {
            void this.close("Closed from the BTW pane.");
          },
          onAbort: () => {
            void this.abort();
          },
          onDispose: () => {
            const overlay = opening.overlay;
            if (!overlay) return;
            const mouseScope = overlay.mouseScope;
            overlay.mouseScope = undefined;
            mouseScope?.dispose();
          },
        });
        const overlay: OverlayResources = {
          generation: opening.generation,
          panel,
          handle: undefined,
          tui,
          done: () => done(),
          mouseScope: undefined,
          disposed: false,
          panelDisposed: false,
          settled: false,
        };
        opening.overlay = overlay;
        panel.setForkLeaf(snapshot.forkLeafId);
        panel.setParentRunning(this.parentRunning);
        overlay.mouseScope = enableBtwMouseInput({
          ui: ctx.ui,
          tui,
          getBounds: () => panel.getScreenBounds(),
          isBtwFocused: () => overlay.handle?.isFocused() ?? panel.focused,
          scrollBtw: (delta) => panel.scrollBy(delta),
          focusBtw: () => {
            if (!this.stateOwnsGeneration(overlay.generation) || this.currentOverlay() !== overlay) return;
            overlay.handle?.focus();
            panel.focusEditor();
          },
          focusMain: () => {
            if (!this.stateOwnsGeneration(overlay.generation) || this.currentOverlay() !== overlay) return;
            this.unfocus(overlay.generation);
          },
        });
        return panel;
      },
      {
        overlay: true,
        overlayOptions: BTW_OVERLAY_OPTIONS,
        onHandle: (handle) => {
          const overlay = opening.overlay;
          if (!overlay) {
            // The factory must run before onHandle, but do not strand an unexpected handle.
            try {
              handle.hide();
            } finally {
              opening.settleOverlayReady();
            }
            return;
          }
          overlay.handle = handle;
          if (this.state !== opening || overlay.disposed) {
            // A close can land after the factory returns but before Pi exposes its handle.
            this.disposeOverlay(overlay);
          }
          opening.settleOverlayReady();
        },
      },
    ).catch((error: unknown) => {
      opening.settleOverlayReady();
      opening.pendingPrompts.length = 0;
      this.disposeOverlay(opening.overlay);
      if (this.state !== opening) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`BTW overlay failed: ${message}`, "error");
    });

    await opening.overlayReady;
    const overlay = opening.overlay;
    if (this.state !== opening || !overlay || overlay.disposed) {
      opening.pendingPrompts.length = 0;
      return;
    }

    overlay.panel.setOpeningMessage("Loading inherited resources and active tools…");

    let createdRuntime: ChildRuntimeHandle | undefined;
    try {
      const runtime = await this.runtimeFactory({
        snapshot,
        parentSessionManager: ctx.sessionManager,
        parentIsIdle: () => ctx.isIdle(),
        parentUI: ctx.ui,
        parentModelRegistry: ctx.modelRegistry,
        extensionRoot: EXTENSION_ROOT,
        callbacks: {
          onEvent: (event) => this.overlayForGeneration(opening.generation)?.panel.handleSessionEvent(event),
          onNotice: (message, type) => this.overlayForGeneration(opening.generation)?.panel.addNotice(message, type),
          onChildStatus: (key, text) => this.overlayForGeneration(opening.generation)?.panel.setChildStatus(key, text),
          onRequestClose: () => {
            if (this.stateOwnsGeneration(opening.generation)) {
              void this.close("Child requested shutdown.");
            }
          },
        },
      });
      createdRuntime = runtime;
      if (this.state !== opening || opening.overlay !== overlay || overlay.disposed) {
        opening.pendingPrompts.length = 0;
        await runtime.close("Open was superseded.");
        return;
      }

      overlay.panel.attachSession(runtime.session);
      try {
        // Parent settlement can occur while resources/runtime are opening.
        await runtime.announceParentUpdate();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        overlay.panel.addNotice(
          `Could not catch up parent-update availability: ${message}`,
          "error",
        );
      }

      if (this.state !== opening || opening.overlay !== overlay || overlay.disposed) {
        opening.pendingPrompts.length = 0;
        await runtime.close("Open was superseded.");
        return;
      }

      const pendingPrompts = opening.pendingPrompts.splice(0);
      this.state = {
        phase: "open",
        generation: opening.generation,
        overlay,
        runtime,
      };
      for (const pendingPrompt of pendingPrompts) this.submit(pendingPrompt);
    } catch (error) {
      opening.pendingPrompts.length = 0;
      if (createdRuntime) {
        try {
          await createdRuntime.close("BTW open failed after runtime creation.");
        } catch {
          // Preserve and surface the original open failure.
        }
      }
      if (this.state !== opening) return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`BTW child failed to open: ${message}`, "error");
      this.disposeOverlay(overlay);
    }
  }

  private submitForGeneration(generation: number, text: string): void {
    if (!this.stateOwnsGeneration(generation)) return;
    this.submit(text);
  }

  private submit(text: string): void {
    const prompt = text.trim();
    if (!prompt) return;
    const control = prompt.toLowerCase();
    if (control === "done" || control === "/done" || control === "/btw done") {
      void this.close("Closed from the BTW pane.");
      return;
    }
    if (control === "/main") {
      const generation = this.state.phase === "closed" ? undefined : this.state.generation;
      if (generation !== undefined) this.unfocus(generation);
      return;
    }
    if (this.state.phase === "opening") {
      this.state.pendingPrompts.push(prompt);
      this.state.overlay?.panel.addNotice("Queued until the child runtime is ready.", "info");
      return;
    }
    if (this.state.phase !== "open") return;

    const open = this.state;
    void open.runtime.prompt(prompt).catch((error: unknown) => {
      if (this.state !== open) return;
      const message = error instanceof Error ? error.message : String(error);
      open.overlay.panel.addNotice(`Prompt failed: ${message}`, "error");
    });
  }

  private unfocus(generation: number): void {
    this.overlayForGeneration(generation)?.handle?.unfocus();
  }

  abort(): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    if (this.state.phase === "opening") this.state.pendingPrompts.length = 0;
    const runtime = this.currentRuntime();
    if (!runtime) return Promise.resolve();
    this.abortPromise = runtime.abort().finally(() => {
      this.abortPromise = undefined;
    });
    return this.abortPromise;
  }

  close(message = "Closing BTW…"): Promise<void> {
    if (this.state.phase === "closing") return this.state.promise;
    if (this.state.phase === "closed") return Promise.resolve();

    const prior = this.state;
    const overlay = prior.overlay;
    const runtime = prior.phase === "open" ? prior.runtime : undefined;
    const closing: ClosingState = {
      phase: "closing",
      generation: prior.generation,
      promise: Promise.resolve(),
      overlay,
      runtime,
    };
    this.state = closing;
    overlay?.panel.setClosing(message);
    if (prior.phase === "opening") {
      prior.pendingPrompts.length = 0;
      prior.settleOverlayReady();
    }

    // Stop terminal reporting and raw-input capture immediately. The visual
    // overlay stays in its closing state until child/open cleanup completes.
    if (overlay?.mouseScope) {
      const mouseScope = overlay.mouseScope;
      overlay.mouseScope = undefined;
      try {
        mouseScope.dispose();
      } catch {
        // Continue closing even if terminal input is already unavailable.
      }
    }

    closing.promise = (async () => {
      if (prior.phase === "opening") {
        try {
          await prior.promise;
        } catch {
          // The open path already surfaces its error in the pane.
        }
      }

      try {
        if (runtime) await runtime.close(message);
      } finally {
        this.disposeOverlay(overlay ?? prior.overlay);
      }
    })().finally(() => {
      if (this.state === closing) this.state = { phase: "closed" };
    });

    return closing.promise;
  }
}

export default function btwExtension(pi: ExtensionAPI): void {
  assertSupportedPiVersion();
  const controller = new BtwController(pi);

  pi.registerCommand("btw", {
    description: "Open or focus an isolated BTW side conversation; use /btw done to close",
    getArgumentCompletions(prefix) {
      return "done".startsWith(prefix) ? [{ value: "done", label: "done", description: "Close BTW" }] : null;
    },
    handler: (args, ctx) => controller.open(args, ctx),
  });

  pi.on("session_start", (_event, ctx) => {
    controller.setParentRunning(!ctx.isIdle());
  });
  pi.on("agent_start", () => controller.setParentRunning(true));
  pi.on("agent_settled", async () => {
    controller.setParentRunning(false);
    await controller.announceParentUpdate();
  });
  pi.on("session_shutdown", async () => {
    await controller.close("Parent session stopped; closing BTW.");
  });
}
