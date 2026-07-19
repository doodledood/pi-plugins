import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerCheckerModelBootstrap as registerRealModelAliasesBootstrap } from "../../../model-aliases/extensions/model-aliases/index.ts";
import realModelAliasesCheckerBootstrap from "../../../model-aliases/extensions/model-aliases/checker-bootstrap.ts";
import { createEventBus, type AgentEndEvent, type BeforeAgentStartEvent, type ExtensionCommandContext, type ExtensionContext, type SessionStartEvent, type SessionTreeEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { activate, activeStatusRefreshDelayMs, formatStatus } from "./index.ts";
import {
  CHECKER_MODEL_BOOTSTRAP_KIND,
  CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION,
  CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL,
  CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL,
  CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE,
} from "./checker-model-bootstrap.ts";
import { PiSubprocessCheckerRunner, type CheckerRunner, type CheckerRunInput } from "./checker.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { createGoal, markChecking } from "./controller.ts";
import type { GoalControllerHost, CapturedHandlers } from "./host.ts";
import type { ActiveGoal, CheckerVerdict, SessionEntryLike } from "./types.ts";

class FakeChecker implements CheckerRunner {
  public readonly inputs: CheckerRunInput[] = [];
  public constructor(private readonly verdicts: CheckerVerdict[], private readonly onRun?: () => void) {}

  public async run(input: CheckerRunInput): Promise<CheckerVerdict> {
    this.inputs.push(input);
    this.onRun?.();
    const verdict = this.verdicts.shift();
    if (!verdict) throw new Error("missing fake verdict");
    return verdict;
  }
}

class DeferredChecker implements CheckerRunner {
  public readonly inputs: CheckerRunInput[] = [];
  private readonly pending: Array<{ resolve: (verdict: CheckerVerdict) => void; reject: (error: Error) => void; settled: boolean }> = [];

  public async run(input: CheckerRunInput): Promise<CheckerVerdict> {
    this.inputs.push(input);
    return new Promise<CheckerVerdict>((resolve, reject) => {
      this.pending.push({ resolve, reject, settled: false });
    });
  }

  public resolve(verdict: CheckerVerdict, index = 0): void {
    const pending = this.pending[index];
    if (!pending || pending.settled) throw new Error("checker was not running");
    pending.settled = true;
    pending.resolve(verdict);
  }

  public reject(error: Error, index = 0): void {
    const pending = this.pending[index];
    if (!pending || pending.settled) throw new Error("checker was not running");
    pending.settled = true;
    pending.reject(error);
  }
}

class FakeHost implements GoalControllerHost {
  public readonly events = createEventBus();
  public readonly handlers: CapturedHandlers = {};
  public readonly tools: ToolDefinition[] = [];
  public readonly commandHandlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void> | void>();
  public commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void> | void) | undefined;
  public readonly customEntries: Array<{ customType: string; data?: unknown }> = [];
  public readonly sentMessages: Array<{ content: string; options?: { deliverAs?: "steer" | "followUp" } }> = [];

  public registerTool(tool: ToolDefinition): void {
    this.tools.push(tool);
  }

  public registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void }): void {
    this.commandHandlers.set(name, options.handler);
    if (name === "goal") this.commandHandler = options.handler;
  }

  public on<E extends keyof CapturedHandlers>(event: E, handler: NonNullable<CapturedHandlers[E]>): void {
    this.handlers[event] = handler;
  }

  public appendEntry<T = unknown>(customType: string, data?: T): void {
    this.customEntries.push({ customType, data });
  }

  public sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void {
    this.sentMessages.push({ content, options });
  }

  public readonly customMessages: Array<{ customType: string; content: string; details?: Record<string, unknown>; options?: { deliverAs?: "steer" | "followUp" | "nextTurn" } }> = [];

  public sendMessage(
    message: { customType: string; content: string; display: boolean; details?: Record<string, unknown> },
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void {
    this.customMessages.push({ customType: message.customType, content: message.content, details: message.details, options });
  }

  public getThinkingLevel(): "xhigh" {
    return "xhigh";
  }

  public async exec(): Promise<never> {
    throw new Error("fake host should not exec");
  }
}

interface CtxOptions {
  pending?: () => boolean;
  idle?: () => boolean;
  sessionFile?: string;
  leafId?: string | null;
  editorResult?: string;
  onEditor?: (title: string, prefill?: string) => void;
  onStatus?: (key: string, value: string | undefined) => void;
  onNotify?: (message: string, level?: string) => void;
  signal?: AbortSignal;
  theme?: { fg: (tone: string, text: string) => string };
}

function makeCtx(entries: SessionEntryLike[] = [], options: CtxOptions = {}): ExtensionCommandContext {
  const statuses: Record<string, string | undefined> = {};
  const notifications: string[] = [];
  return {
    cwd: "/tmp/goal-controller-smoke",
    mode: "json",
    hasUI: true,
    ui: {
      setStatus(key: string, value: string | undefined) {
        statuses[key] = value;
        options.onStatus?.(key, value);
      },
      theme: options.theme,
      notify(message: string, level?: string) {
        notifications.push(message);
        options.onNotify?.(message, level);
      },
      async editor(title: string, prefill?: string) {
        options.onEditor?.(title, prefill);
        return options.editorResult;
      },
    },
    sessionManager: {
      getBranch() {
        return entries;
      },
      getSessionFile() {
        return options.sessionFile ?? "/tmp/pi-current-session.jsonl";
      },
      getLeafId() {
        return options.leafId ?? entries.at(-1)?.id ?? "leaf-1";
      },
    },
    model: { provider: "openai", id: "gpt-5.5" },
    isIdle() {
      return options.idle?.() ?? true;
    },
    hasPendingMessages() {
      return options.pending?.() ?? false;
    },
    getContextUsage() {
      return undefined;
    },
    signal: options.signal,
  } as unknown as ExtensionCommandContext;
}

function agentEnd(text: string, toolUse = false, stopReason: "stop" | "toolUse" | "error" | "aborted" = "stop", errorMessage?: string): AgentEndEvent {
  return {
    type: "agent_end",
    messages: toolUse
      ? [
          { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {}, id: "call_1" }], stopReason: "toolUse" },
          { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
          { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
        ]
      : [{ role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage }],
  } as unknown as AgentEndEvent;
}

function latestGoal(host: FakeHost): { goal?: string; status?: string; consecutiveNoToolContinuations?: number; lastCheckerVerdict?: { complete?: boolean; decision?: string }; lastTransitionReason?: string } | undefined {
  return (host.customEntries.at(-1)?.data as { goal?: { goal?: string; status?: string; consecutiveNoToolContinuations?: number; lastCheckerVerdict?: { complete?: boolean; decision?: string }; lastTransitionReason?: string } } | undefined)?.goal;
}

function goalStatusLog(log: Array<{ key: string; value: string | undefined }>): Array<string | undefined> {
  return log.filter((entry) => entry.key === "goal-controller").map((entry) => entry.value);
}

function persistedCheckingGoal(text = "persisted checking goal"): ActiveGoal {
  return markChecking(createGoal(text, DEFAULT_CONFIG, 0, Date.now() - 10_000), Date.now() - 1_000);
}

