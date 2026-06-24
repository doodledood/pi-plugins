import { randomUUID } from "node:crypto";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadConfig, type LoadedConfig } from "./config.ts";
import {
  applyCheckerVerdict,
  canEditGoal,
  canPauseGoal,
  canResumeGoal,
  clearGoal,
  editGoalText,
  goalStatusLabel,
  goalSummary,
  loadGoalFromSession,
  markChecking,
  maybeApplyBudgetLimit,
  pauseGoal,
  resumeGoal,
  startGoal,
  updateUsage,
} from "./controller.ts";
import { PiSubprocessCheckerRunner, type CheckerRunner } from "./checker.ts";
import { buildActiveGoalSystemPrompt, buildCheckerSessionContext, buildContinuationPrompt, GOAL_DESCRIPTION, GOAL_GUIDELINES } from "./prompts.ts";
import type { GoalControllerHost } from "./host.ts";
import type { ActiveGoal, CheckerVerdict, GoalStateEntryData, MessageLike } from "./types.ts";

const STATUS_KEY = "goal-controller";
const STATE_ENTRY_TYPE = "goal-controller-state";
const CHECKER_STATUS_INTERVAL_MS = 1_000;
const CHECKER_STATUS_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface CheckerStatusRuntime {
  startedAt: number;
  timeoutMs: number;
  frame: string;
}

interface LiveCheckerRun extends CheckerStatusRuntime {
  runId: string;
  goalId: string;
  controller: AbortController;
  timer?: ReturnType<typeof setInterval>;
  frameIndex: number;
}

const goalSchema = Type.Object({
  goal: Type.String({
    description:
      "Standalone goal text. Include objective, done criteria, verification signal, constraints, stop/block condition, and compact progress expectations when useful.",
  }),
});
type GoalParams = Static<typeof goalSchema>;

export default function goalController(pi: ExtensionAPI): void {
  activate(pi, new PiSubprocessCheckerRunner(pi));
}

