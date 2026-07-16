import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const testModelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
const inMemoryRegistry = () => new ModelRegistry(testModelRuntime);
import { selectCompletedBranch, type ForkSnapshot } from "../src/fork.ts";
import {
  CHECK_PARENT_UPDATES_TOOL,
  createChildRuntime,
  filterBtwExtensions,
  PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE,
  PARENT_UPDATE_AVAILABLE_MESSAGE,
} from "../src/runtime.ts";

const model = {
  id: "deterministic-no-call",
  name: "Deterministic no-call",
  api: "btw-test-api",
  provider: "test",
  baseUrl: "http://127.0.0.1/never-called",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_000,
} as Model<any>;

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("resource loader excludes BTW itself while retaining sibling extensions", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "btw-recursion-loader-"));
  const btwDir = join(agentDir, "extensions", "btw");
  const siblingDir = join(agentDir, "extensions", "sibling");
  await mkdir(btwDir, { recursive: true });
  await mkdir(siblingDir, { recursive: true });
  await writeFile(join(btwDir, "index.ts"), `export default function (pi) { pi.registerCommand("recursive_btw", { handler() {} }); }`, "utf8");
  await writeFile(join(siblingDir, "index.ts"), `export default function (pi) { pi.registerCommand("sibling_kept", { handler() {} }); }`, "utf8");

  try {
    const settingsManager = SettingsManager.create("/tmp/btw-recursion-loader", agentDir);
    settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: "/tmp/btw-recursion-loader",
      agentDir,
      settingsManager,
      extensionsOverride(base) {
        const filtered = filterBtwExtensions(base.extensions, btwDir);
        return { ...base, extensions: filtered.extensions };
      },
    });
    await loader.reload();
    const extensions = loader.getExtensions().extensions;
    assert.equal(extensions.some((extension) => extension.resolvedPath.startsWith(btwDir)), false);
    assert.equal(extensions.some((extension) => extension.resolvedPath.startsWith(siblingDir)), true);
    assert.equal(extensions.some((extension) => extension.commands.has("recursive_btw")), false);
    assert.equal(extensions.some((extension) => extension.commands.has("sibling_kept")), true);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("runtime-construction failure emits shutdown and removes all temp residue", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "btw-failure-agent-"));
  const tempRoot = await mkdtemp(join(tmpdir(), "btw-failure-temp-root-"));
  const observerDir = join(agentDir, "extensions", "cleanup-observer");
  const shutdownMarker = join(agentDir, "shutdown-observed.txt");
  await mkdir(observerDir, { recursive: true });
  await writeFile(join(observerDir, "index.ts"), `
import { writeFile } from "node:fs/promises";
export default function (pi) {
  pi.on("session_shutdown", async () => {
    await writeFile(${JSON.stringify(shutdownMarker)}, "shutdown", "utf8");
  });
}
`, "utf8");
  const parent = SessionManager.inMemory("/tmp/btw-runtime-failure-test");
  const entries = parent.getBranch();

  try {
    await assert.rejects(createChildRuntime({
      snapshot: {
        cwd: "/tmp/btw-runtime-failure-test",
        entries,
        entryIds: [],
        forkLeafId: null,
        model,
        thinkingLevel: "off",
        activeToolNames: ["definitely_missing_inherited_tool"],
        projectTrusted: true,
        systemPromptOptions: { cwd: "/tmp/btw-runtime-failure-test" },
        parentSessionFile: undefined,
      },
      parentSessionManager: parent,
      parentIsIdle: () => true,
      parentUI: { theme: {} } as ExtensionUIContext,
      parentModelRegistry: inMemoryRegistry(),
      modelRuntime: testModelRuntime,
      agentDir,
      tempRoot,
      callbacks: {
        onEvent() {},
        onNotice() {},
        onChildStatus() {},
        onRequestClose() {},
      },
    }), /could not inherit active tool.*definitely_missing_inherited_tool/);

    assert.equal(await readFile(shutdownMarker, "utf8"), "shutdown");
    assert.deepEqual(await readdir(tempRoot), [], "failed construction leaves no pi-btw temp directory");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("child re-asserts inherited active tools after an extension deactivates them at session_start", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "btw-repin-agent-"));
  // A sibling extension that, on session_start, recomputes a narrower active set and drops
  // inherited tools — mirroring how mcp-tool-loadout's budgeted setActiveTools override can
  // deactivate tools the parent had active. The child must still inherit the full set.
  const deactivatorDir = join(agentDir, "extensions", "tool-deactivator");
  await mkdir(deactivatorDir, { recursive: true });
  await writeFile(join(deactivatorDir, "index.ts"), `
export default function (pi) {
  pi.on("session_start", async () => {
    // Keep only "read" active, dropping the other inherited tools (a budget recompute).
    pi.setActiveTools(["read"]);
  });
}
`, "utf8");

  const parent = SessionManager.inMemory("/tmp/btw-repin-test");
  const entries = parent.getBranch();

  try {
    const child = await createChildRuntime({
      snapshot: {
        cwd: "/tmp/btw-repin-test",
        entries,
        entryIds: entries.map((entry) => entry.id),
        forkLeafId: null,
        model,
        thinkingLevel: "off",
        activeToolNames: ["read", "write"],
        projectTrusted: true,
        systemPromptOptions: { cwd: "/tmp/btw-repin-test" },
        parentSessionFile: undefined,
      },
      parentSessionManager: parent,
      parentIsIdle: () => true,
      parentUI: { theme: {} } as ExtensionUIContext,
      parentModelRegistry: inMemoryRegistry(),
      modelRuntime: testModelRuntime,
      agentDir,
      callbacks: {
        onEvent() {},
        onNotice() {},
        onChildStatus() {},
        onRequestClose() {},
      },
    });

    // The extension deactivated "write" and the child update tool at session_start, but BTW
    // re-pins the inherited set after binding, so every inherited tool stays active and
    // construction does not throw the "could not inherit active tool(s)" safety-net error.
    assert.deepEqual(
      new Set(child.session.getActiveToolNames()),
      new Set(["read", "write", CHECK_PARENT_UPDATES_TOOL]),
    );
    await child.close();
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("real child AgentSession is temp-backed, isolated, and cleans up idempotently without a model call", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "btw-agent-test-"));
  const parent = SessionManager.inMemory("/tmp/btw-runtime-test");
  parent.appendMessage({ role: "user", content: "parent only", timestamp: 1 });
  const parentEntryId = parent.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "parent answer" }],
    api: "btw-test-api",
    provider: "test",
    model: "deterministic-no-call",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const parentEntriesBefore = parent.getEntries();
  const entries = parent.getBranch() as SessionEntry[];
  const snapshot: ForkSnapshot = {
    cwd: "/tmp/btw-runtime-test",
    entries,
    entryIds: entries.map((entry) => entry.id),
    forkLeafId: parentEntryId,
    model,
    thinkingLevel: "off",
    activeToolNames: ["read", "write"],
    projectTrusted: true,
    systemPromptOptions: { cwd: "/tmp/btw-runtime-test" },
    parentSessionFile: undefined,
  };
  const parentRegistry = inMemoryRegistry();
  const ui = { theme: {} } as ExtensionUIContext;
  const childEvents: string[] = [];
  let parentIdle = true;

  try {
    const child = await createChildRuntime({
      snapshot,
      parentSessionManager: parent,
      parentIsIdle: () => parentIdle,
      parentUI: ui,
      parentModelRegistry: parentRegistry,
      modelRuntime: testModelRuntime,
      agentDir,
      callbacks: {
        onEvent(event) { childEvents.push(event.type); },
        onNotice() {},
        onChildStatus() {},
        onRequestClose() {},
      },
    });

    assert.equal(await pathExists(child.tempSessionFile), true);
    assert.equal(child.session.sessionFile, child.tempSessionFile);
    assert.deepEqual(child.session.getActiveToolNames(), ["read", "write", CHECK_PARENT_UPDATES_TOOL]);
    assert.deepEqual(parent.getEntries(), parentEntriesBefore);

    const childEntriesBefore = child.session.sessionManager.getEntries();
    parentIdle = false;
    parent.appendMessage({ role: "user", content: "incomplete parent turn", timestamp: 3 });
    assert.equal(await child.announceParentUpdate(), false, "an incomplete active turn cannot advance the completed head");
    assert.deepEqual(child.session.sessionManager.getEntries(), childEntriesBefore);

    const firstNewHead = parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "first completed parent update" }],
      api: "btw-test-api",
      provider: "test",
      model: "deterministic-no-call",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    });
    parentIdle = true;
    const parentAfterFirstSettlement = parent.getEntries();
    assert.equal(await child.announceParentUpdate(), true);
    assert.equal(await child.announceParentUpdate(), false, "the same completed parent head is announced once");
    assert.deepEqual(parent.getEntries(), parentAfterFirstSettlement, "announcement never mutates parent history");

    parentIdle = false;
    parent.appendMessage({ role: "user", content: "second parent turn", timestamp: 5 });
    const secondNewHead = parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second completed parent update" }],
      api: "btw-test-api",
      provider: "test",
      model: "deterministic-no-call",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 6,
    });
    parentIdle = true;
    const parentAfterSecondSettlement = parent.getEntries();
    assert.equal(await child.announceParentUpdate(), true);
    assert.equal(await child.announceParentUpdate(), false);
    assert.deepEqual(parent.getEntries(), parentAfterSecondSettlement);

    const availabilityEntries = child.session.sessionManager.getEntries().filter((entry) =>
      entry.type === "custom_message" && entry.customType === PARENT_UPDATE_AVAILABLE_CUSTOM_TYPE
    );
    assert.deepEqual(availabilityEntries.map((entry) => ({
      content: entry.type === "custom_message" ? entry.content : undefined,
      display: entry.type === "custom_message" ? entry.display : undefined,
      parentHeadId: entry.type === "custom_message"
        ? (entry.details as { parentHeadId?: unknown } | undefined)?.parentHeadId
        : undefined,
    })), [
      { content: PARENT_UPDATE_AVAILABLE_MESSAGE, display: false, parentHeadId: firstNewHead },
      { content: PARENT_UPDATE_AVAILABLE_MESSAGE, display: false, parentHeadId: secondNewHead },
    ]);
    assert.equal(childEvents.includes("agent_start"), false, "availability does not start a child turn");
    assert.equal(childEvents.includes("agent_settled"), false, "availability does not settle a child turn");

    const firstClose = child.close();
    const secondClose = child.close();
    assert.equal(firstClose, secondClose);
    await firstClose;
    assert.equal(await pathExists(child.tempDir), false);
    assert.deepEqual(parent.getEntries(), parentAfterSecondSettlement, "child close does not mutate parent history");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