test("active status shows only calm wall-clock elapsed from goal start", () => {
  const goal = createGoal("active elapsed goal", DEFAULT_CONFIG, 0, 0);
  assert.equal(formatStatus({ ...goal, timeUsedSeconds: 9999, turnsUsed: 99 }, undefined, 42_000), "goal active <1m");
  assert.equal(formatStatus({ ...goal, turnsUsed: 3 }, undefined, 5 * 60_000 + 42_000), "goal active 5m");
  assert.equal(formatStatus({ ...goal, turnsUsed: 8 }, undefined, 64 * 60_000 + 5_000), "goal active 1h 04m");
  assert.equal(formatStatus({ ...goal, turnsUsed: 12 }, undefined, 27 * 60 * 60_000), "goal active 1d 03h");
});

test("active status refresh waits until the next visible elapsed boundary", () => {
  const goal = createGoal("active refresh goal", DEFAULT_CONFIG, 0, 0);
  assert.equal(activeStatusRefreshDelayMs(goal, 0), 60_000);
  assert.equal(activeStatusRefreshDelayMs(goal, 42_000), 18_000);
  assert.equal(activeStatusRefreshDelayMs(goal, 60_000), 60_000);
  assert.equal(activeStatusRefreshDelayMs(goal, 119_999), 1);
  assert.equal(activeStatusRefreshDelayMs(goal, 27 * 60 * 60_000 + 42 * 60_000), 18 * 60_000);
  assert.equal(activeStatusRefreshDelayMs(goal, 27 * 60 * 60_000 + 59 * 60_000 + 59_999), 1);
});

test("published active goal status schedules from the same clock sample it displays", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalDateNow = Date.now;
  const scheduled: Array<{ delay: number; handle: ReturnType<typeof setTimeout> }> = [];
  const goal = createGoal("boundary goal", DEFAULT_CONFIG, 0, 0);
  let calls = 0;

  Date.now = () => (calls++ === 0 ? 24 * 60 * 60_000 - 1 : 24 * 60 * 60_000);
  globalThis.setTimeout = ((_handler: Parameters<typeof setTimeout>[0], timeout?: number) => {
    const handle = { unref() {} } as ReturnType<typeof setTimeout>;
    scheduled.push({ delay: Number(timeout), handle });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

  try {
    const host = new FakeHost();
    activate(host, new FakeChecker([]));
    const statuses: Array<{ key: string; value: string | undefined }> = [];
    const ctx = makeCtx([{ type: "custom", customType: "goal-controller-state", data: { goal } }], {
      onStatus: (key, value) => statuses.push({ key, value }),
    });

    await host.handlers.session_start?.({ type: "session_start", reason: "startup" } as SessionStartEvent, ctx);

    assert.equal(goalStatusLog(statuses).at(-1), "goal active 23h 59m");
    assert.equal(scheduled[0]?.delay, 1);
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("published active goal status highlights elapsed and keeps calm refresh timers", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalDateNow = Date.now;
  const scheduled: Array<{
    delay: number;
    cleared: boolean;
    handle: ReturnType<typeof setTimeout>;
    handler: Parameters<typeof setTimeout>[0];
    args: unknown[];
  }> = [];
  let now = 1_000_000;

  Date.now = () => now;
  globalThis.setTimeout = ((handler: Parameters<typeof setTimeout>[0], timeout?: number, ...args: unknown[]) => {
    const handle = { unref() {} } as ReturnType<typeof setTimeout>;
    scheduled.push({ delay: Number(timeout), cleared: false, handle, handler, args });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: string | number | NodeJS.Timeout) => {
    const entry = scheduled.find((candidate) => candidate.handle === handle);
    if (entry) entry.cleared = true;
  }) as typeof clearTimeout;

  try {
    const host = new FakeHost();
    activate(host, new FakeChecker([]));
    const statuses: Array<{ key: string; value: string | undefined }> = [];
    const ctx = makeCtx([], {
      onStatus: (key, value) => statuses.push({ key, value }),
      theme: { fg: (tone, text) => (tone === "thinkingHigh" ? `<high>${text}</high>` : text) },
    });

    await host.commandHandler?.("goal with calm active status", ctx);

    assert.equal(goalStatusLog(statuses).at(-1), "goal active <high><1m</high>");
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]!.delay, 60_000);
    assert.notEqual(scheduled[0]!.delay, 1_000);

    now += scheduled[0]!.delay;
    if (typeof scheduled[0]!.handler !== "function") throw new Error("expected function timeout handler");
    scheduled[0]!.handler(...scheduled[0]!.args);

    assert.equal(goalStatusLog(statuses).at(-1), "goal active <high>1m</high>");
    assert.equal(scheduled.length, 2);
    assert.equal(scheduled[1]!.delay, 60_000);

    await host.commandHandlers.get("goal_pause")?.("", ctx);

    assert.equal(scheduled[1]!.cleared, true);
    assert.equal(scheduled.length, 2);
    assert.equal(goalStatusLog(statuses).at(-1), "goal paused");
  } finally {
    Date.now = originalDateNow;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("extension registers one model-facing goal tool and user-only lifecycle commands", () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  assert.deepEqual(host.tools.map((tool) => tool.name), ["goal"]);
  assert.deepEqual([...host.commandHandlers.keys()].sort(), ["goal", "goal_clear", "goal_edit", "goal_pause", "goal_resume"]);
  assert.equal(host.commandHandler !== undefined, true);
  assert.equal(host.tools[0]?.description.includes("always creates a fresh goal"), true);
  assert.equal(host.tools[0]?.description.includes("prior non-live goal remains history"), true);
  assert.equal(host.tools[0]?.description.includes("never updates, edits, clears, pauses, resumes, or completes any existing goal"), true);
  assert.equal(host.tools[0]?.promptGuidelines?.some((guideline) => guideline.includes("Completed, paused, blocked, and budget-limited goals are not live")), true);
});

function validCheckerBootstrapRegistration(extensionPath = "/tmp/packages/extensions/model-aliases/extensions/model-aliases/checker-bootstrap.ts") {
  return {
    protocolVersion: CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION,
    kind: CHECKER_MODEL_BOOTSTRAP_KIND,
    toolSurface: CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE,
    packageName: "@doodledood/pi-model-aliases",
    extensionPath,
  };
}

test("checker model bootstrap registrations are collected before or after activation and passed to checker runs", async () => {
  assert.deepEqual(await checkerBootstrapPathsForLoadOrder("before-activate"), ["/tmp/packages/extensions/model-aliases/extensions/model-aliases/checker-bootstrap.ts"]);
  assert.deepEqual(await checkerBootstrapPathsForLoadOrder("after-activate"), ["/tmp/packages/extensions/model-aliases/extensions/model-aliases/checker-bootstrap.ts"]);
});

test("checker runs continue without bootstrap registrations when no provider advertises one", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    {
      decision: "complete",
      complete: true,
      reason: "all evidence proven",
      evidence: ["fake"],
      requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake" }],
    },
  ]);
  activate(host, checker);
  const ctx = makeCtx();

  await host.commandHandler?.("goal without model aliases", ctx);
  await host.handlers.agent_end?.(agentEnd("evidence is ready", true), ctx as ExtensionContext);

  assert.deepEqual(checker.inputs[0]?.checkerModelBootstrapPaths, []);
  assert.equal(latestGoal(host)?.status, "complete");
});