export function activate(pi: GoalControllerHost, checkerRunner: CheckerRunner): void {
  let loadedConfig: LoadedConfig = loadConfig();
  let activeGoal: ActiveGoal | undefined;
  let checkerRun: LiveCheckerRun | undefined;
  let pendingContinuationGoalId: string | undefined;
  let pendingContinuationPrompt: string | undefined;

  const persistGoal = (goal: ActiveGoal | undefined): void => {
    pi.appendEntry<GoalStateEntryData>(STATE_ENTRY_TYPE, { goal: goal ?? null });
  };

  const setStatus = (ctx: ExtensionContext): void => {
    if (!activeGoal) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, formatStatus(activeGoal, checkerRuntimeFor(activeGoal)));
  };

  const checkerRuntimeFor = (goal: ActiveGoal): CheckerStatusRuntime | undefined => {
    if (goal.status !== "checking" || !checkerRun || checkerRun.goalId !== goal.id) return undefined;
    return {
      startedAt: checkerRun.startedAt,
      timeoutMs: checkerRun.timeoutMs,
      frame: checkerRun.frame,
    };
  };

  const stopCheckerStatusTimer = (run: LiveCheckerRun | undefined): void => {
    if (run?.timer !== undefined) {
      clearInterval(run.timer);
      run.timer = undefined;
    }
  };

  const resetCheckerRuntime = (run = checkerRun, abort = false): void => {
    if (!run) return;
    if (abort) run.controller.abort();
    stopCheckerStatusTimer(run);
    if (checkerRun === run) checkerRun = undefined;
  };

  const startCheckerRun = (ctx: ExtensionContext, goalId: string): LiveCheckerRun => {
    const run: LiveCheckerRun = {
      runId: randomUUID(),
      goalId,
      controller: new AbortController(),
      startedAt: Date.now(),
      timeoutMs: loadedConfig.config.checker.timeoutMs,
      frame: CHECKER_STATUS_FRAMES[0],
      frameIndex: 0,
    };
    checkerRun = run;
    setStatus(ctx);
    run.timer = setInterval(() => {
      if (!activeGoal || activeGoal.id !== run.goalId || activeGoal.status !== "checking" || checkerRun !== run) {
        stopCheckerStatusTimer(run);
        return;
      }
      run.frameIndex = (run.frameIndex + 1) % CHECKER_STATUS_FRAMES.length;
      run.frame = CHECKER_STATUS_FRAMES[run.frameIndex] ?? CHECKER_STATUS_FRAMES[0];
      setStatus(ctx);
    }, CHECKER_STATUS_INTERVAL_MS);
    run.timer.unref?.();
    return run;
  };

  const reloadConfig = (ctx?: ExtensionContext): void => {
    loadedConfig = loadConfig();
    if (loadedConfig.warning && ctx) ctx.ui.notify(loadedConfig.warning, "warning");
  };

  const clearPendingContinuation = (): void => {
    pendingContinuationGoalId = undefined;
    pendingContinuationPrompt = undefined;
  };

  pi.registerTool({
    name: "goal",
    label: "Goal",
    description: GOAL_DESCRIPTION,
    promptSnippet: "Start a long-running goal with checker-only completion",
    promptGuidelines: [...GOAL_GUIDELINES],
    parameters: goalSchema,
    async execute(_toolCallId: string, params: GoalParams, _signal, _onUpdate, ctx) {
      reloadConfig(ctx);
      const result = startGoal(activeGoal, params.goal, loadedConfig.config, currentTokenTotal(ctx));
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.message }],
          details: { ok: false, error: result.error, activeGoal: result.activeGoal },
        };
      }

      activeGoal = result.goal;
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      ctx.ui.notify(`Goal started: ${activeGoal.goal}`, "info");
      return {
        content: [{ type: "text" as const, text: `Goal started. Checker-only completion is active. Goal: ${activeGoal.goal}` }],
        details: { ok: true, goal: activeGoal },
      };
    },
  });

  pi.registerCommand("goal", {
    description: "Start or show checker-controlled goal mode: /goal <goal> or /goal",
    handler: async (args, ctx) => {
      reloadConfig(ctx);
      const trimmed = args.trim();
      if (!trimmed || trimmed === "status") {
        ctx.ui.notify(goalSummary(activeGoal), "info");
        setStatus(ctx);
        return;
      }

      const result = startGoal(activeGoal, trimmed, loadedConfig.config, currentTokenTotal(ctx));
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        setStatus(ctx);
        return;
      }

      activeGoal = result.goal;
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      ctx.ui.notify(`Goal started: ${activeGoal.goal}`, "info");
      await sendGoalKickoff(pi, ctx, activeGoal);
    },
  });

  pi.registerCommand("goal_pause", {
    description: "Pause the active goal. User-only command; not model-callable.",
    handler: (args, ctx) => {
      reloadConfig(ctx);
      if (args.trim()) {
        ctx.ui.notify("Usage: /goal_pause", "warning");
        return;
      }
      if (!canPauseGoal(activeGoal)) {
        ctx.ui.notify("No active, waiting, or checking goal can be paused.", "warning");
        return;
      }
      const wasChecking = activeGoal.status === "checking";
      if (wasChecking) resetCheckerRuntime(checkerRun, true);
      activeGoal = pauseGoal(activeGoal, wasChecking ? "checker cancelled and goal paused by user" : "paused by user");
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      ctx.ui.notify("Goal paused.", "info");
    },
  });

  pi.registerCommand("goal_resume", {
    description: "Resume a paused, waiting, blocked, or budget-limited goal. User-only command; not model-callable.",
    handler: async (args, ctx) => {
      reloadConfig(ctx);
      if (args.trim()) {
        ctx.ui.notify("Usage: /goal_resume", "warning");
        return;
      }
      if (!canResumeGoal(activeGoal)) {
        ctx.ui.notify("No paused, waiting, blocked, or budget-limited goal can be resumed.", "warning");
        return;
      }
      activeGoal = resumeGoal(activeGoal);
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      ctx.ui.notify("Goal resumed.", "info");
      await sendGoalKickoff(pi, ctx, activeGoal);
    },
  });

  pi.registerCommand("goal_edit", {
    description: "Edit the current editable goal text and resume it. With no args, opens an editor prefilled with the current goal. User-only command; not model-callable.",
    handler: async (args, ctx) => {
      reloadConfig(ctx);
      if (activeGoal?.status === "checking") {
        ctx.ui.notify("Goal is being checked right now; use /goal_pause to cancel and pause it, or /goal_clear to cancel and clear it before editing.", "warning");
        return;
      }
      if (!canEditGoal(activeGoal)) {
        ctx.ui.notify("No editable goal can be edited.", "warning");
        return;
      }

      const trimmedArg = args.trim();
      const editedText = trimmedArg || (await ctx.ui.editor("Edit goal", activeGoal.goal));
      if (editedText === undefined) {
        ctx.ui.notify("Goal edit cancelled.", "info");
        return;
      }

      const nextGoalText = editedText.trim();
      if (!nextGoalText) {
        ctx.ui.notify("Goal text cannot be empty.", "warning");
        return;
      }
      if (nextGoalText === activeGoal.goal) {
        ctx.ui.notify("Goal unchanged.", "info");
        return;
      }

      activeGoal = editGoalText(activeGoal, nextGoalText);
      resetCheckerRuntime(checkerRun, true);
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      ctx.ui.notify(`Goal edited and resumed: ${activeGoal.goal}`, "info");
      await sendGoalKickoff(pi, ctx, activeGoal);
    },
  });

  pi.registerCommand("goal_clear", {
    description: "Clear the current goal. User-only command; not model-callable.",
    handler: (args, ctx) => {
      reloadConfig(ctx);
      if (args.trim()) {
        ctx.ui.notify("Usage: /goal_clear", "warning");
        return;
      }
      if (activeGoal?.status === "checking") resetCheckerRuntime(checkerRun, true);
      const cleared = clearGoal(activeGoal);
      persistGoal(cleared);
      activeGoal = undefined;
      clearPendingContinuation();
      setStatus(ctx);
      ctx.ui.notify("Goal cleared.", "warning");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    reloadConfig(ctx);
    resetCheckerRuntime(checkerRun, true);
    activeGoal = loadGoalFromSession(ctx.sessionManager.getBranch(), "checker interrupted by session reload; run /goal_resume to continue");
    if (activeGoal?.lastTransitionReason?.includes("session reload")) persistGoal(activeGoal);
    clearPendingContinuation();
    setStatus(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    reloadConfig(ctx);
    resetCheckerRuntime(checkerRun, true);
    activeGoal = loadGoalFromSession(ctx.sessionManager.getBranch(), "checker interrupted by session navigation; run /goal_resume to continue");
    if (activeGoal?.lastTransitionReason?.includes("session navigation")) persistGoal(activeGoal);
    clearPendingContinuation();
    setStatus(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    resetCheckerRuntime(checkerRun, true);
    if (activeGoal) persistGoal(activeGoal.status === "checking" ? pauseGoal(activeGoal, "checker interrupted by session shutdown; run /goal_resume to continue") : activeGoal);
    ctx.ui.setStatus(STATUS_KEY, undefined);
    clearPendingContinuation();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!activeGoal) return;
    if (activeGoal.status === "waiting_for_user") {
      activeGoal = resumeGoal(activeGoal);
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
    }
    if (activeGoal.status !== "active") return;

    const isPendingAutomaticContinuation =
      activeGoal.awaitingContinuationTurn &&
      pendingContinuationGoalId === activeGoal.id &&
      pendingContinuationPrompt === event.prompt;
    if (activeGoal.awaitingContinuationTurn && !isPendingAutomaticContinuation) {
      activeGoal = resumeGoal(activeGoal);
      persistGoal(activeGoal);
      setStatus(ctx);
    }
    clearPendingContinuation();

    return { systemPrompt: `${event.systemPrompt}\n\n${buildActiveGoalSystemPrompt(activeGoal)}` };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!activeGoal || activeGoal.status !== "active") return;
    if (checkerRun?.goalId === activeGoal.id) return;

    const goalId = activeGoal.id;
    activeGoal = updateUsage(activeGoal, currentTokenTotal(ctx), Date.now(), true);
    const finalAssistant = findFinalAssistantMessage(event.messages);
    if (finalAssistant?.stopReason === "aborted" || finalAssistant?.stopReason === "error") {
      activeGoal = pauseGoal(activeGoal, finalAssistant.stopReason === "aborted" ? "paused after interruption" : `paused after agent error${finalAssistant.errorMessage ? `: ${finalAssistant.errorMessage}` : ""}`);
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      ctx.ui.notify(activeGoal.lastTransitionReason ?? "Goal paused.", "warning");
      return;
    }

    activeGoal = maybeApplyBudgetLimit(activeGoal);
    if (activeGoal.status === "budget_limited") {
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      ctx.ui.notify(activeGoal.lastTransitionReason ?? "Goal budget reached.", "warning");
      return;
    }

    if (ctx.hasPendingMessages()) {
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      return;
    }

    const turnHadToolUse = eventTurnHadToolUse(event);
    activeGoal = markChecking(activeGoal);
    persistGoal(activeGoal);
    const run = startCheckerRun(ctx, goalId);
    const forwardAbort = (): void => run.controller.abort();
    if (ctx.signal?.aborted) forwardAbort();
    else ctx.signal?.addEventListener("abort", forwardAbort, { once: true });

    try {
      const context = buildCheckerSessionContext(
        ctx.sessionManager.getBranch(),
        ctx.sessionManager.getSessionFile(),
        ctx.sessionManager.getLeafId(),
        event.messages as MessageLike[],
        turnHadToolUse,
      );
      const verdict = await checkerRunner.run({
        goal: activeGoal,
        context,
        config: loadedConfig.config,
        cwd: ctx.cwd,
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
        signal: run.controller.signal,
      });

      if (!activeGoal || activeGoal.id !== run.goalId || activeGoal.status !== "checking" || checkerRun !== run) return;
      activeGoal = applyCheckerVerdict(activeGoal, verdict, loadedConfig.config, turnHadToolUse);
      persistGoal(activeGoal);
      setStatus(ctx);

      if (activeGoal.status === "complete") {
        clearPendingContinuation();
        ctx.ui.notify(`Goal complete: ${verdict.reason}`, "info");
        return;
      }
      if (activeGoal.status === "waiting_for_user") {
        clearPendingContinuation();
        ctx.ui.notify(`Goal waiting for user input: ${activeGoal.lastTransitionReason ?? verdict.reason}`, "info");
        return;
      }
      if (activeGoal.status === "blocked") {
        clearPendingContinuation();
        ctx.ui.notify(`Goal blocked: ${activeGoal.lastTransitionReason ?? verdict.reason}`, "warning");
        return;
      }
      if (activeGoal.status === "active") {
        if (ctx.hasPendingMessages()) {
          clearPendingContinuation();
          persistGoal(activeGoal);
          setStatus(ctx);
          return;
        }
        pendingContinuationPrompt = await sendContinuation(pi, ctx, activeGoal, verdict);
        pendingContinuationGoalId = activeGoal.id;
      }
    } catch (error) {
      if (!activeGoal || activeGoal.id !== run.goalId || activeGoal.status !== "checking" || checkerRun !== run) return;
      const message = error instanceof Error ? error.message : String(error);
      activeGoal = pauseGoal(activeGoal, `checker failed: ${message}`);
      clearPendingContinuation();
      persistGoal(activeGoal);
      setStatus(ctx);
      ctx.ui.notify(`Goal checker failed and paused the goal: ${message}`, "error");
    } finally {
      ctx.signal?.removeEventListener("abort", forwardAbort);
      if (checkerRun === run) resetCheckerRuntime(run, false);
    }
  });
}

