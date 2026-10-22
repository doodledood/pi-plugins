import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  CURRENT_SESSION_VERSION,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type Extension,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { forkEntriesForChild, selectForkBranch, type ForkSnapshot } from "./fork.ts";
import { deriveChildSessionDir } from "./sidecar.ts";
import {
  ChildPromptCoordinator,
  type ParentUpdateAnnouncement,
  type QueuedPrompt,
  type QueuedPromptMode,
} from "./prompt-coordinator.ts";
import { ChildUIBridge } from "./ui-bridge.ts";
import { ParentUpdateTracker, type ParentUpdateResult } from "./updates.ts";

export const CHECK_PARENT_UPDATES_TOOL = "check_parent_updates";
export const SEND_TO_MAIN_TOOL = "send_to_main";
/**
 * Parent tools BTW never inherits: BTW is a read-only side conversation, so it
 * does not get the file-editing tools, and it must not start goal-controller
 * work of its own (a goal would run autonomous turns inside the aside).
 */
export const BTW_WITHHELD_TOOLS: readonly string[] = ["edit", "write", "goal"];
export const SEND_TO_MAIN_PREFIX = "[Relayed from my BTW side conversation]";
export const PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE = "btw-parent-update-available";
export const PARENT_UPDATE_AVAILABLE_MESSAGE = "Newer completed parent context is available. Call check_parent_updates when the answer may depend on parent work completed after this BTW fork.";

export const CHILD_APPEND_PROMPT = `You are in BTW, a read-only side conversation forked from the main session, possibly mid-work, so the user can ask questions and think things through while main keeps working.

- Answer, explain, investigate, and discuss, leaving files, repositories, and outside systems exactly as you found them. Read-only inspection — reading, searching, git log/diff/status, read-only queries — is the whole toolbox. When the user wants a change made, it belongs in the main session; offer to relay it.
- The history may end inside an unfinished task or carry an active goal. Both belong to the main session and continue there; treat the history as context and address only what the user asks in BTW.
- Nothing said here reaches main on its own. When the user asks you to tell, send, or relay something to main, call ${SEND_TO_MAIN_TOOL} with a self-contained message in the user's voice — usually the verdict you reached together.
- Main may be changing files as you read them; re-read before relying on details.`;

export interface ChildRuntimeCallbacks {
  onEvent(event: AgentSessionEvent): void;
  onNotice(message: string, type?: "info" | "warning" | "error"): void;
  onChildStatus(key: string, text: string | undefined): void;
  onRequestClose(): void;
  /** The prompts waiting for the child changed; read them with `queued()`. */
  onQueueChange(): void;
}

export interface ChildRuntimeHandle {
  readonly session: AgentSession;
  /** Directory holding the aside's session file (a sidecar dir, or a private temp dir). */
  readonly childSessionDir: string;
  /** The aside's own session file. Kept after close when it lives in a sidecar dir. */
  readonly childSessionFile: string;
  /** Set only when the directory is this aside's private temp dir, removed on close. */
  readonly disposableDir?: string;
  /** Start a run when idle; otherwise join the running one as a steer (default) or follow-up. */
  prompt(text: string, mode?: QueuedPromptMode): Promise<void>;
  /** Prompts submitted but not yet delivered to the child's model, oldest first. */
  queued(): QueuedPrompt[];
  /** Take back every prompt not yet delivered, oldest first. */
  dequeue(): QueuedPrompt[];
  announceParentUpdate(): Promise<boolean>;
  abort(): Promise<void>;
  close(reason?: string): Promise<void>;
}

type ReadonlyParentSessionManager = ExtensionContext["sessionManager"];

/** Whether a relay reached the main session, and if not, why. */
export type RelayOutcome = { delivered: true } | { delivered: false; reason: string };

export interface CreateChildRuntimeInput {
  snapshot: ForkSnapshot;
  parentSessionManager: ReadonlyParentSessionManager;
  parentIsIdle(): boolean;
  parentUI: ExtensionUIContext;
  parentModelRegistry: ModelRegistry;
  /**
   * Deliver a message to the parent session as a user message on the user's behalf. Settles once the parent
   * has been handed the message, or with the reason it never will be; `signal` gives up waiting.
   */
  sendToParent(text: string, signal?: AbortSignal): Promise<RelayOutcome>;
  /** Optional runtime override for tests; defaults to a fresh ModelRuntime from agentDir files. */
  modelRuntime?: ModelRuntime;
  agentDir?: string;
  extensionRoot?: string;
  tempRoot?: string;
  callbacks: ChildRuntimeCallbacks;
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep));
}