const deterministicProviderSource = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export default function (pi) {
  pi.on("input", async (event) => {
    if (event.text === "late preflight tool") {
      globalThis.__btwInputStarted?.();
      await globalThis.__btwInputRelease;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  });

  pi.registerTool({
    name: "terminating_test_tool",
    label: "Terminating test tool",
    description: "End this deterministic test turn",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      globalThis.__btwToolCalls = (globalThis.__btwToolCalls ?? 0) + 1;
      return {
        content: [{ type: "text", text: "terminating tool result" }],
        details: { terminated: true },
        terminate: true,
      };
    },
  });

  pi.registerProvider("test", {
    api: "btw-test-api",
    baseUrl: "http://127.0.0.1/never-called",
    apiKey: "deterministic-test-key",
    models: [{
      id: "deterministic-no-call",
      name: "Deterministic no-call",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16000,
      maxTokens: 1000,
    }],
    streamSimple(model, context, options) {
      globalThis.__btwModelCalls = (globalThis.__btwModelCalls ?? 0) + 1;
      const stream = createAssistantMessageEventStream();
      const user = [...context.messages].reverse().find((message) => message.role === "user");
      const prompt = typeof user?.content === "string"
        ? user.content
        : (user?.content ?? []).map((block) => block.type === "text" ? block.text : "").join("");
      const start = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
      };

      if (prompt === "terminate via tool" || prompt === "late preflight tool") {
        if (context.messages.at(-1)?.role === "toolResult") {
          throw new Error("terminating tool unexpectedly triggered a follow-up model turn");
        }
        queueMicrotask(() => {
          const toolCall = { type: "toolCall", id: "terminating-call", name: "terminating_test_tool", arguments: {} };
          const partial = { ...start, content: [], stopReason: "toolUse" };
          stream.push({ type: "start", partial });
          partial.content.push({ ...toolCall, arguments: {} });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial });
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial });
          partial.content[0] = toolCall;
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
          stream.push({ type: "done", reason: "toolUse", message: partial });
          stream.end(partial);
        });
        return stream;
      }

      if (prompt === "hold until abort") {
        const abort = () => {
          const aborted = { ...start, content: [], stopReason: "aborted", errorMessage: "Request aborted" };
          stream.push({ type: "error", reason: "aborted", error: aborted });
          stream.end(aborted);
        };
        if (options?.signal?.aborted) queueMicrotask(abort);
        else options?.signal?.addEventListener("abort", abort, { once: true });
        return stream;
      }

      queueMicrotask(() => {
        const reply = "deterministic child reply: " + prompt;
        const partial = { ...start, content: [{ type: "text", text: reply }] };
        stream.push({ type: "start", partial: start });
        stream.push({ type: "text_start", contentIndex: 0, partial: start });
        stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial });
        stream.push({ type: "text_end", contentIndex: 0, content: reply, partial });
        stream.push({ type: "done", reason: "stop", message: partial });
        stream.end(partial);
      });
      return stream;
    },
  });
}
`;

test("deterministic child turn streams without touching parent history", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "btw-agent-stream-test-"));
  const extensionDir = join(agentDir, "extensions", "deterministic-provider");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(join(extensionDir, "index.ts"), deterministicProviderSource, "utf8");
  const parent = SessionManager.inMemory("/tmp/btw-runtime-stream-test");
  parent.appendMessage({ role: "user", content: "parent context", timestamp: 1 });
  const forkLeafId = parent.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "parent answer" }],
    api: "btw-test-api",
    provider: "test",
    model: "deterministic-no-call",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  });
  const parentEntriesBefore = parent.getEntries();
  const entries = parent.getBranch();
  const events: string[] = [];

  try {
    const child = await createChildRuntime({
      snapshot: {
        cwd: "/tmp/btw-runtime-stream-test",
        entries,
        entryIds: entries.map((entry) => entry.id),
        forkLeafId,
        model,
        thinkingLevel: "off",
        activeToolNames: ["read", "terminating_test_tool"],
        projectTrusted: true,
        systemPromptOptions: { cwd: "/tmp/btw-runtime-stream-test" },
        parentSessionFile: undefined,
      },
      parentSessionManager: parent,
      parentIsIdle: () => true,
      parentUI: { theme: {} } as ExtensionUIContext,
      parentModelRegistry: inMemoryRegistry(),
      modelRuntime: testModelRuntime,
      agentDir,
      callbacks: {
        onEvent(event) {
          events.push(event.type);
        },
        onNotice() {},
        onChildStatus() {},
        onRequestClose() {},
      },
    });

    const inputStarted = deferred();
    const inputRelease = deferred();
    const preflightState = globalThis as typeof globalThis & {
      __btwInputStarted?: () => void;
      __btwInputRelease?: Promise<void>;
      __btwModelCalls?: number;
      __btwToolCalls?: number;
    };
    preflightState.__btwInputStarted = inputStarted.resolve;
    preflightState.__btwInputRelease = inputRelease.promise;
    preflightState.__btwModelCalls = 0;
    preflightState.__btwToolCalls = 0;
    const latePrompt = child.prompt("late preflight tool");
    await inputStarted.promise;
    const cancellingPreflight = child.abort();
    inputRelease.resolve();
    await Promise.all([latePrompt, cancellingPreflight]);
    assert.equal(preflightState.__btwModelCalls, 0, "abort during delayed input prevents a late model call");
    assert.equal(preflightState.__btwToolCalls, 0, "no late tool work starts after abort begins");
    delete preflightState.__btwInputStarted;
    delete preflightState.__btwInputRelease;
    delete preflightState.__btwModelCalls;
    delete preflightState.__btwToolCalls;

    await child.prompt("child question");
    assert.match(child.session.getLastAssistantText() ?? "", /deterministic child reply: child question/);
    assert.ok(events.includes("message_update"));
    assert.ok(events.includes("agent_settled"));

    await child.prompt("terminate via tool");
    assert.equal(child.session.isIdle, true);
    const terminatingBranch = child.session.sessionManager.getBranch();
    assert.equal(
      terminatingBranch.some((entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.stopReason === "toolUse" &&
        entry.message.content.some((block) => block.type === "toolCall" && block.name === "terminating_test_tool")),
      true,
    );
    assert.equal(
      terminatingBranch.some((entry) =>
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "terminating_test_tool"),
      true,
    );
    assert.deepEqual(
      selectCompletedBranch(terminatingBranch, child.session.isIdle).map((entry) => entry.id),
      terminatingBranch.map((entry) => entry.id),
      "a real idle terminating batch is entirely completed",
    );

    const rapidFirst = child.prompt("rapid first");
    const rapidSecond = child.prompt("rapid second");
    await Promise.all([rapidFirst, rapidSecond]);
    const rapidPrompts = child.session.sessionManager.getEntries().flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      const content = entry.message.content;
      const text = typeof content === "string"
        ? content
        : content.map((block) => block.type === "text" ? block.text : "").join("");
      return text.startsWith("rapid ") ? [text] : [];
    });
    assert.deepEqual(rapidPrompts, ["rapid first", "rapid second"], "rapid admissions survive in order");
    assert.match(child.session.getLastAssistantText() ?? "", /deterministic child reply: rapid second/);

    const heldPrompt = child.prompt("hold until abort");
    while (!child.session.isStreaming) await new Promise((resolve) => setImmediate(resolve));
    const staleQueuedPrompt = child.prompt("stale queued prompt");
    assert.equal(child.session.pendingMessageCount, 0, "local serialization never uses Pi's prompt queues");
    const abortOrder: string[] = [];
    const originalAbortCompaction = child.session.abortCompaction.bind(child.session);
    const originalAbortBranchSummary = child.session.abortBranchSummary.bind(child.session);
    const originalAbort = child.session.abort.bind(child.session);
    child.session.abortCompaction = () => {
      abortOrder.push("compaction");
      originalAbortCompaction();
    };
    child.session.abortBranchSummary = () => {
      abortOrder.push("branch-summary");
      originalAbortBranchSummary();
    };
    child.session.abort = async () => {
      abortOrder.push("agent");
      await originalAbort();
    };
    await child.abort();
    assert.deepEqual(abortOrder.slice(0, 3), ["compaction", "branch-summary", "agent"]);
    await Promise.all([heldPrompt, staleQueuedPrompt]);
    assert.equal(child.session.pendingMessageCount, 0, "abort leaves Pi's child session queues empty");
    await child.prompt("after abort");
    const childText = child.session.sessionManager.getEntries().map((entry) => {
      if (entry.type !== "message") return "";
      const message = entry.message;
      if (message.role !== "user") return "";
      return typeof message.content === "string"
        ? message.content
        : message.content.map((block) => block.type === "text" ? block.text : "").join("");
    });
    assert.equal(childText.includes("stale queued prompt"), false, "cleared queued work never replays after abort");
    assert.match(child.session.getLastAssistantText() ?? "", /deterministic child reply: after abort/);

    assert.deepEqual(parent.getEntries(), parentEntriesBefore);
    assert.equal(
      parent.getEntries().some((entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.content === "child question"),
      false,
    );

    abortOrder.length = 0;
    const heldAtClose = child.prompt("hold until abort");
    while (!child.session.isStreaming) await new Promise((resolve) => setImmediate(resolve));
    const staleClosePrompt = child.prompt("stale close queued prompt");
    assert.equal(child.session.pendingMessageCount, 0, "close-bound work remains only in the local queue");
    const originalClearQueue = child.session.clearQueue.bind(child.session);
    let clearQueueCalls = 0;
    child.session.clearQueue = () => {
      clearQueueCalls += 1;
      return originalClearQueue();
    };
    const closing = child.close();
    await assert.rejects(child.prompt("must reject while closing"), /closing/);
    await Promise.all([heldAtClose, staleClosePrompt, closing]);
    assert.deepEqual(abortOrder.slice(0, 3), ["compaction", "branch-summary", "agent"]);
    assert.ok(clearQueueCalls >= 3, "close clears before abort, after prompt settlement, and after extension shutdown");
    assert.equal(child.session.pendingMessageCount, 0, "close clears Pi's queues before/after abort");
    const entriesAfterClose = child.session.sessionManager.getEntries();
    assert.equal(entriesAfterClose.some((entry) =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      (typeof entry.message.content === "string"
        ? entry.message.content === "stale close queued prompt"
        : entry.message.content.some((block) => block.type === "text" && block.text === "stale close queued prompt"))),
    false, "queued instruction does not execute while closing");
    assert.equal(await pathExists(child.tempDir), false);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
