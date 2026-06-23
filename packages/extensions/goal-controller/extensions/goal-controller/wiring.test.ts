import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEndEvent, BeforeAgentStartEvent, ExtensionCommandContext, ExtensionContext, SessionStartEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { activate } from "./index.ts";
import type { CheckerRunner, CheckerRunInput } from "./checker.ts";
import type { GoalControllerHost, CapturedHandlers } from "./host.ts";
import type { CheckerVerdict, SessionEntryLike } from "./types.ts";

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
  private resolveVerdict: ((verdict: CheckerVerdict) => void) | undefined;

  public async run(input: CheckerRunInput): Promise<CheckerVerdict> {
    this.inputs.push(input);
    return new Promise<CheckerVerdict>((resolve) => {
      this.resolveVerdict = resolve;
    });
  }

  public resolve(verdict: CheckerVerdict): void {
    if (!this.resolveVerdict) throw new Error("checker was not running");
    this.resolveVerdict(verdict);
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
      },
      notify(message: string) {
        notifications.push(message);
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

test("extension registers one model-facing goal tool and user-only lifecycle commands", () => {
  const host = new FakeHost();
  activate(host, new FakeChecker([]));
  assert.deepEqual(host.tools.map((tool) => tool.name), ["goal"]);
  assert.deepEqual([...host.commandHandlers.keys()].sort(), ["goal", "goal_clear", "goal_edit", "goal_pause", "goal_resume"]);
  assert.equal(host.commandHandler !== undefined, true);
  assert.equal(host.tools[0]?.description.includes("never updates, replaces, edits, clears, pauses, resumes, or completes"), true);
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