test("real model-aliases bootstrap producer advertises a path goal-controller trusts end-to-end", async () => {
  // Wire the REAL producer and REAL consumer on one shared event bus so the two
  // independently installed packages must actually agree on channel names and
  // registration shape — isolated per-package tests would miss a channel drift.
  const host = new FakeHost();
  registerRealModelAliasesBootstrap({ events: host.events });
  const checker = new FakeChecker([
    {
      decision: "complete",
      complete: true,
      reason: "all evidence proven",
      evidence: ["fake"],
      requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake" }],
    },
  ]);
  activate(host, checker);
  const ctx = makeCtx();

  await host.commandHandler?.("goal using real alias bootstrap", ctx);
  await host.handlers.agent_end?.(agentEnd("evidence is ready", true), ctx as ExtensionContext);

  const paths = checker.inputs[0]?.checkerModelBootstrapPaths ?? [];
  assert.equal(paths.length, 1);
  const bootstrapPath = paths[0]!;
  assert.equal(bootstrapPath.replaceAll("\\", "/").endsWith("/extensions/model-aliases/checker-bootstrap.ts"), true);
  // The advertised entrypoint must be a real, loadable extension factory (not a
  // stale/missing/no-op path) or the checker subprocess `-e` load would fail.
  assert.equal(existsSync(bootstrapPath), true);
  assert.equal(typeof realModelAliasesCheckerBootstrap, "function");
  // Guard against a no-op entrypoint regression: the bootstrap must actually
  // activate model aliases in the checker subprocess.
  assert.match(readFileSync(bootstrapPath, "utf8"), /activateModelAliases/u);
});

test("session_shutdown detaches checker bootstrap registration listener", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    {
      decision: "complete",
      complete: true,
      reason: "all evidence proven",
      evidence: ["fake"],
      requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake" }],
    },
  ]);
  activate(host, checker);
  const ctx = makeCtx();

  await host.handlers.session_shutdown?.({ type: "session_shutdown", reason: "reload" } as never, ctx as ExtensionContext);
  host.events.emit(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, validCheckerBootstrapRegistration());
  await host.commandHandler?.("old activation should ignore bootstrap after shutdown", ctx);
  await host.handlers.agent_end?.(agentEnd("evidence is ready", true), ctx as ExtensionContext);

  assert.deepEqual(checker.inputs[0]?.checkerModelBootstrapPaths, []);
});

async function checkerBootstrapPathsForLoadOrder(order: "before-activate" | "after-activate"): Promise<readonly string[] | undefined> {
  const host = new FakeHost();
  const advertiseBootstrap = (): void => {
    host.events.on(CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL, () => {
      const registration = validCheckerBootstrapRegistration();
      host.events.emit(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, registration);
      host.events.emit(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, registration);
      host.events.emit(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, { ...registration, extensionPath: "   " });
      host.events.emit(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, { ...registration, packageName: "untrusted-package" });
      host.events.emit(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, { ...registration, extensionPath: "/tmp/untrusted/index.ts" });
      host.events.emit(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, { notExtensionPath: "/tmp/ignored.ts" });
    });
  };
  if (order === "before-activate") advertiseBootstrap();
  const checker = new FakeChecker([
    {
      decision: "complete",
      complete: true,
      reason: "all evidence proven",
      evidence: ["fake"],
      requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake" }],
    },
  ]);
  activate(host, checker);
  if (order === "after-activate") advertiseBootstrap();
  const ctx = makeCtx();

  await host.commandHandler?.("goal using alias model", ctx);
  await host.handlers.agent_end?.(agentEnd("evidence is ready", true), ctx as ExtensionContext);

  assert.equal(latestGoal(host)?.status, "complete");
  return checker.inputs[0]?.checkerModelBootstrapPaths;
}

test("goal command supersedes a stopped paused goal with a fresh active goal", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const ctx = makeCtx();
  await host.commandHandler?.("old goal", ctx);
  const oldGoalId = (host.customEntries.at(-1)?.data as { goal?: { id?: string } } | undefined)?.goal?.id;

  await host.commandHandlers.get("goal_pause")?.("", ctx);
  assert.equal(latestGoal(host)?.status, "paused");

  await host.commandHandler?.("new goal", ctx);
  const nextGoal = host.customEntries.at(-1)?.data as { goal?: { id?: string; goal?: string; status?: string } } | undefined;
  assert.equal(nextGoal?.goal?.goal, "new goal");
  assert.equal(nextGoal?.goal?.status, "active");
  assert.notEqual(nextGoal?.goal?.id, oldGoalId);
});

test("model-facing goal tool supersedes a stopped paused goal with a fresh active goal", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const ctx = makeCtx();
  await host.commandHandler?.("old goal", ctx);
  const oldGoalId = (host.customEntries.at(-1)?.data as { goal?: { id?: string } } | undefined)?.goal?.id;

  await host.commandHandlers.get("goal_pause")?.("", ctx);
  assert.equal(latestGoal(host)?.status, "paused");

  const result = await host.tools[0]?.execute("tool-call-1", { goal: "new tool goal" }, undefined, undefined, ctx as ExtensionContext);
  const nextGoal = host.customEntries.at(-1)?.data as { goal?: { id?: string; goal?: string; status?: string } } | undefined;
  assert.match(result?.content[0]?.type === "text" ? result.content[0].text : "", /Goal started/iu);
  assert.equal(nextGoal?.goal?.goal, "new tool goal");
  assert.equal(nextGoal?.goal?.status, "active");
  assert.notEqual(nextGoal?.goal?.id, oldGoalId);
});

test("model-facing goal tool supersedes a completed goal with a fresh active goal", async () => {
  const host = new FakeHost();
  activate(
    host,
    new FakeChecker([
      {
        decision: "complete",
        complete: true,
        reason: "all evidence proven",
        evidence: ["fake"],
        requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake" }],
      },
    ]),
  );
  const ctx = makeCtx();
  await host.commandHandler?.("old completed goal", ctx);
  const oldGoalId = (host.customEntries.at(-1)?.data as { goal?: { id?: string } } | undefined)?.goal?.id;
  await host.handlers.agent_end?.(agentEnd("evidence is ready", true), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "complete");

  const result = await host.tools[0]?.execute("tool-call-1", { goal: "new tool goal" }, undefined, undefined, ctx as ExtensionContext);
  const nextGoal = host.customEntries.at(-1)?.data as { goal?: { id?: string; goal?: string; status?: string } } | undefined;
  assert.match(result?.content[0]?.type === "text" ? result.content[0].text : "", /Goal started/iu);
  assert.equal(nextGoal?.goal?.goal, "new tool goal");
  assert.equal(nextGoal?.goal?.status, "active");
  assert.notEqual(nextGoal?.goal?.id, oldGoalId);
});

test("goal_resume reactivates a completed goal without stale completion verdict", async () => {
  const host = new FakeHost();
  activate(
    host,
    new FakeChecker([
      {
        decision: "complete",
        complete: true,
        reason: "all evidence proven",
        evidence: ["fake"],
        requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake" }],
      },
    ]),
  );
  const ctx = makeCtx();
  await host.commandHandler?.("resumable completed goal", ctx);
  const oldGoalId = (host.customEntries.at(-1)?.data as { goal?: { id?: string } } | undefined)?.goal?.id;
  await host.handlers.agent_end?.(agentEnd("evidence is ready", true), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "complete");
  assert.equal(latestGoal(host)?.lastCheckerVerdict?.complete, true);

  await host.commandHandlers.get("goal_resume")?.("", ctx);

  const resumed = host.customEntries.at(-1)?.data as { goal?: { id?: string; status?: string; checkerHistory?: unknown[]; checkerIteration?: number; lastCheckerVerdict?: unknown } } | undefined;
  assert.equal(resumed?.goal?.id, oldGoalId);
  assert.equal(resumed?.goal?.status, "active");
  assert.equal(resumed?.goal?.lastCheckerVerdict, undefined);
  assert.equal(resumed?.goal?.checkerHistory?.length, 1);
  assert.equal(resumed?.goal?.checkerIteration, 1);
  assert.match(host.sentMessages.at(-1)?.content ?? "", /resumable completed goal/iu);
});