async function sendGoalKickoff(pi: GoalControllerHost, ctx: ExtensionContext, goal: ActiveGoal): Promise<void> {
  await sendUserMessage(pi, ctx, `Goal mode is active. Work toward this goal until the independent checker marks it complete:\n\n<goal_objective>\n${goal.goal}\n</goal_objective>\n\nSurface concrete verification evidence as you work. Do not claim completion authority; the checker owns completion.`);
}

async function sendContinuation(pi: GoalControllerHost, ctx: ExtensionContext, goal: ActiveGoal, verdict: CheckerVerdict): Promise<string> {
  const prompt = buildContinuationPrompt(goal, verdict);
  await sendUserMessage(pi, ctx, prompt);
  return prompt;
}

async function sendUserMessage(pi: GoalControllerHost, ctx: ExtensionContext, prompt: string): Promise<void> {
  if (ctx.isIdle()) pi.sendUserMessage(prompt);
  else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function currentTokenTotal(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as MessageLike | undefined;
    if (message?.role !== "assistant") continue;
    const usage = usageRecord(message.usage);
    total += usage?.input ?? 0;
    total += usage?.output ?? 0;
  }
  return total;
}

function usageRecord(value: unknown): { input?: number; output?: number } | undefined {
  if (!isRecord(value)) return undefined;
  return {
    input: typeof value.input === "number" ? value.input : undefined,
    output: typeof value.output === "number" ? value.output : undefined,
  };
}

