import { randomUUID } from "node:crypto";
import type {
  ActiveGoal,
  CheckerHistoryEntry,
  CheckerVerdict,
  GoalControllerConfig,
  GoalStateEntryData,
  GoalStatus,
  SessionEntryLike,
  StartGoalResult,
} from "./types.ts";

const NON_TERMINAL_STATUSES = new Set<GoalStatus>(["active", "checking", "waiting_for_user", "paused", "blocked", "budget_limited"]);

export function isNonTerminalGoal(goal: ActiveGoal | undefined): goal is ActiveGoal {
  return goal !== undefined && NON_TERMINAL_STATUSES.has(goal.status);
}

export function startGoal(
  currentGoal: ActiveGoal | undefined,
  goalText: string,
  config: GoalControllerConfig,
  baselineTokens: number,
  now = Date.now(),
): StartGoalResult {
  const trimmed = goalText.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "empty_goal",
      message: "Usage: /goal <goal text>. Goal text cannot be empty."
    };
  }

  if (isNonTerminalGoal(currentGoal)) {
    return {
      ok: false,
      error: "active_goal_exists",
      message: "A non-terminal goal is already active. Continue it, edit it with /goal_edit, clear it with /goal_clear, or wait for checker completion before starting another.",
      activeGoal: currentGoal,
    };
  }

  return {
    ok: true,
    goal: createGoal(trimmed, config, baselineTokens, now),
  };
}

export function createGoal(goal: string, config: GoalControllerConfig, baselineTokens: number, now = Date.now()): ActiveGoal {
  return {
    id: randomUUID(),
    goal,
    status: "active",
    startedAt: now,
    updatedAt: now,
    iteration: 0,
    checkerIteration: 0,
    baselineTokens,
    tokensUsed: 0,
    turnsUsed: 0,
    timeUsedSeconds: 0,
    tokenBudget: config.defaultTokenBudget,
    turnBudget: config.defaultTurnBudget,
    timeBudgetSeconds: config.defaultTimeBudgetSeconds,
    checkerHistory: [],
    awaitingContinuationTurn: false,
    consecutiveNoToolContinuations: 0,
  };
}

export function updateUsage(goal: ActiveGoal, tokenTotal: number, now = Date.now(), incrementTurns = false): ActiveGoal {
  return {
    ...goal,
    tokensUsed: Math.max(0, tokenTotal - goal.baselineTokens),
    turnsUsed: incrementTurns ? goal.turnsUsed + 1 : goal.turnsUsed,
    timeUsedSeconds: Math.max(0, Math.floor((now - goal.startedAt) / 1000)),
    updatedAt: now,
  };
}

export function transitionGoal(goal: ActiveGoal, status: GoalStatus, reason: string | undefined, now = Date.now()): ActiveGoal {
  return {
    ...goal,
    status,
    updatedAt: now,
    lastTransitionReason: reason,
    awaitingContinuationTurn: status === "active" || status === "checking" ? goal.awaitingContinuationTurn : false,
    consecutiveNoToolContinuations: status === "active" || status === "checking" ? nonNegativeIntegerOrZero(goal.consecutiveNoToolContinuations) : 0,
  };
}

export function markChecking(goal: ActiveGoal, now = Date.now()): ActiveGoal {
  return transitionGoal(goal, "checking", "checker running", now);
}

export function applyCheckerVerdict(
  goal: ActiveGoal,
  verdict: CheckerVerdict,
  config: GoalControllerConfig,
  turnHadToolUse: boolean,
  now = Date.now(),
): ActiveGoal {
  const historyEntry: CheckerHistoryEntry = {
    ...verdict,
    checkedAt: now,
    iteration: goal.checkerIteration + 1,
  };
  const checkerHistory = [...goal.checkerHistory, historyEntry];
  const base: ActiveGoal = {
    ...goal,
    checkerIteration: goal.checkerIteration + 1,
    checkerHistory,
    lastCheckerVerdict: historyEntry,
    updatedAt: now,
  };

  if (verdict.decision === "complete") {
    return {
      ...base,
      status: "complete",
      awaitingContinuationTurn: false,
      consecutiveNoToolContinuations: 0,
      lastTransitionReason: verdict.reason,
    };
  }

  if (verdict.decision === "waiting_for_user") {
    return {
      ...base,
      status: "waiting_for_user",
      awaitingContinuationTurn: false,
      consecutiveNoToolContinuations: 0,
      lastTransitionReason: verdict.reason,
    };
  }

  if (verdict.decision === "blocked") {
    return {
      ...base,
      status: "blocked",
      awaitingContinuationTurn: false,
      consecutiveNoToolContinuations: 0,
      lastTransitionReason: verdict.reason,
    };
  }

  const nextNoToolContinuations = base.awaitingContinuationTurn && !turnHadToolUse ? base.consecutiveNoToolContinuations + 1 : 0;
  if (nextNoToolContinuations >= config.continuation.noToolContinuationLimit) {
    return {
      ...base,
      status: "blocked",
      awaitingContinuationTurn: false,
      consecutiveNoToolContinuations: 0,
      lastTransitionReason: `Checker still found the goal incomplete after ${nextNoToolContinuations} consecutive automatic continuation turn(s) made no tool progress.`,
    };
  }

  return {
    ...base,
    status: "active",
    awaitingContinuationTurn: true,
    consecutiveNoToolContinuations: nextNoToolContinuations,
    iteration: base.iteration + 1,
    lastTransitionReason: verdict.reason,
  };
}

