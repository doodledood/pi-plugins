import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { snapshotParent } from "../src/fork.ts";
import {
  CHECK_PARENT_UPDATES_TOOL,
  createChildRuntime,
  PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE,
  PARENT_UPDATE_AVAILABLE_MESSAGE,
  type ChildRuntimeHandle,
} from "../src/runtime.ts";

const PROVIDER = "btw-integration";
const API = "btw-integration-api";
const MODEL_ID = "deterministic";
const PARENT_OVERLAP_PROMPT = "PARENT_OVERLAP_TURN";
const CHILD_WRITE_PROMPT = "CHILD_WRITE_TURN";
const PARENT_UPDATE_PROMPT = "PARENT_LATER_UPDATE_TURN";
const CHILD_PULL_PROMPT = "CHILD_PULL_PARENT_UPDATES_TURN";
const PARENT_UPDATE_TEXT = "PARENT UPDATE TOKEN: alpha-42";
const SCRATCH_CONTENT = "written by BTW child\n";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<any> = {
  id: MODEL_ID,
  name: "BTW deterministic integration",
  api: API,
  provider: PROVIDER,
  baseUrl: "http://127.0.0.1/never-called",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_000,
};

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class OverlapBarrier {
  private readonly actors = new Set<"parent" | "child">();
  private readonly bothArrived = deferred();
  private readonly released = {
    parent: deferred(),
    child: deferred(),
  };

  async arrive(actor: "parent" | "child"): Promise<void> {
    this.actors.add(actor);
    if (this.actors.size === 2) this.bothArrived.resolve();
    await this.released[actor].promise;
  }

  async waitForBoth(timeoutMs = 2_000): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.bothArrived.promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for overlapping streams; arrived: ${[...this.actors].join(", ") || "none"}`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  release(actor?: "parent" | "child"): void {
    if (actor) this.released[actor].resolve();
    else {
      this.released.parent.resolve();
      this.released.child.resolve();
    }
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (!("type" in block) || block.type !== "text") return "";
      return "text" in block && typeof block.text === "string" ? block.text : "";
    })
    .join("");
}

function latestUserText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]!;
    if (message.role === "user") {
      const text = textOfContent(message.content);
      if (text !== PARENT_UPDATE_AVAILABLE_MESSAGE) return text;
    }
  }
  return "";
}

function lastToolResult(context: Context): Extract<Context["messages"][number], { role: "toolResult" }> | undefined {
  const message = context.messages.at(-1);
  return message?.role === "toolResult" ? message : undefined;
}

function hasParentUpdateAvailability(context: Context): boolean {
  return context.messages.some((message) =>
    message.role === "user" && textOfContent(message.content) === PARENT_UPDATE_AVAILABLE_MESSAGE
  );
}

function baseAssistant(selectedModel: Model<any>, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: selectedModel.api,
    provider: selectedModel.provider,
    model: selectedModel.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function pushText(stream: AssistantMessageEventStream, selectedModel: Model<any>, text: string): void {
  const output = baseAssistant(selectedModel, "stop");
  stream.push({ type: "start", partial: output });
  output.content.push({ type: "text", text: "" });
  stream.push({ type: "text_start", contentIndex: 0, partial: output });
  output.content[0] = { type: "text", text };
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end(output);
}

function pushToolCall(
  stream: AssistantMessageEventStream,
  selectedModel: Model<any>,
  toolCall: ToolCall,
): void {
  const output = baseAssistant(selectedModel, "toolUse");
  stream.push({ type: "start", partial: output });
  output.content.push({ ...toolCall, arguments: {} });
  stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
  const delta = JSON.stringify(toolCall.arguments);
  output.content[0] = toolCall;
  stream.push({ type: "toolcall_delta", contentIndex: 0, delta, partial: output });
  stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
  stream.push({ type: "done", reason: "toolUse", message: output });
  stream.end(output);
}

function pushError(stream: AssistantMessageEventStream, selectedModel: Model<any>, error: unknown): void {
  const output = baseAssistant(selectedModel, "error");
  output.errorMessage = error instanceof Error ? error.message : String(error);
  stream.push({ type: "error", reason: "error", error: output });
  stream.end(output);
}

function controlledStream(
  barrier: OverlapBarrier,
  scratchFile: string,
  selectedModel: Model<any>,
  context: Context,
  _options?: StreamOptions | SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const prompt = latestUserText(context);
    const toolResult = lastToolResult(context);

    if (prompt === PARENT_OVERLAP_PROMPT) {
      await barrier.arrive("parent");
      pushText(stream, selectedModel, "parent overlap complete");
      return;
    }
    if (prompt === CHILD_WRITE_PROMPT) {
      if (toolResult?.toolName === "write") {
        pushText(stream, selectedModel, "child write complete");
      } else {
        await barrier.arrive("child");
        pushToolCall(stream, selectedModel, {
          type: "toolCall",
          id: "child-write-call",
          name: "write",
          arguments: { path: scratchFile, content: SCRATCH_CONTENT },
        });
      }
      return;
    }
    if (prompt === PARENT_UPDATE_PROMPT) {
      pushText(stream, selectedModel, PARENT_UPDATE_TEXT);
      return;
    }
    if (prompt === CHILD_PULL_PROMPT) {
      if (toolResult?.toolName === CHECK_PARENT_UPDATES_TOOL) {
        const pulled = textOfContent(toolResult.content);
        pushText(stream, selectedModel, `CHILD PULLED UPDATE:\n${pulled}`);
      } else if (hasParentUpdateAvailability(context)) {
        pushToolCall(stream, selectedModel, {
          type: "toolCall",
          id: "child-parent-update-call",
          name: CHECK_PARENT_UPDATES_TOOL,
          arguments: {},
        });
      } else {
        throw new Error("Child pull prompt did not receive the hidden parent-update availability context");
      }
      return;
    }

    throw new Error(`Unexpected deterministic prompt: ${prompt}`);
  })().catch((error: unknown) => pushError(stream, selectedModel, error));

  return stream;
}

function assistantMessage(text: string, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: API,
    provider: PROVIDER,
    model: MODEL_ID,
    usage,
    stopReason: "stop",
    timestamp,
  };
}

function entryMessageText(entry: SessionEntry): string {
  if (entry.type !== "message") return "";
  const message = entry.message;
  if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
    return textOfContent(message.content);
  }
  if (message.role === "assistant") {
    return message.content
      .map((block) => block.type === "text" ? block.text : "")
      .join("");
  }
  return "";
}

function hasToolCall(entries: readonly SessionEntry[], toolName: string): boolean {
  return entries.some((entry) =>
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    entry.message.content.some((block) => block.type === "toolCall" && block.name === toolName),
  );
}

function findToolResult(
  entries: readonly SessionEntry[],
  toolName: string,
): Extract<SessionEntry, { type: "message" }> | undefined {
  return entries.findLast((entry): entry is Extract<SessionEntry, { type: "message" }> =>
    entry.type === "message" &&
    entry.message.role === "toolResult" &&
    entry.message.toolName === toolName,
  );
}

function hasToolResult(entries: readonly SessionEntry[], toolName: string): boolean {
  return findToolResult(entries, toolName) !== undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parentSnapshotContext(
  session: AgentSession,
  cwd: string,
): ExtensionCommandContext {
  return {
    cwd,
    sessionManager: session.sessionManager,
    isIdle: () => !session.isStreaming,
    isProjectTrusted: () => true,
    getSystemPromptOptions: () => ({ cwd }),
  } as unknown as ExtensionCommandContext;
}

test("a mid-turn fork yields a usable child session and announces the turn's completion once", { timeout: 10_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "btw-midturn-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "btw-midturn-agent-"));
  let child: ChildRuntimeHandle | undefined;
  let registry: ModelRegistry | undefined;

  try {
    const parentManager = SessionManager.inMemory(workspace);
    let parentIdle = false;
    parentManager.appendMessage({ role: "user", content: "long parent task", timestamp: 1 });
    parentManager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "x" } }],
      api: API,
      provider: PROVIDER,
      model: MODEL_ID,
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    });
    const lastForkEntryId = parentManager.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "MID-TURN TOOL OUTPUT: beta-7" }],
      isError: false,
      timestamp: 3,
    });

    const snapshot = snapshotParent(
      {
        cwd: workspace,
        sessionManager: parentManager,
        isIdle: () => parentIdle,
        isProjectTrusted: () => true,
        getSystemPromptOptions: () => ({ cwd: workspace }),
      } as unknown as ExtensionCommandContext,
      model,
      "off",
      [],
    );
    assert.equal(snapshot.forkLeafId, lastForkEntryId, "the fork reaches the last persisted tool result of the open turn");
    assert.equal(snapshot.entries.length, 3, "the open turn's persisted entries are all forked");

    const settingsManager = SettingsManager.create(workspace, agentDir);
    settingsManager.setProjectTrusted(true);
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "deterministic-test-key" }));
    const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
    registry = new ModelRegistry(modelRuntime);

    child = await createChildRuntime({
      snapshot,
      parentSessionManager: parentManager,
      parentIsIdle: () => parentIdle,
      parentUI: { theme: {} } as ExtensionUIContext,
      parentModelRegistry: registry,
      modelRuntime,
      agentDir,
      callbacks: {
        onEvent() {},
        onNotice() {},
        onChildStatus() {},
        onRequestClose() {},
      },
    });

    // Session construction resets Pi's compatibility provider registry; install
    // the deterministic echo stream only after the child session exists.
    registry.registerProvider(PROVIDER, {
      api: API,
      streamSimple: (selectedModel, context) => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => pushText(stream, selectedModel, `MID-TURN CHILD REPLY: ${latestUserText(context)}`));
        return stream;
      },
    });

    const forkContext = child.session.sessionManager.buildSessionContext();
    assert.deepEqual(
      forkContext.messages.map((message) => message.role),
      ["user", "assistant", "toolResult"],
      "the mid-turn tool round is part of the child's context",
    );

    await child.prompt("what does beta-7 mean?");
    assert.match(
      child.session.getLastAssistantText() ?? "",
      /MID-TURN CHILD REPLY: what does beta-7 mean\?/,
      "a child forked mid-turn processes prompts without session or serialization errors",
    );

    assert.equal(await child.announceParentUpdate(), false, "the fork prefix alone is never announced");

    parentManager.appendMessage(assistantMessage("parent turn finished", 4));
    parentIdle = true;
    assert.equal(await child.announceParentUpdate(), true, "the completion of the mid-flight turn is announced");
    assert.equal(await child.announceParentUpdate(), false, "the completed head is announced only once");
  } finally {
    if (child) await child.close();
    registry?.unregisterProvider(PROVIDER);
    await rm(agentDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parent and BTW child overlap, mutate files, pull updates, isolate history, and clean up", { timeout: 10_000 }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "btw-integration-workspace-"));
  const agentDir = await mkdtemp(join(tmpdir(), "btw-integration-agent-"));
  const scratchFile = join(workspace, "child-scratch.txt");
  const barrier = new OverlapBarrier();
  let parent: AgentSession | undefined;
  let child: ChildRuntimeHandle | undefined;
  let parentRegistry: ModelRegistry | undefined;
  let parentRuntime: ModelRuntime | undefined;

  try {
    const parentManager = SessionManager.inMemory(workspace);
    parentManager.appendMessage({ role: "user", content: "summarized parent question", timestamp: 1 });
    parentManager.appendMessage(assistantMessage("summarized parent answer", 2));
    const firstKeptEntryId = parentManager.appendMessage({ role: "user", content: "kept parent question", timestamp: 3 });
    parentManager.appendMessage(assistantMessage("kept parent answer", 4));
    const compactionId = parentManager.appendCompaction(
      "REAL PARENT COMPACTION SUMMARY",
      firstKeptEntryId,
      4_096,
    );

    const fixtureContext = parentManager.buildSessionContext();
    assert.deepEqual(fixtureContext.messages.map((message) => message.role), [
      "compactionSummary",
      "user",
      "assistant",
    ]);
    assert.equal(
      fixtureContext.messages[0]?.role === "compactionSummary" && fixtureContext.messages[0].summary,
      "REAL PARENT COMPACTION SUMMARY",
    );

    const settingsManager = SettingsManager.create(workspace, agentDir);
    settingsManager.setProjectTrusted(true);
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(PROVIDER, async () => ({ type: "api_key", key: "deterministic-test-key" }));
    parentRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
    parentRegistry = new ModelRegistry(parentRuntime);
    const created = await createAgentSession({
      cwd: workspace,
      agentDir,
      model,
      thinkingLevel: "off",
      tools: ["write"],
      sessionManager: parentManager,
      settingsManager,
      modelRuntime: parentRuntime,
      resourceLoader,
    });
    parent = created.session;

    const snapshot = snapshotParent(
      parentSnapshotContext(parent, workspace),
      parent.model,
      parent.thinkingLevel,
      parent.getActiveToolNames(),
    );
    assert.ok(snapshot.entries.some((entry) => entry.type === "compaction" && entry.id === compactionId));

    child = await createChildRuntime({
      snapshot,
      parentSessionManager: parent.sessionManager,
      parentIsIdle: () => parent?.isIdle ?? true,
      parentUI: { theme: {} } as ExtensionUIContext,
      parentModelRegistry: parentRegistry,
      modelRuntime: parentRuntime,
      agentDir,
      callbacks: {
        onEvent() {},
        onNotice() {},
        onChildStatus() {},
        onRequestClose() {},
      },
    });

    assert.equal(await pathExists(child.tempDir), true);
    assert.equal(parent.getActiveToolNames().includes(CHECK_PARENT_UPDATES_TOOL), false);
    assert.equal(child.session.getActiveToolNames().includes(CHECK_PARENT_UPDATES_TOOL), true);

    // Session construction resets Pi's compatibility provider registry. Install
    // the deterministic stream only after both real sessions exist.
    parentRegistry.registerProvider(PROVIDER, {
      api: API,
      streamSimple: (selectedModel, context, options) => controlledStream(barrier, scratchFile, selectedModel, context, options),
    });

    const childForkContext = child.session.sessionManager.buildSessionContext();
    assert.deepEqual(childForkContext.messages.map((message) => message.role), [
      "compactionSummary",
      "user",
      "assistant",
    ]);
    assert.equal(
      childForkContext.messages[0]?.role === "compactionSummary" && childForkContext.messages[0].summary,
      "REAL PARENT COMPACTION SUMMARY",
    );

    const parentEvents: string[] = [];
    const childEvents: string[] = [];
    const unsubscribeParent = parent.subscribe((event) => parentEvents.push(event.type));
    const unsubscribeChild = child.session.subscribe((event) => childEvents.push(event.type));
    let parentSettled = false;
    let childSettled = false;
    const parentTurn = parent.prompt(PARENT_OVERLAP_PROMPT).finally(() => {
      parentSettled = true;
    });
    const childTurn = child.prompt(CHILD_WRITE_PROMPT).finally(() => {
      childSettled = true;
    });

    await Promise.race([
      barrier.waitForBoth(),
      parentTurn.then(() => { throw new Error(`Parent turn settled before reaching overlap barrier: ${parent?.getLastAssistantText() ?? "no assistant text"}; events: ${parentEvents.join(",")}`); }),
      childTurn.then(() => { throw new Error(`Child turn settled before reaching overlap barrier: ${child?.session.getLastAssistantText() ?? "no assistant text"}; events: ${childEvents.join(",")}`); }),
    ]);
    assert.equal(parent.isStreaming, true, "parent should still be inside its blocked provider stream");
    assert.equal(child.session.isStreaming, true, "child should still be inside its blocked provider stream");
    assert.equal(parentSettled, false, "parent turn must not have completed before child reaches the barrier");
    assert.equal(childSettled, false, "child turn must not have completed before parent reaches the barrier");
    barrier.release("parent");
    await parentTurn;
    assert.equal(parentSettled, true);
    assert.equal(childSettled, false);
    assert.equal(child.session.isStreaming, true, "child remains in its original blocked run after parent settles");
    const parentAfterOverlappingSettlement = parent.sessionManager.getEntries();
    const childEntriesBeforeStreamingAnnouncement = child.session.sessionManager.getEntries();
    const queuedChildPull = child.prompt(CHILD_PULL_PROMPT);
    assert.equal(child.session.pendingMessageCount, 0, "later prompts are serialized locally, never in Pi's follow-up queue");
    assert.equal(await child.announceParentUpdate(), true, "parent settlement is announced while the child is streaming");
    assert.deepEqual(parent.sessionManager.getEntries(), parentAfterOverlappingSettlement);
    assert.deepEqual(
      child.session.sessionManager.getEntries(),
      childEntriesBeforeStreamingAnnouncement,
      "next-turn availability stays queued instead of mutating the active child run",
    );
    assert.equal(child.session.isStreaming, true, "availability does not settle or continue the active child run");
    assert.equal(
      child.session.sessionManager.getEntries().some((entry) => entryMessageText(entry).includes(CHILD_PULL_PROMPT)),
      false,
      "the later local prompt cannot start before the current child run settles",
    );

    barrier.release("child");
    await Promise.all([childTurn, queuedChildPull]);
    assert.equal(await readFile(scratchFile, "utf8"), SCRATCH_CONTENT);
    assert.match(
      child.session.getLastAssistantText() ?? "",
      /CHILD PULLED UPDATE/,
      "the later prompt runs only after deferred hidden availability is inserted",
    );

    await parent.prompt(PARENT_UPDATE_PROMPT);
    const parentEntriesBeforeAnnouncement = parent.sessionManager.getEntries();
    const childEventCountBeforeAnnouncement = child.session.sessionManager.getEntries().length;
    assert.equal(await child.announceParentUpdate(), true);
    assert.equal(await child.announceParentUpdate(), false, "the completed parent head is announced only once");
    assert.deepEqual(parent.sessionManager.getEntries(), parentEntriesBeforeAnnouncement);
    assert.equal(
      child.session.sessionManager.getEntries().some((entry) => entryMessageText(entry).includes(PARENT_UPDATE_TEXT)),
      false,
      "the availability event must not import completed parent content",
    );
    const availabilityEntries = child.session.sessionManager.getEntries().filter((entry) =>
      entry.type === "custom_message" && entry.customType === PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE
    );
    assert.equal(child.session.sessionManager.getEntries().length, childEventCountBeforeAnnouncement + 1);
    assert.equal(availabilityEntries.length, 2, "streaming and later idle settlements are both recorded");
    assert.ok(availabilityEntries.every((entry) => entry.type === "custom_message" && entry.display === false));
    assert.ok(availabilityEntries.every((entry) => entry.type === "custom_message" && entry.content === PARENT_UPDATE_AVAILABLE_MESSAGE));

    await child.prompt(CHILD_PULL_PROMPT);

    const parentEntries = parent.sessionManager.getEntries();
    const childEntries = child.session.sessionManager.getEntries();
    const pulledUpdateResult = findToolResult(childEntries, CHECK_PARENT_UPDATES_TOOL);

    assert.ok(parentEntries.some((entry) => entryMessageText(entry).includes(PARENT_UPDATE_TEXT)));
    assert.equal(parentEntries.some((entry) => entryMessageText(entry).includes(CHILD_WRITE_PROMPT)), false);
    assert.equal(parentEntries.some((entry) => entryMessageText(entry).includes(CHILD_PULL_PROMPT)), false);
    assert.equal(hasToolCall(parentEntries, "write"), false);
    assert.equal(hasToolCall(parentEntries, CHECK_PARENT_UPDATES_TOOL), false);
    assert.equal(hasToolResult(parentEntries, "write"), false);
    assert.equal(hasToolResult(parentEntries, CHECK_PARENT_UPDATES_TOOL), false);
    assert.equal(parentEntries.some((entry) => entryMessageText(entry).includes("Completed parent updates follow.")), false);

    assert.ok(childEntries.some((entry) => entryMessageText(entry).includes(CHILD_WRITE_PROMPT)));
    assert.ok(childEntries.some((entry) => entryMessageText(entry).includes(CHILD_PULL_PROMPT)));
    assert.equal(hasToolCall(childEntries, "write"), true);
    assert.equal(hasToolResult(childEntries, "write"), true);
    assert.equal(hasToolCall(childEntries, CHECK_PARENT_UPDATES_TOOL), true);
    assert.ok(pulledUpdateResult);
    assert.equal(pulledUpdateResult.message.role, "toolResult");
    if (pulledUpdateResult.message.role !== "toolResult") assert.fail("expected child tool result");
    assert.equal(pulledUpdateResult.message.toolName, CHECK_PARENT_UPDATES_TOOL);
    assert.equal((pulledUpdateResult.message.details as { status?: unknown } | undefined)?.status, "updates");
    assert.match(textOfContent(pulledUpdateResult.message.content), /Completed parent updates follow\./);
    assert.match(textOfContent(pulledUpdateResult.message.content), /PARENT UPDATE TOKEN: alpha-42/);
    assert.ok(childEntries.some((entry) => entryMessageText(entry).includes(PARENT_UPDATE_TEXT)));
    assert.ok(childEntries.some((entry) => entryMessageText(entry).includes("Completed parent updates follow.")));
    assert.match(child.session.getLastAssistantText() ?? "", /CHILD PULLED UPDATE/);
    assert.match(child.session.getLastAssistantText() ?? "", /PARENT UPDATE TOKEN: alpha-42/);
    const consumedAvailabilityEntries = childEntries.filter((entry) =>
      entry.type === "custom_message" && entry.customType === PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE
    );
    assert.equal(consumedAvailabilityEntries.length, 2, "queued and idle availability events both survive in child context");
    assert.deepEqual(
      new Set(consumedAvailabilityEntries.map((entry) =>
        entry.type === "custom_message"
          ? (entry.details as { parentHeadId?: unknown } | undefined)?.parentHeadId
          : undefined
      )),
      new Set([
        parentAfterOverlappingSettlement.at(-1)?.id,
        parentEntriesBeforeAnnouncement.at(-1)?.id,
      ]),
    );

    unsubscribeParent();
    unsubscribeChild();
    const childTempDir = child.tempDir;
    await child.close();
    child = undefined;
    assert.equal(await pathExists(childTempDir), false);
    assert.equal(await readFile(scratchFile, "utf8"), SCRATCH_CONTENT);
  } finally {
    barrier.release();
    if (child) await child.close();
    if (parent) {
      await parent.abort();
      parent.dispose();
    }
    parentRegistry?.unregisterProvider(PROVIDER);
    await rm(agentDir, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});