test("goal_edit with args replaces the current goal immediately", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const ctx = makeCtx();
  await host.commandHandler?.("old goal", ctx);
  await host.commandHandlers.get("goal_edit")?.("new goal", ctx);
  assert.equal(latestGoal(host)?.goal, "new goal");
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(host.sentMessages.at(-1)?.content.includes("new goal"), true);
});

test("bare goal_edit opens editor prefilled with current goal and replaces on submit", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  let editorTitle = "";
  let editorPrefill = "";
  const ctx = makeCtx([], {
    editorResult: "edited in ui",
    onEditor(title, prefill) {
      editorTitle = title;
      editorPrefill = prefill ?? "";
    },
  });
  await host.commandHandler?.("old goal", ctx);
  await host.commandHandlers.get("goal_edit")?.("", ctx);
  assert.equal(editorTitle, "Edit goal");
  assert.equal(editorPrefill, "old goal");
  assert.equal(latestGoal(host)?.goal, "edited in ui");
  assert.equal(latestGoal(host)?.status, "active");
});

test("command start, checker continuation, and no-tool threshold are wired", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    { decision: "continue", complete: false, reason: "need tests", nextTurnGuidance: "run tests" },
    { decision: "continue", complete: false, reason: "still no tests" },
    { decision: "continue", complete: false, reason: "still no tests" },
    { decision: "continue", complete: false, reason: "still no tests" },
  ]);
  activate(host, checker);
  const ctx = makeCtx();
  await host.handlers.session_start?.({ type: "session_start", reason: "startup" } as SessionStartEvent, ctx);
  await host.commandHandler?.("finish the smoke goal", ctx);
  assert.equal(host.sentMessages.length, 1);

  const before = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(before?.systemPrompt, undefined, "goal reminder never overrides the system prompt (cache stability)");
  assert.equal(String(before?.message?.content).includes("finish the smoke goal"), true);
  assert.equal(String(before?.message?.content).includes("cannot complete"), true);
  assert.equal(before?.message?.customType, "goal-controller-reminder");

  const secondStart = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "more work", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(secondStart?.message, undefined, "reminder injected once per (goal, activation), not every turn");
  assert.equal(secondStart?.systemPrompt, undefined);

  await host.handlers.agent_end?.(agentEnd("not done yet", true), ctx as ExtensionContext);
  assert.equal(checker.inputs.length, 1);
  assert.equal(checker.inputs[0]?.context.sessionFile, "/tmp/pi-current-session.jsonl");
  assert.equal(checker.inputs[0]?.context.currentLeafId, "leaf-1");
  assert.equal(checker.inputs[0]?.context.latestTurn.hadToolUse, true);
  assert.deepEqual(checker.inputs[0]?.context.latestTurn.toolNames, ["bash"]);
  assert.equal(host.sentMessages.length, 2);
  assert.match(host.sentMessages[1]?.content ?? "", /need tests/iu);

  await host.handlers.agent_end?.(agentEnd("still not done", false), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(host.sentMessages.length, 3);

  await host.handlers.agent_end?.(agentEnd("still not done", false), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(host.sentMessages.length, 4);

  await host.handlers.agent_end?.(agentEnd("still not done", false), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "blocked");
  assert.equal(host.sentMessages.length, 4);
});

test("user intervention resets pending no-tool continuation threshold", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    { decision: "continue", complete: false, reason: "need tests", nextTurnGuidance: "run tests" },
    { decision: "continue", complete: false, reason: "still no tests" },
    { decision: "continue", complete: false, reason: "still no tests" },
    { decision: "continue", complete: false, reason: "still no tests" },
    { decision: "continue", complete: false, reason: "still no tests" },
  ]);
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("finish the smoke goal", ctx);
  await host.handlers.agent_end?.(agentEnd("not done yet", true), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "active");

  await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "I have extra context", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  await host.handlers.agent_end?.(agentEnd("still not done", false), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(latestGoal(host)?.consecutiveNoToolContinuations, 0);

  await host.handlers.agent_end?.(agentEnd("still not done", false), ctx as ExtensionContext);
  await host.handlers.agent_end?.(agentEnd("still not done", false), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(latestGoal(host)?.consecutiveNoToolContinuations, 2);

  await host.handlers.agent_end?.(agentEnd("still not done", false), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "blocked");
});

test("missing user success evidence continues with ask-user guidance instead of blocking", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    {
      decision: "continue",
      complete: false,
      blocked: false,
      reason: "no laugh signal yet",
      nextTurnGuidance: "Ask the user whether any joke made them laugh; use a focused user-question tool if available.",
    },
  ]);
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("make me laugh", ctx);
  await host.handlers.agent_end?.(agentEnd("delivered jokes but no user reaction yet", false), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(latestGoal(host)?.lastCheckerVerdict?.decision, "continue");
  assert.equal(host.sentMessages.length, 2);
  assert.match(host.sentMessages[1]?.content ?? "", /ask the user/iu);
});

test("waiting_for_user verdict stops auto-continuation and resumes on next user turn", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    {
      decision: "waiting_for_user",
      complete: false,
      blocked: false,
      reason: "worker already asked whether the user laughed",
    },
  ]);
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("make me laugh", ctx);
  await host.handlers.agent_end?.(agentEnd("Did any of those make you laugh?", false), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "waiting_for_user");
  assert.equal(host.sentMessages.length, 1);

  const before = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(before?.systemPrompt, undefined, "resume transition still never touches the system prompt");
  assert.equal(String(before?.message?.content).includes("make me laugh"), true, "waiting->active transition re-injects the reminder");
});

test("checker-complete verdict completes without worker completion tool", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    {
      decision: "complete",
      complete: true,
      reason: "all evidence proven",
      evidence: ["fake"],
      requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake" }],
    },
  ]);
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("complete this smoke goal", ctx);
  await host.handlers.agent_end?.(agentEnd("evidence is ready", true), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "complete");
  assert.equal(latestGoal(host)?.lastCheckerVerdict?.complete, true);
});

test("unexpected checker failures are replaced before goal persistence and UI notification", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = makeCtx([], {
    onNotify: (message, level) => notifications.push({ message, level }),
  });
  await host.commandHandler?.("goal with secret-bearing checker failure", ctx);

  const run = host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  const omittedTail = "TAIL_MUST_NOT_PERSIST";
  checker.reject(new Error(`Goal checker model failed before returning a verdict. passphrase="correct horse battery staple" ${"x".repeat(5_000)}${omittedTail}`));
  await run;

  const goal = latestGoal(host);
  const persistedReason = goal?.lastTransitionReason ?? "";
  assert.equal(goal?.status, "paused");
  assert.match(persistedReason, /checker failed unexpectedly/iu);
  assert.match(persistedReason, /inspect local Pi logs/iu);
  assert.match(persistedReason, /effectiveModel=openai\/gpt-5\.5/iu);
  assert.ok(persistedReason.length < 200);
  assert.doesNotMatch(persistedReason, /correct horse battery staple/u);
  assert.doesNotMatch(persistedReason, new RegExp(omittedTail, "u"));
  const failureNotification = notifications.find(({ level }) => level === "error")?.message ?? "";
  assert.match(failureNotification, /checker failed unexpectedly/iu);
  assert.match(failureNotification, /inspect local Pi logs/iu);
  assert.match(failureNotification, /effectiveModel=openai\/gpt-5\.5/iu);
  assert.ok(failureNotification.length < 250);
  assert.doesNotMatch(failureNotification, /correct horse battery staple/u);
  assert.doesNotMatch(failureNotification, new RegExp(omittedTail, "u"));
});

