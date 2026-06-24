import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEndEvent, BeforeAgentStartEvent, ExtensionCommandContext, ExtensionContext, SessionStartEvent, SessionTreeEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { activate, formatStatus } from "./index.ts";
import type { CheckerRunner, CheckerRunInput } from "./checker.ts";
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

test("extension registers one model-facing goal tool and user-only lifecycle commands", () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  assert.deepEqual(host.tools.map((tool) => tool.name), ["goal"]);
  assert.deepEqual([...host.commandHandlers.keys()].sort(), ["goal", "goal_clear", "goal_edit", "goal_pause", "goal_resume"]);
  assert.equal(host.commandHandler !== undefined, true);
  assert.equal(host.tools[0]?.description.includes("may supersede a stopped goal"), true);
  assert.equal(host.tools[0]?.description.includes("never updates, edits, clears, pauses, resumes, or completes a live goal"), true);
});

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
  assert.equal(before?.systemPrompt?.includes("finish the smoke goal"), true);
  assert.equal(before?.systemPrompt?.includes("cannot complete"), true);

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
  assert.equal(before?.systemPrompt?.includes("make me laugh"), true);
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

test("abort and error turns pause without running checker", async () => {
  const host = new FakeHost();
  const checker = new FakeChecker([]);
  activate(host, checker);
  const ctx = makeCtx();
  await host.commandHandler?.("goal that gets interrupted", ctx);
  await host.handlers.agent_end?.(agentEnd("", false, "aborted"), ctx as ExtensionContext);
  assert.equal(checker.inputs.length, 0);
  assert.equal(latestGoal(host)?.status, "paused");
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /interruption/iu);

  await host.commandHandlers.get("goal_resume")?.("", ctx);
  await host.handlers.agent_end?.(agentEnd("", false, "error", "boom"), ctx as ExtensionContext);
  assert.equal(checker.inputs.length, 0);
  assert.equal(latestGoal(host)?.status, "paused");
  assert.match(latestGoal(host)?.lastTransitionReason ?? "", /boom/iu);
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

test("configured settings do not load the old pi-goal package", () => {
  const settingsPath = join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"), "settings.json");
  const settings = readFileSync(settingsPath, "utf8");
  assert.equal(settings.includes("npm:@narumitw/pi-goal"), false);
  assert.equal(settings.includes("goal_complete"), false);
});