export function maybeApplyBudgetLimit(goal: ActiveGoal, now = Date.now()): ActiveGoal {
  const reason = budgetLimitReason(goal);
  if (!reason) return goal;
  return transitionGoal(goal, "budget_limited", reason, now);
}

export function budgetLimitReason(goal: ActiveGoal): string | undefined {
  if (goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget) {
    return `Goal token budget reached (${goal.tokensUsed}/${goal.tokenBudget}).`;
  }
  if (goal.turnBudget !== undefined && goal.turnsUsed >= goal.turnBudget) {
    return `Goal turn budget reached (${goal.turnsUsed}/${goal.turnBudget}).`;
  }
  if (goal.timeBudgetSeconds !== undefined && goal.timeUsedSeconds >= goal.timeBudgetSeconds) {
    return `Goal time budget reached (${goal.timeUsedSeconds}/${goal.timeBudgetSeconds}s).`;
  }
  return undefined;
}

export function clearGoal(goal: ActiveGoal | undefined, now = Date.now()): ActiveGoal | undefined {
  if (!goal) return undefined;
  return transitionGoal(goal, "cleared", "cleared by user", now);
}

export function resumeGoal(goal: ActiveGoal, now = Date.now()): ActiveGoal {
  return {
    ...transitionGoal(goal, "active", "resumed by user", now),
    awaitingContinuationTurn: false,
    consecutiveNoToolContinuations: 0,
  };
}

export function editGoalText(goal: ActiveGoal, goalText: string, now = Date.now()): ActiveGoal {
  return {
    ...transitionGoal(goal, "active", "edited by user", now),
    goal: goalText.trim(),
    iteration: 0,
    checkerIteration: 0,
    checkerHistory: [],
    lastCheckerVerdict: undefined,
    awaitingContinuationTurn: false,
    consecutiveNoToolContinuations: 0,
  };
}

export function pauseGoal(goal: ActiveGoal, reason: string, now = Date.now()): ActiveGoal {
  return transitionGoal(goal, "paused", reason, now);
}

export function goalSummary(goal: ActiveGoal | undefined): string {
  if (!goal) return "No goal is set.";
  const budgetParts = [
    goal.tokenBudget === undefined ? undefined : `tokens ${goal.tokensUsed}/${goal.tokenBudget}`,
    goal.turnBudget === undefined ? undefined : `turns ${goal.turnsUsed}/${goal.turnBudget}`,
    goal.timeBudgetSeconds === undefined ? undefined : `time ${goal.timeUsedSeconds}s/${goal.timeBudgetSeconds}s`,
  ].filter((part): part is string => part !== undefined);
  const checker = goal.lastCheckerVerdict ? `\nLast checker: ${goal.lastCheckerVerdict.decision ?? (goal.lastCheckerVerdict.complete ? "complete" : "not complete")} — ${goal.lastCheckerVerdict.reason}` : "";
  const reason = goal.lastTransitionReason ? `\nReason: ${goal.lastTransitionReason}` : "";
  return [`Goal: ${goal.goal}`, `Status: ${goal.status}`, `Iteration: ${goal.iteration}`, budgetParts.length > 0 ? `Budget: ${budgetParts.join(", ")}` : "Budget: none", checker, reason]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function loadGoalFromSession(entries: SessionEntryLike[]): ActiveGoal | undefined {
  const entry = entries
    .filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-controller-state")
    .pop();
  const data = entry?.data as GoalStateEntryData | undefined;
  if (!isGoal(data?.goal)) return undefined;
  const goal = hydrateGoal(data.goal);
  return goal.status === "cleared" ? undefined : goal;
}

function hydrateGoal(goal: ActiveGoal): ActiveGoal {
  return {
    ...goal,
    consecutiveNoToolContinuations: nonNegativeIntegerOrZero(goal.consecutiveNoToolContinuations),
  };
}

export function isGoal(value: unknown): value is ActiveGoal {
  if (!value || typeof value !== "object") return false;
  const goal = value as Partial<ActiveGoal>;
  return (
    typeof goal.id === "string" &&
    typeof goal.goal === "string" &&
    isGoalStatus(goal.status) &&
    typeof goal.startedAt === "number" &&
    typeof goal.updatedAt === "number" &&
    typeof goal.iteration === "number" &&
    typeof goal.checkerIteration === "number" &&
    typeof goal.baselineTokens === "number" &&
    typeof goal.tokensUsed === "number" &&
    typeof goal.turnsUsed === "number" &&
    typeof goal.timeUsedSeconds === "number" &&
    Array.isArray(goal.checkerHistory) &&
    typeof goal.awaitingContinuationTurn === "boolean" &&
    (goal.consecutiveNoToolContinuations === undefined || typeof goal.consecutiveNoToolContinuations === "number")
  );
}

function nonNegativeIntegerOrZero(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "active" || value === "checking" || value === "waiting_for_user" || value === "paused" || value === "blocked" || value === "budget_limited" || value === "complete" || value === "cleared";
}