test("recognized checker failures preserve fixed safe diagnostics through persistence and UI", async () => {
  const host = new FakeHost();
  const checker = new PiSubprocessCheckerRunner({
    async exec() {
      return {
        stdout: [
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              api: "openai-responses",
              provider: "openai",
              model: "gpt-5.5",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "error",
              errorMessage: "This request was blocked for reverse engineering or duplicating model outputs. apiKey=sk-must-not-persist",
              timestamp: 0,
            },
          },
          { type: "agent_end", messages: [], willRetry: false },
          { type: "agent_settled" },
        ].map((event) => JSON.stringify(event)).join("\n"),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  activate(host, checker);
  const notifications: Array<{ message: string; level?: string }> = [];
  const ctx = makeCtx([], { onNotify: (message, level) => notifications.push({ message, level }) });
  await host.commandHandler?.("goal with recognized checker failure", ctx);

  await host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext);

  const persistedReason = latestGoal(host)?.lastTransitionReason ?? "";
  assert.match(persistedReason, /provider refused the checker request/iu);
  assert.match(persistedReason, /effectiveModel=openai\/gpt-5\.5/iu);
  assert.doesNotMatch(persistedReason, /sk-must-not-persist/u);
  const failureNotification = notifications.find(({ level }) => level === "error")?.message ?? "";
  assert.match(failureNotification, /provider refused the checker request/iu);
  assert.match(failureNotification, /effectiveModel=openai\/gpt-5\.5/iu);
  assert.doesNotMatch(failureNotification, /sk-must-not-persist/u);
});

test("abort and error turns pause without running checker or persisting raw provider errors", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([]);
  activate(host, checker);
  const notifications: string[] = [];
  const ctx = makeCtx([], { onNotify: (message) => notifications.push(message) });
  await host.commandHandler?.("goal that gets interrupted", ctx);
  await host.handlers.agent_end?.(agentEnd("", false, "aborted"), ctx as ExtensionContext);
  assert.equal(checker.inputs.length, 0);
  assert.equal(latestGoal(host)?.status, "paused");
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /interruption/iu);

  await host.commandHandlers.get("goal_resume")?.("", ctx);
  const rawProviderError = "boom apiKey=sk-worker-secret123 correct horse battery staple";
  await host.handlers.agent_end?.(agentEnd("", false, "error", rawProviderError), ctx as ExtensionContext);
  assert.equal(checker.inputs.length, 0);
  assert.equal(latestGoal(host)?.status, "paused");
  const persistedReason = latestGoal(host)?.lastTransitionReason ?? "";
  assert.match(persistedReason, /agent error/iu);
  assert.match(persistedReason, /inspect local Pi logs/iu);
  assert.doesNotMatch(persistedReason, /boom|sk-worker-secret123|correct horse battery staple/u);
  assert.doesNotMatch(notifications.at(-1) ?? "", /boom|sk-worker-secret123|correct horse battery staple/u);

  await host.commandHandlers.get("goal_resume")?.("", ctx);
  const inconsistentProviderError = "stop-with-error token=sk-inconsistent-secret123";
  await host.handlers.agent_end?.(agentEnd("", false, "stop", inconsistentProviderError), ctx as ExtensionContext);
  const inconsistentReason = latestGoal(host)?.lastTransitionReason ?? "";
  assert.equal(latestGoal(host)?.status, "paused");
  assert.match(inconsistentReason, /agent error/iu);
  assert.doesNotMatch(inconsistentReason, /stop-with-error|sk-inconsistent-secret123/u);
  assert.doesNotMatch(notifications.at(-1) ?? "", /stop-with-error|sk-inconsistent-secret123/u);
});

test("pending messages after checker suppress continuation", async () => {
  let pending = false;
  const host = new FakeHost();
  const checker = new FakeChecker([{ decision: "continue", complete: false, reason: "need more evidence", nextTurnGuidance: "run test" }], () => {
    pending = true;
  });
  activate(host, checker);
  const ctx = makeCtx([], { pending: () => pending });
  await host.commandHandler?.("goal with pending race", ctx);
  await host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext);
  assert.equal(checker.inputs.length, 1);
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(host.sentMessages.length, 1);
});

test("non-idle state after checker queues follow-up continuation", async () => {
  let idle = true;
  const host = new FakeHost();
  const checker = new FakeChecker([{ decision: "continue", complete: false, reason: "need more evidence", nextTurnGuidance: "run test" }], () => {
    idle = false;
  });
  activate(host, checker);
  const ctx = makeCtx([], { idle: () => idle });
  await host.commandHandler?.("goal with idle race", ctx);
  await host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext);
  assert.equal(checker.inputs.length, 1);
  assert.equal(latestGoal(host)?.status, "active");
  assert.equal(host.sentMessages.length, 2);
  assert.equal(host.sentMessages[1]?.options?.deliverAs, "followUp");
  assert.match(host.sentMessages[1]?.content ?? "", /need more evidence/iu);
});

test("checker running publishes compact footer loading status and clears it on completion", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const ctx = makeCtx([], { onStatus: (key, value) => statuses.push({ key, value }) });
  await host.commandHandler?.("goal with visible checker", ctx);

  const first = host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));

  const goalStatuses = goalStatusLog(statuses);
  assert.match(goalStatuses.at(-1) ?? "", /^goal checking [^\s]+ 0:00\/5m$/u);
  assert.equal(checker.inputs.length, 1);
  assert.equal(checker.inputs[0]?.signal?.aborted, false);
  assert.equal(formatStatus(persistedCheckingGoal(), { startedAt: 0, timeoutMs: 300_000, frame: "⠋" }, 42_000), "goal checking ⠋ 0:42/5m");

  checker.resolve({
    decision: "complete",
    complete: true,
    reason: "all evidence proven",
    evidence: ["fake"],
    requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake" }],
  });
  await first;
  assert.equal(goalStatusLog(statuses).at(-1), "goal complete");
});

test("session_start recovers persisted checking as paused instead of live checking", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const checking = persistedCheckingGoal();
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const ctx = makeCtx([{ type: "custom", customType: "goal-controller-state", data: { goal: checking } }], {
    onStatus: (key, value) => statuses.push({ key, value }),
  });

  await host.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx);

  assert.equal(latestGoal(host)?.status, "paused");
  assert.notEqual(latestGoal(host)?.status, "checking");
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /session reload/iu);
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /\/goal_resume/iu);
  assert.equal(goalStatusLog(statuses).at(-1), "goal paused");
});

