import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { selectCompletedBranch, type ForkSnapshot } from "./fork.ts";
import {
  ChildPromptCoordinator,
  type ParentUpdateAnnouncement,
} from "./prompt-coordinator.ts";
import { ChildUIBridge } from "./ui-bridge.ts";
import { ParentUpdateTracker, type ParentUpdateResult } from "./updates.ts";

export const CHECK_PARENT_UPDATES_TOOL = "check_parent_updates";
export const PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE = "btw-parent-update-available";
export const PARENT_UPDATE_AVAILABLE_MESSAGE = "Newer completed parent context is available. Call check_parent_updates when the answer may depend on parent work completed after this BTW fork.";

const CHILD_APPEND_PROMPT = `BTW is an independent side conversation forked from the parent. Its messages never update the parent conversation. You share the parent's working directory and requested active tool names; the parent may modify files concurrently, so verify shared state is current before a conflicting write.`;

export interface ChildRuntimeCallbacks {
  onEvent(event: AgentSessionEvent): void;
  onNotice(message: string, type?: "info" | "warning" | "error"): void;
  onChildStatus(key: string, text: string | undefined): void;
  onRequestClose(): void;
}

export interface ChildRuntimeHandle {
  readonly session: AgentSession;
  readonly tempDir: string;
  readonly tempSessionFile: string;
  prompt(text: string): Promise<void>;
  announceParentUpdate(): Promise<boolean>;
  abort(): Promise<void>;
  close(reason?: string): Promise<void>;
}

type ReadonlyParentSessionManager = ExtensionContext["sessionManager"];

export interface CreateChildRuntimeInput {
  snapshot: ForkSnapshot;
  parentSessionManager: ReadonlyParentSessionManager;
  parentIsIdle(): boolean;
  parentUI: ExtensionUIContext;
  parentModelRegistry: ModelRegistry;
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
    activeToolNames: [...new Set([...snapshot.activeToolNames, CHECK_PARENT_UPDATES_TOOL])],
  };
}

export function serializeFork(snapshot: ForkSnapshot): string {
  const header = {
    type: "session" as const,
    version: CURRENT_SESSION_VERSION,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: snapshot.cwd,
    ...(snapshot.parentSessionFile ? { parentSession: snapshot.parentSessionFile } : {}),
  };
  return `${[header, ...snapshot.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
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

export async function createChildRuntime(input: CreateChildRuntimeInput): Promise<ChildRuntimeHandle> {
  const { snapshot, callbacks } = input;
  const extensionRoot = input.extensionRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const agentDir = input.agentDir ?? getAgentDir();
  const tempDir = await mkdtemp(join(input.tempRoot ?? tmpdir(), "pi-btw-"));
  const tempSessionFile = join(tempDir, "session.jsonl");
  let session: AgentSession | undefined;
  let bridge: ChildUIBridge | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    await writeFile(tempSessionFile, serializeFork(snapshot), { encoding: "utf8", mode: 0o600 });

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
    const inherited = inheritedRuntimeSpec(snapshot);
    const activeToolNames = inherited.activeToolNames;
    const sessionManager = SessionManager.open(tempSessionFile, tempDir, inherited.cwd);
    const created = await createAgentSession({
      cwd: inherited.cwd,
      agentDir,
      model: inherited.model,
      thinkingLevel: inherited.thinkingLevel,
      tools: activeToolNames,
      customTools: [updateTool],
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
      throw new Error(`BTW could not inherit active tool(s): ${missingTools.join(", ")}`);
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
      prompt: (text, options) => session!.prompt(text, options),
      appendAnnouncement: (announcement) => session!.sendCustomMessage({
        customType: PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE,
        content: PARENT_UPDATE_AVAILABLE_MESSAGE,
        display: false,
        details: { parentHeadId: announcement.parentHeadId },
      }),
      isIdle: () => session!.isIdle,
      clearQueue: () => { session!.clearQueue(); },
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
    });

    const runtime: ChildRuntimeHandle = {
      session,
      tempDir,
      tempSessionFile,
      prompt(text) {
        return coordinator!.prompt(text);
      },
      async announceParentUpdate() {
        const completedEntries = selectCompletedBranch(
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
                await rm(tempDir, { recursive: true, force: true });
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
      await rm(tempDir, { recursive: true, force: true });
    }
    throw error;
  }
}