function eventTurnHadToolUse(event: AgentEndEvent): boolean {
  for (const message of event.messages) {
    if (!isRecord(message)) continue;
    if (message.role === "toolResult") return true;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    if (content.some((block) => isRecord(block) && block.type === "toolCall")) return true;
  }
  return false;
}

function findFinalAssistantMessage(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "assistant") continue;
    return {
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
    };
  }
  return undefined;
}

export function formatStatus(goal: ActiveGoal, checkerRuntime?: CheckerStatusRuntime, now = Date.now()): string {
  if (goal.status === "active") return `goal active ${formatBudget(goal)}`;
  if (goal.status === "checking") {
    if (!checkerRuntime) return "goal checking";
    return `goal checking ${checkerRuntime.frame} ${formatDuration(Math.max(0, now - checkerRuntime.startedAt))}/${formatDuration(checkerRuntime.timeoutMs)}`;
  }
  if (goal.status === "budget_limited") return `goal ${goalStatusLabel(goal.status)} ${formatBudget(goal)}`;
  return `goal ${goalStatusLabel(goal.status)}`;
}

function formatBudget(goal: ActiveGoal): string {
  const token = goal.tokenBudget === undefined ? undefined : `${formatCount(goal.tokensUsed)}/${formatCount(goal.tokenBudget)}`;
  const turn = goal.turnBudget === undefined ? undefined : `${goal.turnsUsed}/${goal.turnBudget} turns`;
  return [token, turn].filter((part): part is string => part !== undefined).join(" ") || `${goal.turnsUsed} turns`;
}

function formatCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
  return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `0:${seconds.toString().padStart(2, "0")}`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