test("session_tree recovers persisted checking as paused instead of live checking", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const checking = persistedCheckingGoal();
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const ctx = makeCtx([{ type: "custom", customType: "goal-controller-state", data: { goal: checking } }], {
    onStatus: (key, value) => statuses.push({ key, value }),
  });

  await host.handlers.session_tree?.({ type: "session_tree" } as SessionTreeEvent, ctx);

  assert.equal(latestGoal(host)?.status, "paused");
  assert.notEqual(latestGoal(host)?.status, "checking");
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /session navigation/iu);
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /\/goal_resume/iu);
  assert.equal(goalStatusLog(statuses).at(-1), "goal paused");
});

test("goal_pause during checking aborts checker, persists pause, and ignores late result", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const ctx = makeCtx([], { onStatus: (key, value) => statuses.push({ key, value }) });
  await host.commandHandler?.("goal with cancellable checker", ctx);

  const first = host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checker.inputs[0]?.signal?.aborted, false);

  await host.commandHandlers.get("goal_pause")?.("", ctx);
  assert.equal(checker.inputs[0]?.signal?.aborted, true);
  assert.equal(latestGoal(host)?.status, "paused");
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /cancelled/iu);
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /user/iu);
  assert.equal(goalStatusLog(statuses).at(-1), "goal paused");

  checker.resolve({ decision: "continue", complete: false, reason: "late old result", nextTurnGuidance: "ignore me" });
  await first;
  assert.equal(latestGoal(host)?.status, "paused");
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /cancelled.*user|user.*cancelled/iu);
  assert.equal(goalStatusLog(statuses).at(-1), "goal paused");
  assert.equal(host.sentMessages.length, 1);
});

test("goal_pause during checking ignores late checker rejection without checker-failed notification", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const ctx = makeCtx([], {
    onNotify: (message, level) => notifications.push({ message, level }),
    onStatus: (key, value) => statuses.push({ key, value }),
  });
  await host.commandHandler?.("goal with checker that rejects after pause", ctx);

  const first = host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  await host.commandHandlers.get("goal_pause")?.("", ctx);

  const pausedReason = latestGoal(host)?.lastTransitionReason ?? "";
  assert.equal(checker.inputs[0]?.signal?.aborted, true);
  assert.equal(latestGoal(host)?.status, "paused");
  assert.match(pausedReason, /cancelled.*user|user.*cancelled/iu);
  assert.equal(goalStatusLog(statuses).at(-1), "goal paused");

  checker.reject(new Error("late checker failure after user pause"));
  await first;

  assert.equal(latestGoal(host)?.status, "paused");
  assert.equal(latestGoal(host)?.lastTransitionReason, pausedReason);
  assert.equal(goalStatusLog(statuses).at(-1), "goal paused");
  assert.equal(notifications.some(({ message }) => /checker failed/iu.test(message)), false);
  assert.equal(notifications.some(({ level }) => level === "error"), false);
});

test("goal_clear during checking aborts checker and ignores late resolution", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const ctx = makeCtx([], { onStatus: (key, value) => statuses.push({ key, value }) });
  await host.commandHandler?.("goal that gets cleared while checking", ctx);

  const first = host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checker.inputs[0]?.signal?.aborted, false);

  await host.commandHandlers.get("goal_clear")?.("", ctx);
  assert.equal(checker.inputs[0]?.signal?.aborted, true);
  assert.equal(latestGoal(host)?.status, "cleared");
  assert.equal(goalStatusLog(statuses).at(-1), undefined);
  const clearedGoalSnapshot = JSON.stringify(latestGoal(host));
  const clearedEntryCount = host.customEntries.length;
  const clearedStatusCount = goalStatusLog(statuses).length;

  checker.resolve({ decision: "continue", complete: false, reason: "late old result", nextTurnGuidance: "ignore me" });
  await first;
  assert.equal(JSON.stringify(latestGoal(host)), clearedGoalSnapshot);
  assert.equal(host.customEntries.length, clearedEntryCount);
  assert.equal(goalStatusLog(statuses).length, clearedStatusCount);
  assert.equal(goalStatusLog(statuses).at(-1), undefined);
  assert.equal(host.sentMessages.length, 1);
});

// Covers the rejection path separately from late resolution: an aborted checker may still reject later,
// but user-cleared goal state and status must stay cleared instead of being paused as checker-failed.
test("goal_clear during checking aborts checker and ignores late rejection", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const notifications: Array<{ message: string; level?: string }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const ctx = makeCtx([], {
    onNotify: (message, level) => notifications.push({ message, level }),
    onStatus: (key, value) => statuses.push({ key, value }),
  });
  await host.commandHandler?.("goal with checker that rejects after clear", ctx);

  const first = host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checker.inputs[0]?.signal?.aborted, false);

  await host.commandHandlers.get("goal_clear")?.("", ctx);
  assert.equal(checker.inputs[0]?.signal?.aborted, true);
  assert.equal(latestGoal(host)?.status, "cleared");
  assert.equal(goalStatusLog(statuses).at(-1), undefined);
  const clearedGoalSnapshot = JSON.stringify(latestGoal(host));
  const clearedEntryCount = host.customEntries.length;
  const clearedStatusCount = goalStatusLog(statuses).length;

  checker.reject(new Error("late checker failure after user clear"));
  await first;

  assert.equal(JSON.stringify(latestGoal(host)), clearedGoalSnapshot);
  assert.equal(host.customEntries.length, clearedEntryCount);
  assert.equal(goalStatusLog(statuses).length, clearedStatusCount);
  assert.equal(goalStatusLog(statuses).at(-1), undefined);
  assert.equal(notifications.some(({ message }) => /checker failed/iu.test(message)), false);
  assert.equal(notifications.some(({ level }) => level === "error"), false);
  assert.equal(host.sentMessages.length, 1);
});

test("late checker result from an old run cannot complete a resumed goal's current run", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("goal with repeated checker runs", ctx);

  const first = host.handlers.agent_end?.(agentEnd("first incomplete turn", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  await host.commandHandlers.get("goal_pause")?.("", ctx);
  assert.equal(checker.inputs[0]?.signal?.aborted, true);

  await host.commandHandlers.get("goal_resume")?.("", ctx);
  const second = host.handlers.agent_end?.(agentEnd("second verification turn", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checker.inputs.length, 2);
  assert.equal(checker.inputs[1]?.signal?.aborted, false);

  checker.resolve({
    decision: "complete",
    complete: true,
    reason: "stale first checker result",
    evidence: ["stale"],
    requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "stale" }],
  }, 0);
  await first;

  assert.equal(latestGoal(host)?.status, "checking");
  assert.notEqual(latestGoal(host)?.lastTransitionReason, "stale first checker result");

  checker.resolve({
    decision: "complete",
    complete: true,
    reason: "fresh second checker result",
    evidence: ["fresh"],
    requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fresh" }],
  }, 1);
  await second;

  assert.equal(latestGoal(host)?.status, "complete");
  assert.equal(latestGoal(host)?.lastTransitionReason, "fresh second checker result");
});

test("goal_edit during checking gives actionable pause or clear guidance", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const notifications: string[] = [];
  const ctx = makeCtx([], { onNotify: (message) => notifications.push(message) });
  await host.commandHandler?.("goal with edit blocked during checking", ctx);

  const first = host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  await host.commandHandlers.get("goal_edit")?.("new text", ctx);

  assert.match(notifications.at(-1) ?? "", /\/goal_pause/iu);
  assert.match(notifications.at(-1) ?? "", /\/goal_clear/iu);
  assert.equal(checker.inputs[0]?.signal?.aborted, false);

  checker.resolve({ decision: "continue", complete: false, reason: "continue", nextTurnGuidance: "more work" });
  await first;
});

