export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type GoalStatus = "active" | "checking" | "waiting_for_user" | "paused" | "blocked" | "budget_limited" | "complete" | "cleared";
export type CheckerMode = "llm";
export type CheckerToolMode = "transcript" | "inspect" | "full";
export type CheckerModelSetting = "inherit" | string;
export type CheckerThinkingSetting = "inherit" | ThinkingLevel;

export interface GoalControllerConfig {
  defaultTokenBudget?: number;
  defaultTurnBudget?: number;
  defaultTimeBudgetSeconds?: number;
  checker: {
    mode: CheckerMode;
    toolMode: CheckerToolMode;
    model: CheckerModelSetting;
    thinking: CheckerThinkingSetting;
    timeoutMs: number;
  };
  continuation: {
    suppressAfterNoToolContinuation: boolean;
    transcriptMaxChars: number;
    checkerHistoryLimit: number;
  };
}

export interface CheckerRequirementVerdict {
  requirement: string;
  status: "satisfied" | "unsatisfied" | "unclear" | "not_applicable";
  evidence?: string;
}

export type CheckerDecision = "complete" | "continue" | "waiting_for_user" | "blocked";

export interface CheckerVerdict {
  decision: CheckerDecision;
  complete: boolean;
  blocked?: boolean;
  reason: string;
  nextTurnGuidance?: string;
  evidence?: string[];
  unmetRequirements?: string[];
  requirements?: CheckerRequirementVerdict[];
}

export interface CheckerHistoryEntry extends CheckerVerdict {
  checkedAt: number;
  iteration: number;
}

export interface ActiveGoal {
  id: string;
  goal: string;
  status: GoalStatus;
  startedAt: number;
  updatedAt: number;
  iteration: number;
  checkerIteration: number;
  baselineTokens: number;
  tokensUsed: number;
  turnsUsed: number;
  timeUsedSeconds: number;
  tokenBudget?: number;
  turnBudget?: number;
  timeBudgetSeconds?: number;
  lastCheckerVerdict?: CheckerHistoryEntry;
  checkerHistory: CheckerHistoryEntry[];
  awaitingContinuationTurn: boolean;
  lastTransitionReason?: string;
}

export interface GoalStateEntryData {
  goal?: ActiveGoal | null;
}

export interface StartGoalAccepted {
  ok: true;
  goal: ActiveGoal;
}

export interface StartGoalRejected {
  ok: false;
  error: "empty_goal" | "active_goal_exists";
  message: string;
  activeGoal?: ActiveGoal;
}

export type StartGoalResult = StartGoalAccepted | StartGoalRejected;

export interface TextBlockLike {
  type: "text";
  text: string;
}

export interface ToolCallBlockLike {
  type: "toolCall";
  name: string;
  id?: string;
  arguments?: unknown;
}

export interface MessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
  model?: string;
}

export interface SessionEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: MessageLike;
}
