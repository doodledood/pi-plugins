import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { selectForkBranch, snapshotParent, type ForkSnapshot } from "../src/fork.ts";
import {
  CHECK_PARENT_UPDATES_TOOL,
  filterBtwExtensions,
  inheritedRuntimeSpec,
  serializeFork,
} from "../src/runtime.ts";
import { ParentUpdateTracker } from "../src/updates.ts";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, parentId: string | null, message: AgentMessage): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-07-13T00:00:${id.padStart(2, "0")}.000Z`,
    message,
  };
}

function user(id: string, parentId: string | null, text: string): SessionEntry {
  return entry(id, parentId, { role: "user", content: text, timestamp: 1 });
}

function assistant(
  id: string,
  parentId: string,
  text: string,
  stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop",
): SessionEntry {
  return entry(id, parentId, {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "test",
    model: "deterministic",
    usage,
    stopReason,
    timestamp: 2,
  });
}

function modelEntry(id: string, parentId: string | null, modelId = "deterministic"): SessionEntry {
  return {
    type: "model_change",
    id,
    parentId,
    timestamp: `2026-07-13T00:01:${id.padStart(2, "0")}.000Z`,
    provider: "test",
    modelId,
  };
}

function customMessage(id: string, parentId: string, content: string): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: `2026-07-13T00:02:${id.padStart(2, "0")}.000Z`,
    customType: "idle-context",
    content,
    display: false,
  };
}

function managerFor(getBranch: () => SessionEntry[]): ExtensionContext["sessionManager"] {
  return { getBranch } as ExtensionContext["sessionManager"];
}

const model = {
  id: "deterministic",
  name: "Deterministic",
  api: "openai-responses",
  provider: "test",
  baseUrl: "http://127.0.0.1/never-called",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_000,
} as Model<any>;

function snapshot(entries: SessionEntry[]): ForkSnapshot {
  return {
    cwd: "/tmp/btw-workspace",
    entries,
    entryIds: entries.map((item) => item.id),
    forkLeafId: entries.at(-1)?.id ?? null,
    model,
    thinkingLevel: "high",
    activeToolNames: ["read", "edit"],
    projectTrusted: true,
    systemPromptOptions: { cwd: "/tmp/btw-workspace" },
    parentSessionFile: undefined,
  };
}

test("fork branch keeps trailing custom context whether the parent is idle or active", () => {
  const completed: SessionEntry[] = [
    user("01", null, "complete"),
    assistant("02", "01", "done"),
    {
      type: "custom_message",
      id: "03",
      parentId: "02",
      timestamp: "2026-07-13T00:00:03.000Z",
      customType: "idle-context",
      content: "completed idle context",
      display: false,
    },
  ];

  assert.deepEqual(selectForkBranch(completed, true).map((item) => item.id), ["01", "02", "03"]);
  assert.deepEqual(selectForkBranch(completed, false).map((item) => item.id), ["01", "02", "03"]);

  const context = (isIdle: boolean) => ({
    cwd: "/tmp/btw-workspace",
    sessionManager: {
      getBranch: () => completed,
      getSessionFile: () => undefined,
    },
    isIdle: () => isIdle,
    isProjectTrusted: () => true,
    getSystemPromptOptions: () => ({ cwd: "/tmp/btw-workspace" }),
  } as unknown as ExtensionCommandContext);
  assert.deepEqual(
    snapshotParent(context(true), model, "high", ["read"]).entryIds,
    ["01", "02", "03"],
    "snapshot includes completed custom context observed while parent is idle",
  );
  assert.deepEqual(
    snapshotParent(context(false), model, "high", ["read"]).entryIds,
    ["01", "02", "03"],
    "snapshot forks in place: persisted context is kept even while the parent is active",
  );
});

test("fork branch retains a resolved assistant/tool-result batch idle or active", () => {
  const toolUse = assistant("03", "02", "", "toolUse") as Extract<SessionEntry, { type: "message" }>;
  if (toolUse.message.role !== "assistant") assert.fail("expected assistant fixture");
  toolUse.message.content = [{
    type: "toolCall",
    id: "final-call",
    name: "structured_output",
    arguments: { result: "done" },
  }];
  const toolResult = entry("04", "03", {
    role: "toolResult",
    toolCallId: "final-call",
    toolName: "structured_output",
    content: [{ type: "text", text: "saved final result" }],
    details: { final: true },
    isError: false,
    timestamp: 3,
  });
  const entries = [user("01", null, "finish"), assistant("02", "01", "working"), toolUse, toolResult];

  assert.deepEqual(
    selectForkBranch(entries, true).map((item) => item.id),
    ["01", "02", "03", "04"],
    "idle means Pi has no model continuation after the terminating tool result",
  );
  assert.deepEqual(
    selectForkBranch(entries, false).map((item) => item.id),
    ["01", "02", "03", "04"],
    "a resolved tool batch is a valid fork point even while the parent is active",
  );
});

function toolUseAssistant(id: string, parentId: string, calls: Array<{ id: string; name?: string }>): SessionEntry {
  const base = assistant(id, parentId, "", "toolUse") as Extract<SessionEntry, { type: "message" }>;
  if (base.message.role !== "assistant") assert.fail("expected assistant fixture");
  base.message.content = calls.map((call) => ({
    type: "toolCall",
    id: call.id,
    name: call.name ?? "read",
    arguments: { path: "x" },
  }));
  return base;
}

function toolResultEntry(id: string, parentId: string, toolCallId: string): SessionEntry {
  return entry(id, parentId, {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: `result ${toolCallId}` }],
    isError: false,
    timestamp: 3,
  });
}

test("mid-turn fork keeps every persisted entry through the last complete tool-result batch", () => {
  const entries: SessionEntry[] = [
    user("01", null, "long running task"),
    toolUseAssistant("02", "01", [{ id: "call-1" }]),
    toolResultEntry("03", "02", "call-1"),
    toolUseAssistant("04", "03", [{ id: "call-2" }]),
    toolResultEntry("05", "04", "call-2"),
  ];

  assert.deepEqual(
    selectForkBranch(entries, false).map((item) => item.id),
    ["01", "02", "03", "04", "05"],
    "an open turn's persisted tool rounds are all part of the fork",
  );
});

test("fork branch trims only a dangling tool-use assistant and anything after it", () => {
  const dangling: SessionEntry[] = [
    user("01", null, "task"),
    toolUseAssistant("02", "01", [{ id: "call-1" }]),
    toolResultEntry("03", "02", "call-1"),
    toolUseAssistant("04", "03", [{ id: "call-2" }, { id: "call-3" }]),
    toolResultEntry("05", "04", "call-2"),
  ];
  assert.deepEqual(
    selectForkBranch(dangling, false).map((item) => item.id),
    ["01", "02", "03"],
    "an assistant with unresolved tool calls is dropped along with its partial results",
  );

  const endsWithUser: SessionEntry[] = [
    user("01", null, "first"),
    assistant("02", "01", "done"),
    user("03", "02", "queued follow-up"),
  ];
  assert.deepEqual(
    selectForkBranch(endsWithUser, false).map((item) => item.id),
    ["01", "02", "03"],
    "a branch ending in a user message is kept whole",
  );

  const endsWithTerminalAssistant: SessionEntry[] = [
    user("01", null, "first"),
    assistant("02", "01", "done"),
  ];
  assert.deepEqual(
    selectForkBranch(endsWithTerminalAssistant, false).map((item) => item.id),
    ["01", "02"],
    "a branch ending in a terminal assistant is kept whole",
  );

  const trailingNonMessage: SessionEntry[] = [
    user("01", null, "first"),
    toolUseAssistant("02", "01", [{ id: "call-1" }]),
    toolResultEntry("03", "02", "call-1"),
    customMessage("04", "03", "queued context"),
    modelEntry("05", "04"),
  ];
  assert.deepEqual(
    selectForkBranch(trailingNonMessage, false).map((item) => item.id),
    ["01", "02", "03", "04", "05"],
    "trailing non-message entries after a resolved batch are kept whole",
  );
});

test("serialized fork restores Pi's compaction-aware context", async () => {
  const entries: SessionEntry[] = [
    user("01", null, "old user"),
    assistant("02", "01", "old assistant"),
    user("03", "02", "kept user"),
    assistant("04", "03", "kept assistant"),
    {
      type: "compaction",
      id: "05",
      parentId: "04",
      timestamp: "2026-07-13T00:02:00.000Z",
      summary: "Earlier discussion summary",
      firstKeptEntryId: "03",
      tokensBefore: 100,
    },
  ];
  const dir = await mkdtemp(join(tmpdir(), "btw-fork-test-"));
  const file = join(dir, "fork.jsonl");
  try {
    await writeFile(file, serializeFork(snapshot(entries)), "utf8");
    const restored = SessionManager.open(file, dir, "/tmp/btw-workspace");
    const context = restored.buildSessionContext();
    assert.deepEqual(context.messages.map((message) => message.role), [
      "compactionSummary",
      "user",
      "assistant",
    ]);
    assert.equal(context.messages[0]?.role === "compactionSummary" && context.messages[0].summary, "Earlier discussion summary");
    assert.equal(context.messages[1]?.role === "user" && context.messages[1].content, "kept user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inherited runtime spec preserves cwd, model, thinking, tools and adds only the child tool", () => {
  const spec = inheritedRuntimeSpec(snapshot([]));
  assert.equal(spec.cwd, "/tmp/btw-workspace");
  assert.equal(spec.model, model);
  assert.equal(spec.thinkingLevel, "high");
  assert.deepEqual(spec.activeToolNames, ["read", "edit", CHECK_PARENT_UPDATES_TOOL]);
});

test("BTW extension paths are filtered without removing sibling resources", () => {
  const extensions = [
    { resolvedPath: "/home/me/.pi/agent/extensions/btw/index.ts" },
    { resolvedPath: "/home/me/.pi/agent/extensions/other/index.ts" },
  ] as unknown as Parameters<typeof filterBtwExtensions>[0];
  const result = filterBtwExtensions(extensions, "/home/me/.pi/agent/extensions/btw");
  assert.equal(result.removed, 1);
  assert.deepEqual(result.extensions.map((item) => item.resolvedPath), [
    "/home/me/.pi/agent/extensions/other/index.ts",
  ]);
});

test("parent updates are explicit: idle custom context participates in no-op and linear pulls", () => {
  let branch = [modelEntry("01", null), customMessage("02", "01", "already observed")];
  let parentIdle = true;
  const tracker = new ParentUpdateTracker(["01", "02"], {}, () => parentIdle);
  const manager = managerFor(() => branch);

  assert.equal(tracker.pull(manager).status, "no_updates");
  branch = [...branch, modelEntry("03", "02", "next"), customMessage("04", "03", "fresh idle context")];
  const result = tracker.pull(manager);
  assert.equal(result.status, "updates");
  assert.match(result.text, /model changed.*next/s);
  assert.match(result.text, /fresh idle context/);
  assert.equal(result.details.updateCount, 2);
  assert.equal(tracker.pull(manager).status, "no_updates");

  parentIdle = false;
  branch = [...branch, customMessage("05", "04", "active pending context")];
  const active = tracker.pull(manager);
  assert.equal(active.status, "updates", "persisted trailing context is pullable even while the parent is active");
  assert.match(active.text, /active pending context/);
  parentIdle = true;
  assert.equal(tracker.pull(manager).status, "no_updates");
});

test("mid-turn fork prefix reads as linear updates once the parent turn completes", () => {
  const forkPrefix: SessionEntry[] = [
    user("01", null, "long task"),
    toolUseAssistant("02", "01", [{ id: "call-1" }]),
    toolResultEntry("03", "02", "call-1"),
  ];
  let branch = [...forkPrefix];
  let parentIdle = false;
  const tracker = new ParentUpdateTracker(forkPrefix.map((item) => item.id), {}, () => parentIdle);
  const manager = managerFor(() => branch);

  assert.equal(tracker.pull(manager).status, "no_updates", "the fork prefix alone is not an update");

  branch = [
    ...branch,
    toolUseAssistant("04", "03", [{ id: "call-2" }]),
    toolResultEntry("05", "04", "call-2"),
    assistant("06", "05", "turn finished"),
  ];
  parentIdle = true;
  const completed = tracker.pull(manager);
  assert.equal(completed.status, "updates", "turn completion after a mid-turn fork is linear, not divergence");
  assert.equal(completed.details.updateCount, 3, "only entries after the fork prefix are delivered");
  assert.match(completed.text, /turn finished/);
  assert.equal(tracker.pull(manager).status, "no_updates");
});

test("parent update pull reports post-compaction context", () => {
  let branch: SessionEntry[] = [modelEntry("01", null)];
  const tracker = new ParentUpdateTracker(["01"]);
  branch = [
    ...branch,
    {
      type: "compaction",
      id: "02",
      parentId: "01",
      timestamp: "2026-07-13T00:03:00.000Z",
      summary: "Parent compacted summary",
      firstKeptEntryId: "01",
      tokensBefore: 900,
    },
    modelEntry("03", "02", "post-compact"),
  ];
  const result = tracker.pull(managerFor(() => branch));
  assert.equal(result.details.compacted, true);
  assert.match(result.text, /compacted its context/);
  assert.match(result.text, /Parent compacted summary/);
});

test("parent update char bounds preserve the newest conclusion and only advance when represented", () => {
  const latestToken = "LATEST-PARENT-CONCLUSION-TOKEN";
  const branch = [
    modelEntry("01", null),
    user("02", "01", `older material ${"x".repeat(500)}`),
    assistant("03", "02", `${"new conclusion context ".repeat(30)}${latestToken}`),
  ];
  const manager = managerFor(() => branch);
  const tracker = new ParentUpdateTracker(["01"], { maxEntries: 10, maxChars: 180 });
  const result = tracker.pull(manager);

  assert.equal(result.details.truncated, true);
  assert.match(result.text, new RegExp(latestToken));
  assert.equal(tracker.pull(manager).status, "no_updates", "represented newest content may advance to head");

  const zeroBudget = new ParentUpdateTracker(["01"], { maxEntries: 10, maxChars: 0 });
  assert.equal(zeroBudget.pull(manager).details.returnedCount, 0);
  assert.equal(zeroBudget.pull(manager).status, "updates", "unrepresented newest content remains available on the next pull");
});

test("post-compaction bounds retain both the compaction summary and latest conclusion", () => {
  const branch: SessionEntry[] = [
    modelEntry("01", null),
    {
      type: "compaction",
      id: "02",
      parentId: "01",
      timestamp: "2026-07-13T00:03:00.000Z",
      summary: `${"summary ".repeat(30)}COMPACTION-SUMMARY-TOKEN`,
      firstKeptEntryId: "01",
      tokensBefore: 900,
    },
    assistant("03", "02", `${"latest ".repeat(30)}LATEST-AFTER-COMPACTION-TOKEN`),
  ];
  const tracker = new ParentUpdateTracker(["01"], { maxEntries: 10, maxChars: 240 });
  const result = tracker.pull(managerFor(() => branch));

  assert.equal(result.details.compacted, true);
  assert.match(result.text, /COMPACTION-SUMMARY-TOKEN/);
  assert.match(result.text, /LATEST-AFTER-COMPACTION-TOKEN/);
});

test("parent update pull reports divergence and bounds normalized output", () => {
  const tracker = new ParentUpdateTracker(["01", "02"], { maxEntries: 2, maxChars: 140 });
  const branch = [
    modelEntry("01", null),
    modelEntry("03", "01", "branch-a"),
    modelEntry("04", "03", "branch-b"),
    modelEntry("05", "04", "branch-c"),
  ];
  const result = tracker.pull(managerFor(() => branch));
  assert.equal(result.status, "diverged");
  assert.equal(result.details.commonEntryId, "01");
  assert.equal(result.details.truncated, true);
  assert.ok(result.text.length < 500);
  assert.match(result.text, /reconcile/);
});