test("concurrent agent_end while checker is running does not start a second checker", async () => {
  const host = new FakeHost();
  const checker = new DeferredChecker();
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("goal with slow checker", ctx);
  const first = host.handlers.agent_end?.(agentEnd("not done", true), ctx as ExtensionContext) as Promise<void>;
  await new Promise((resolve) => setImmediate(resolve));
  await host.handlers.agent_end?.(agentEnd("not done again", true), ctx as ExtensionContext);
  assert.equal(checker.inputs.length, 1);
  checker.resolve({ decision: "continue", complete: false, reason: "continue", nextTurnGuidance: "more work" });
  await first;
});

test("before_agent_start injects nothing without an active goal and reminder state survives session reload", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const entries: SessionEntryLike[] = [];
  const ctx = makeCtx(entries);

  // No goal at all: no message, no systemPrompt, in any state.
  const idle = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "hi", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(idle, undefined);

  // Active goal: first start injects, then a session reload that carries the
  // reminder entry in the branch must not re-inject a duplicate.
  await host.commandHandler?.("persist across reload", ctx);
  const injected = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.ok(injected?.message, "first start injects the reminder");
  const goalId = (injected?.message?.details as { goalId?: string })?.goalId;
  assert.ok(goalId, "reminder carries its goal id for reload recovery");

  // Simulate the reminder entry persisted in the branch, then reload. The
  // goal state entry must be present too so the goal survives the reload.
  entries.push({ type: "custom", customType: "goal-controller-state", data: { goal: latestGoal(host) } });
  entries.push({ type: "custom_message", customType: "goal-controller-reminder", details: { goalId } } as SessionEntryLike);
  await host.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx as ExtensionContext);
  const afterReload = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "more", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(afterReload?.message, undefined, "no duplicate reminder after reload");
});

test("goal_edit refreshes the reminder so the standing goal text is never stale", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const ctx = makeCtx();
  await host.commandHandler?.("original goal text", ctx);
  const first = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.ok(String(first?.message?.content).includes("original goal text"));

  await host.commandHandlers.get("goal_edit")?.("edited goal text", ctx);
  const second = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.ok(second?.message, "edited goal re-injects the reminder");
  assert.ok(String(second?.message?.content).includes("edited goal text"), "reminder carries the updated goal text");
});

test("compaction drops the reminder from context and the next start re-injects it", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const entries: SessionEntryLike[] = [];
  const ctx = makeCtx(entries);
  await host.commandHandler?.("long compacting goal", ctx);
  const first = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.ok(first?.message, "initial injection");

  // In-process compaction event: reminder is summarized out of context.
  await host.handlers.session_compact?.({ type: "session_compact" } as never, ctx as ExtensionContext);
  const after = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.ok(after?.message, "re-injected after compaction");

  // Reload recovery: a reminder entry BEFORE a compaction entry is not live.
  const goalId = (after?.message?.details as { goalId?: string })?.goalId;
  entries.push({ type: "custom", customType: "goal-controller-state", data: { goal: latestGoal(host) } });
  entries.push({ type: "custom_message", customType: "goal-controller-reminder", details: { goalId } } as SessionEntryLike);
  entries.push({ type: "compaction" });
  await host.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx as ExtensionContext);
  const reloaded = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.ok(reloaded?.message, "pre-compaction reminder does not suppress re-injection after reload");
});

test("reload retracts a reminder whose goal was cleared or superseded offline", async () => {
  // Case 1: cleared goal — state entry persists { goal: null }, reminder still in branch.
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const entries: SessionEntryLike[] = [
    { type: "custom", customType: "goal-controller-state", data: { goal: null } },
    { type: "custom_message", customType: "goal-controller-reminder", details: { goalId: "gone-goal" } } as SessionEntryLike,
  ];
  const ctx = makeCtx(entries);
  await host.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx as ExtensionContext);
  assert.equal(host.customMessages.length, 1, "cleared goal's orphaned reminder retracted on reload");
  assert.equal(host.customMessages[0]?.customType, "goal-controller-reminder-retraction");
  assert.equal(host.customMessages[0]?.options?.deliverAs, "nextTurn");
  const after = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(after, undefined, "no goal, no reminder re-injection");

  // Case 2: superseded offline — branch carries goal B active but a reminder for goal A.
  const host2 = new FakeHost();
  activate(host2, new FakeChecker([]));
  const entries2: SessionEntryLike[] = [];
  const ctx2 = makeCtx(entries2);
  await host2.commandHandler?.("goal B", ctx2);
  entries2.push({ type: "custom", customType: "goal-controller-state", data: { goal: latestGoal(host2) } });
  entries2.push({ type: "custom_message", customType: "goal-controller-reminder", details: { goalId: "old-goal-a" } } as SessionEntryLike);
  host2.customMessages.length = 0;
  await host2.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx2 as ExtensionContext);
  assert.equal(host2.customMessages.length, 1, "stale reminder for a different goal retracted on reload");
  const next = await host2.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx2 as ExtensionContext);
  assert.ok(String(next?.message?.content).includes("goal B"), "current goal's reminder injected after the stale one is retracted");
});

test("a compaction whose kept window starts past the reminder evicts it and re-injects", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const entries: SessionEntryLike[] = [];
  const ctx = makeCtx(entries);
  await host.commandHandler?.("evicted-by-compaction goal", ctx);
  const injected = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  const goalId = (injected?.message?.details as { goalId?: string })?.goalId;

  // The realistic production shape: the reminder sits BEFORE the kept tail, so
  // compaction summarizes it away and it must be re-injected.
  entries.push({ type: "custom", customType: "goal-controller-state", data: { goal: latestGoal(host) } });
  entries.push({ type: "custom_message", id: "rem-1", customType: "goal-controller-reminder", details: { goalId } } as SessionEntryLike);
  entries.push({ type: "message", id: "later-1", message: { role: "user" } });
  entries.push({ type: "compaction", id: "comp-1", firstKeptEntryId: "later-1" } as SessionEntryLike);

  await host.handlers.session_compact?.({ type: "session_compact" } as never, ctx as ExtensionContext);
  const after = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.ok(after?.message, "reminder evicted by the kept window is re-injected");

  // An unknown firstKeptEntryId also counts as evicted (conservative direction).
  const host2 = new FakeHost();
  activate(host2, new FakeChecker([]));
  const entries2: SessionEntryLike[] = [];
  const ctx2 = makeCtx(entries2);
  await host2.commandHandler?.("unknown-kept-id goal", ctx2);
  const injected2 = await host2.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx2 as ExtensionContext);
  entries2.push({ type: "custom", customType: "goal-controller-state", data: { goal: latestGoal(host2) } });
  entries2.push({ type: "custom_message", id: "rem-2", customType: "goal-controller-reminder", details: { goalId: (injected2?.message?.details as { goalId?: string })?.goalId } } as SessionEntryLike);
  entries2.push({ type: "compaction", id: "comp-2", firstKeptEntryId: "no-such-entry" } as SessionEntryLike);
  await host2.handlers.session_compact?.({ type: "session_compact" } as never, ctx2 as ExtensionContext);
  const after2 = await host2.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx2 as ExtensionContext);
  assert.ok(after2?.message, "unresolvable kept-window id treats the reminder as evicted");
});