export function filterBtwExtensions(
  extensions: readonly Extension[],
  extensionRoot: string,
): { extensions: Extension[]; removed: number } {
  const kept = extensions.filter((extension) => !isWithin(extension.resolvedPath, extensionRoot));
  return { extensions: kept, removed: extensions.length - kept.length };
}

export function inheritedRuntimeSpec(snapshot: ForkSnapshot): {
  cwd: string;
  model: ForkSnapshot["model"];
  thinkingLevel: ForkSnapshot["thinkingLevel"];
  activeToolNames: string[];
} {
  return {
    cwd: snapshot.cwd,
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    activeToolNames: [...new Set([
      ...snapshot.activeToolNames.filter((name) => !BTW_WITHHELD_TOOLS.includes(name)),
      CHECK_PARENT_UPDATES_TOOL,
      SEND_TO_MAIN_TOOL,
    ])],
  };
}

/** Sidecar folder name for BTW aside sessions under the parent session. */
export const BTW_SESSION_KIND = "btw";

export function serializeFork(snapshot: ForkSnapshot, identity?: { id: string; timestamp: string }): string {
  const header = {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id: identity?.id ?? randomUUID(),
    timestamp: identity?.timestamp ?? new Date().toISOString(),
    cwd: snapshot.cwd,
    ...(snapshot.parentSessionFile ? { parentSession: snapshot.parentSessionFile } : {}),
  };
  return `${[header, ...forkEntriesForChild(snapshot.entries)].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * Where the aside's session file lives, and whether its directory is ours to delete.
 *
 * An aside is a real model conversation that costs real money, so it is kept rather
 * than discarded: persisted under the parent session (see sidecar.ts), where its
 * spend stays discoverable after the pane closes. Only when the parent has no
 * session file does the aside fall back to a private temp directory, which is then
 * removed on close as before — a shared sidecar directory must never be removed,
 * since it holds every other aside of this session.
 */
export async function resolveChildSessionLocation(
  snapshot: ForkSnapshot,
  tempRoot: string | undefined,
): Promise<{ sessionFile: string; identity: { id: string; timestamp: string }; disposableDir?: string }> {
  const identity = { id: randomUUID(), timestamp: new Date().toISOString() };
  const fileName = `${identity.timestamp.replace(/[:.]/g, "-")}_${identity.id}.jsonl`;
  const sidecarDir = deriveChildSessionDir(snapshot.parentSessionFile, BTW_SESSION_KIND);
  if (sidecarDir) {
    await mkdir(sidecarDir, { recursive: true });
    return { sessionFile: join(sidecarDir, fileName), identity };
  }
  const tempDir = await mkdtemp(join(tempRoot ?? tmpdir(), "pi-btw-"));
  return { sessionFile: join(tempDir, "session.jsonl"), identity, disposableDir: tempDir };
}

function createParentUpdateTool(tracker: ParentUpdateTracker, parent: ReadonlyParentSessionManager) {
  return defineTool({
    name: CHECK_PARENT_UPDATES_TOOL,
    label: "Check parent updates",
    description:
      "Explicitly pull completed updates from the parent conversation since the previous check. Results are normalized and bounded; no live synchronization occurs.",
    promptSnippet: "Pull completed parent-conversation updates on explicit request",
    promptGuidelines: [
      "Use check_parent_updates when the answer may depend on parent work completed after this BTW fork; update content is available only through that explicit pull.",
    ],
    parameters: Type.Object({}),
    async execute(): Promise<{ content: Array<{ type: "text"; text: string }>; details: ParentUpdateResult["details"] }> {
      const result = tracker.pull(parent);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },
  });
}

function createSendToMainTool(
  sendToParent: CreateChildRuntimeInput["sendToParent"],
  onOutcome: (outcome: RelayOutcome) => void,
) {
  return defineTool({
    name: SEND_TO_MAIN_TOOL,
    label: "Send to main",
    description:
      "Send a message to the main session on the user's behalf, as if the user typed it there. It starts a main turn when main is idle, or queues behind the current main run; while main is compacting it waits until compaction ends. The result says whether the message was delivered. Use only when the user asks you to tell, send, or relay something to main.",
    promptSnippet: "Relay a message to the main session on the user's explicit request",
    parameters: Type.Object({
      message: Type.String({ description: "The message for the main session, written as the user would say it." }),
    }),
    async execute(
      _toolCallId,
      params,
      signal,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: { relayed: string; delivered: boolean }; isError?: boolean }> {
      const body = params.message.trim();
      if (!body) throw new Error("send_to_main needs a non-empty message.");
      const relayed = `${SEND_TO_MAIN_PREFIX}\n\n${body}`;
      const outcome = await sendToParent(relayed, signal);
      onOutcome(outcome);
      if (!outcome.delivered) {
        return {
          content: [{ type: "text", text: notDeliveredText(outcome.reason) }],
          details: { relayed, delivered: false },
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: SENT_TEXT }],
        details: { relayed, delivered: true },
      };
    },
  });
}

const SENT_TEXT = "Sent to the main session.";

function notDeliveredText(reason: string): string {
  return `Not delivered: the message did not reach the main session (${reason}).`;
}

function queuedFrom(queues: { steering: readonly string[]; followUp: readonly string[] }): QueuedPrompt[] {
  return [
    ...queues.steering.map((text) => ({ text, mode: "steer" as const })),
    ...queues.followUp.map((text) => ({ text, mode: "followUp" as const })),
  ];
}

export function missingInheritedToolsNotice(missingTools: readonly string[]): string {
  return `BTW opened without ${missingTools.length} parent tool(s) that are not available in a fresh load: ${missingTools.join(", ")}. Restart or /reload the parent to bring them back in sync.`;
}

export async function createChildRuntime(input: CreateChildRuntimeInput): Promise<ChildRuntimeHandle> {
  const { snapshot, callbacks } = input;
  const extensionRoot = input.extensionRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const agentDir = input.agentDir ?? getAgentDir();
  const location = await resolveChildSessionLocation(snapshot, input.tempRoot);
  const childSessionFile = location.sessionFile;
  const childSessionDir = dirname(childSessionFile);
  const disposableDir = location.disposableDir;
  let session: AgentSession | undefined;
  let bridge: ChildUIBridge | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    await writeFile(childSessionFile, serializeFork(snapshot, location.identity), { encoding: "utf8", mode: 0o600 });

    const settingsManager = SettingsManager.create(snapshot.cwd, agentDir);
    settingsManager.setProjectTrusted(snapshot.projectTrusted);
    // pi >= 0.80.8: a fresh ModelRuntime from the same agentDir auth/models files
    // (the child loads filtered extensions, so alias providers re-register there).
    const modelRuntime =
      input.modelRuntime ??
      (await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }));
    const promptOptions = snapshot.systemPromptOptions;
    const appendSystemPrompt = [promptOptions.appendSystemPrompt, CHILD_APPEND_PROMPT]
      .filter((value): value is string => Boolean(value?.trim()));

    const loader = new DefaultResourceLoader({
      cwd: snapshot.cwd,
      agentDir,
      settingsManager,
      ...(promptOptions.customPrompt ? { systemPrompt: promptOptions.customPrompt } : {}),
      appendSystemPrompt,
      extensionsOverride(base) {
        const filtered = filterBtwExtensions(base.extensions, extensionRoot);
        return { ...base, extensions: filtered.extensions };
      },
      skillsOverride(base) {
        return promptOptions.skills
          ? { skills: [...promptOptions.skills], diagnostics: base.diagnostics }
          : base;
      },
      agentsFilesOverride(base) {
        return promptOptions.contextFiles
          ? { agentsFiles: promptOptions.contextFiles.map((file) => ({ ...file })) }
          : base;
      },
    });
    await loader.reload();

    const tracker = new ParentUpdateTracker(snapshot.entryIds, {}, input.parentIsIdle);
    let observedCompletedParentIds = [...snapshot.entryIds];
    const announcedParentHeads = new Set(snapshot.forkLeafId ? [snapshot.forkLeafId] : []);
    const updateTool = createParentUpdateTool(tracker, input.parentSessionManager);
    const sendToMainTool = createSendToMainTool(input.sendToParent, (outcome) => {
      if (outcome.delivered) callbacks.onNotice(SENT_TEXT, "info");
      else callbacks.onNotice(notDeliveredText(outcome.reason), "error");
    });
    const inherited = inheritedRuntimeSpec(snapshot);
    const activeToolNames = inherited.activeToolNames;
    const sessionManager = SessionManager.open(childSessionFile, childSessionDir, inherited.cwd);
    const created = await createAgentSession({
      cwd: inherited.cwd,
      agentDir,
      model: inherited.model,
      thinkingLevel: inherited.thinkingLevel,
      tools: activeToolNames,
      customTools: [updateTool, sendToMainTool],
      sessionManager,
      settingsManager,
      modelRuntime,
      resourceLoader: loader,
    });
    session = created.session;

    bridge = new ChildUIBridge(input.parentUI, {
      onNotice: callbacks.onNotice,
      onStatus: callbacks.onChildStatus,
    });
    let coordinator: ChildPromptCoordinator | undefined;
    unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_start") coordinator?.onAgentStart();
      callbacks.onEvent(event);
      // Pi's own steer/follow-up queues moved (a queued prompt reached the model, or was cleared).
      if (event.type === "queue_update") callbacks.onQueueChange();
    });

    await session.bindExtensions({
      uiContext: bridge.context,
      mode: "tui",
      abortHandler: () => {
        void session?.abort();
      },
      shutdownHandler: callbacks.onRequestClose,
      commandContextActions: {
        waitForIdle: () => session!.waitForIdle(),
        async newSession() {
          callbacks.onNotice("Child session replacement is not available inside the BTW pane.", "warning");
          return { cancelled: true };
        },
        async fork() {
          callbacks.onNotice("Child session forking is not available inside the BTW pane.", "warning");
          return { cancelled: true };
        },
        async navigateTree(targetId, options) {
          const result = await session!.navigateTree(targetId, options);
          return { cancelled: result.cancelled };
        },
        async switchSession() {
          callbacks.onNotice("Child session switching is not available inside the BTW pane.", "warning");
          return { cancelled: true };
        },
        async reload() {
          callbacks.onNotice("Child extension reload is not available inside the BTW pane.", "warning");
        },
      },
      onError(error) {
        callbacks.onNotice(`Child extension ${error.extensionPath}: ${error.error}`, "error");
      },
    });

    // A child extension's session_start (e.g. mcp-tool-loadout) can recompute its own
    // budgeted active set and deactivate part of the inherited set while binding. Re-assert
    // the parent's active tools so the fork faithfully inherits them. The check below then
    // only catches names that are genuinely unregistered in the child, not merely deactivated.
    session.setActiveToolsByName(activeToolNames);

    const actualTools = new Set(session.getActiveToolNames());
    const missingTools = activeToolNames.filter((name) => !actualTools.has(name));
    if (missingTools.length > 0) {
      // The parent's tool registry can legitimately drift from what a fresh load produces:
      // config edited since the parent started, runtime-only SDK tools, a server that failed
      // to connect in the child. BTW must still open at any stage, so it opens with the tools
      // that do resolve and says plainly which ones it could not bring along.
      callbacks.onNotice(missingInheritedToolsNotice(missingTools), "warning");
    }
    if (session.model?.provider !== snapshot.model.provider || session.model.id !== snapshot.model.id) {
      throw new Error("BTW child model does not match the parent model.");
    }
    if (session.thinkingLevel !== snapshot.thinkingLevel) {
      throw new Error("BTW child thinking level does not match the parent thinking level.");
    }
    if (session.sessionManager.getCwd() !== snapshot.cwd) {
      throw new Error("BTW child working directory does not match the parent working directory.");
    }

    for (const error of created.extensionsResult.errors) {
      callbacks.onNotice(`Child extension ${error.path}: ${error.error}`, "error");
    }

    let closePromise: Promise<void> | undefined;
    coordinator = new ChildPromptCoordinator({
      prompt: (text, mode, onAdmitted) => session!.prompt(text, {
        streamingBehavior: mode,
        preflightResult: onAdmitted,
      }),
      appendAnnouncement: (announcement, mode) => session!.sendCustomMessage({
        customType: PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE,
        content: PARENT_UPDATE_AVAILABLE_MESSAGE,
        display: false,
        details: { parentHeadId: announcement.parentHeadId },
      }, { deliverAs: mode }),
      isIdle: () => session!.isIdle,
      clearQueue: () => queuedFrom(session!.clearQueue()),
      queuedPrompts: () => queuedFrom({
        steering: session!.getSteeringMessages(),
        followUp: session!.getFollowUpMessages(),
      }),
      abortCompaction: () => session!.abortCompaction(),
      abortBranchSummary: () => session!.abortBranchSummary(),
      abort: () => session!.abort(),
    }, {
      onAnnouncementDelivered(announcement) {
        observedCompletedParentIds = announcement.completedIds;
      },
      onAnnouncementDiscarded(announcement) {
        announcedParentHeads.delete(announcement.parentHeadId);
      },
      onQueueChange: callbacks.onQueueChange,
    });

    const runtime: ChildRuntimeHandle = {
      session,
      childSessionDir,
      childSessionFile,
      ...(disposableDir ? { disposableDir } : {}),
      prompt(text, mode) {
        return coordinator!.prompt(text, mode);
      },
      queued() {
        return coordinator!.queued();
      },
      dequeue() {
        return coordinator!.dequeue();
      },
      async announceParentUpdate() {
        const completedEntries = selectForkBranch(
          input.parentSessionManager.getBranch(),
          input.parentIsIdle(),
        );
        const completedIds = completedEntries.map((entry) => entry.id);
        const completedHeadId = completedIds.at(-1);
        if (!completedHeadId) {
          observedCompletedParentIds = completedIds;
          return false;
        }

        let commonLength = 0;
        while (
          commonLength < observedCompletedParentIds.length &&
          commonLength < completedIds.length &&
          observedCompletedParentIds[commonLength] === completedIds[commonLength]
        ) {
          commonLength += 1;
        }
        const headAdvanced = completedIds.length > commonLength;
        if (!headAdvanced || announcedParentHeads.has(completedHeadId)) {
          if (!announcedParentHeads.has(completedHeadId)) observedCompletedParentIds = completedIds;
          return false;
        }

        announcedParentHeads.add(completedHeadId);
        const announcement: ParentUpdateAnnouncement = { parentHeadId: completedHeadId, completedIds };
        await coordinator!.enqueueAnnouncement(announcement);
        return true;
      },
      abort() {
        return coordinator!.abort();
      },
      close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          bridge?.dispose();
          try {
            await coordinator!.close();
          } finally {
            unsubscribe?.();
            unsubscribe = undefined;
            try {
              await session!.extensionRunner.emit({
                type: "session_shutdown",
                reason: "quit",
              });
            } finally {
              // Shutdown handlers can queue steer/follow-up work; clear public
              // queues again before disposing the extension runner/session.
              coordinator!.clearAfterExtensionWork();
              try {
                session!.dispose();
              } finally {
                // A persisted aside is kept: its spend and transcript stay countable
                // after the pane closes. Only a private temp directory is removed.
                if (disposableDir) await rm(disposableDir, { recursive: true, force: true });
              }
            }
          }
        })();
        return closePromise;
      },
    };

    return runtime;
  } catch (error) {
    bridge?.dispose();
    unsubscribe?.();
    try {
      if (session) {
        try {
          session.clearQueue();
          session.abortCompaction();
          session.abortBranchSummary();
          await session.abort();
        } catch {
          // Preserve the open failure; cleanup continues best-effort.
        }
        try {
          await session.extensionRunner.emit({
            type: "session_shutdown",
            reason: "quit",
          });
        } catch {
          // Preserve the open failure; cleanup continues best-effort.
        }
        session.clearQueue();
        session.dispose();
      }
    } finally {
      if (disposableDir) {
        await rm(disposableDir, { recursive: true, force: true });
      } else {
        // Construction failed before the aside was usable; remove just its own file,
        // never the shared sidecar directory.
        await rm(childSessionFile, { force: true });
      }
    }
    throw error;
  }
}