test("reload after a delivered retraction is idempotent — no duplicate retraction, no resurrection", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  // Branch already carries the full story: terminal goal, its reminder, AND
  // the delivered retraction. Reload must send nothing and inject nothing.
  const goal = { id: "done-goal", goal: "finished offline", status: "complete", startedAt: 1, updatedAt: 2, iteration: 1, checkerIteration: 1, tokensUsed: 0, turnsUsed: 1, timeUsedSeconds: 1, consecutiveNoToolContinuations: 0 };
  const entries: SessionEntryLike[] = [
    { type: "custom", customType: "goal-controller-state", data: { goal } },
    { type: "custom_message", customType: "goal-controller-reminder", details: { goalId: "done-goal" } } as SessionEntryLike,
    { type: "custom_message", customType: "goal-controller-reminder-retraction", details: { goalId: "done-goal" } } as SessionEntryLike,
  ];
  const ctx = makeCtx(entries);
  await host.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx as ExtensionContext);
  assert.equal(host.customMessages.length, 0, "already-retracted reminder must not be retracted again");
  const after = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(after, undefined, "terminal goal stays retracted — nothing re-injected");
});

test("a reminder inside the compaction's kept window survives and is not duplicated", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const entries: SessionEntryLike[] = [];
  const ctx = makeCtx(entries);
  await host.commandHandler?.("kept-window goal", ctx);
  const injected = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  const goalId = (injected?.message?.details as { goalId?: string })?.goalId;

  // Branch: goal state, the reminder entry, then a compaction whose kept
  // window starts AT the reminder — pi keeps such entries in context verbatim.
  entries.push({ type: "custom", customType: "goal-controller-state", data: { goal: latestGoal(host) } });
  entries.push({ type: "custom_message", id: "rem-1", customType: "goal-controller-reminder", details: { goalId } } as SessionEntryLike);
  entries.push({ type: "compaction", id: "comp-1", firstKeptEntryId: "rem-1" } as SessionEntryLike);

  // In-process compaction event: liveness recomputed from the branch.
  await host.handlers.session_compact?.({ type: "session_compact" } as never, ctx as ExtensionContext);
  const after = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(after?.message, undefined, "kept reminder is still live — no duplicate injection");

  // Reload agrees with the in-process view.
  await host.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx as ExtensionContext);
  const reloaded = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(reloaded?.message, undefined, "kept reminder survives reload without duplication");
});

test("terminal states retract the standing reminder (complete via checker, cleared via command)", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    { decision: "complete", complete: true, reason: "all proven", evidence: ["e"] },
  ]);
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("finish and retire", ctx);
  await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.equal(host.customMessages.length, 0, "no retraction while active");

  await host.handlers.agent_end?.(agentEnd("done", true), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "complete");
  assert.equal(host.customMessages.length, 1, "completion retracts the reminder");
  assert.equal(host.customMessages[0]?.customType, "goal-controller-reminder-retraction");
  assert.match(host.customMessages[0]?.content ?? "", /no longer applies/);
  assert.equal(
    host.customMessages[0]?.options?.deliverAs,
    "nextTurn",
    "retraction must ride the next user prompt — steer delivery inside agent_end (still streaming) would trigger an unprompted full-context continuation turn",
  );

  // Cleared goals retract too — but only when a reminder is actually live.
  const host2 = new FakeHost();
  activate(host2, new FakeChecker([]));
  const ctx2 = makeCtx();
  await host2.commandHandler?.("clear me", ctx2);
  await host2.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx2 as ExtensionContext);
  await host2.commandHandlers.get("goal_clear")?.("", ctx2);
  assert.equal(host2.customMessages.length, 1, "clear retracts the live reminder");

  const host3 = new FakeHost();
  activate(host3, new FakeChecker([]));
  const ctx3 = makeCtx();
  await host3.commandHandler?.("never injected", ctx3);
  await host3.commandHandlers.get("goal_clear")?.("", ctx3);
  assert.equal(host3.customMessages.length, 0, "no retraction when no reminder was injected");
});

test("superseding a paused goal retracts its reminder before the new goal's is injected", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const ctx = makeCtx();
  await host.commandHandler?.("first goal", ctx);
  await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  await host.commandHandlers.get("goal_pause")?.("", ctx);
  assert.equal(host.customMessages.length, 0, "pause alone keeps the reminder (resume expected)");

  await host.commandHandler?.("second goal", ctx);
  assert.equal(host.customMessages.length, 1, "superseding retracts the old goal's reminder");
  assert.match(host.customMessages[0]?.content ?? "", /no longer applies/);
  const next = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  assert.ok(String(next?.message?.content).includes("second goal"), "new goal's reminder injected");
});

test("reload retracts a reminder whose goal is terminal (lost-retraction safety net)", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const entries: SessionEntryLike[] = [];
  const ctx = makeCtx(entries);
  await host.commandHandler?.("went terminal offline", ctx);
  const injected = await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  const goalId = (injected?.message?.details as { goalId?: string })?.goalId;

  // Session persisted a completed goal + a live reminder (retraction was lost).
  const goal = { ...latestGoal(host)!, status: "complete" };
  entries.push({ type: "custom", customType: "goal-controller-state", data: { goal } });
  entries.push({ type: "custom_message", customType: "goal-controller-reminder", details: { goalId } } as SessionEntryLike);
  host.customMessages.length = 0;
  await host.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx as ExtensionContext);
  assert.equal(host.customMessages.length, 1, "reload retracts the stale reminder");
  assert.equal(host.customMessages[0]?.customType, "goal-controller-reminder-retraction");
});

test("blocked verdicts retract the standing reminder", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([
    { decision: "blocked", complete: false, blocked: true, reason: "cannot proceed" },
  ]);
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("block me", ctx);
  await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  await host.handlers.agent_end?.(agentEnd("stuck", true), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "blocked");
  assert.equal(host.customMessages.length, 1, "blocked transition retracts the reminder");
  assert.equal(host.customMessages[0]?.customType, "goal-controller-reminder-retraction");
});

test("budget-limited transitions retract the standing reminder", async () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  const entries: SessionEntryLike[] = [];
  const ctx = makeCtx(entries);

  // Load a turn-budgeted active goal from the session (config defaults carry no budgets).
  await host.commandHandler?.("budgeted goal", ctx);
  const budgeted = { ...latestGoal(host)!, turnBudget: 1, turnsUsed: 0 };
  entries.push({ type: "custom", customType: "goal-controller-state", data: { goal: budgeted } });
  await host.handlers.session_start?.({ type: "session_start", reason: "reload" } as SessionStartEvent, ctx as ExtensionContext);
  await host.handlers.before_agent_start?.({ type: "before_agent_start", prompt: "", images: [], systemPrompt: "base", systemPromptOptions: {} } as unknown as BeforeAgentStartEvent, ctx as ExtensionContext);
  host.customMessages.length = 0;

  await host.handlers.agent_end?.(agentEnd("one turn used", true), ctx as ExtensionContext);
  assert.equal(latestGoal(host)?.status, "budget_limited");
  assert.equal(host.customMessages.length, 1, "budget-limited transition retracts the reminder");
  assert.equal(host.customMessages[0]?.customType, "goal-controller-reminder-retraction");
});

test("configured settings do not load the old pi-goal package", () => {
  const settingsPath = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"), "settings.json");
  const settings = readFileSync(settingsPath, "utf8");
  assert.equal(settings.includes("npm:@narumitw/pi-goal"), false);
  assert.equal(settings.includes("goal_complete"), false);
});
