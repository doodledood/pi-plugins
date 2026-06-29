import type { ActiveGoal, CheckerSessionContext, CheckerVerdict, MessageLike, SessionEntryLike, ToolCallBlockLike } from "./types.ts";
import { checkerAuditProfilePromptText } from "./checker-profile.ts";

export const GOAL_DESCRIPTION =
  "Start a long-running goal when no live goal is active. Input is one goal string. " +
  "Use goal for work that may take multiple turns and has a meaningful completion condition. " +
  "Write the goal as a compact completion contract: state the durable objective, desired end state, verification signal, important constraints, and any stop/block condition. " +
  "The goal may reference files, docs, issues, or plans for context. Prefer text standalone enough for an independent checker to understand what done means. " +
  "For longer goals, include how compact progress should be recorded, such as checkpoint notes covering what changed, what was verified, what remains, and blockers. " +
  "goal creates a fresh goal; it may supersede stopped paused/blocked/budget-limited goals or completed goals, but never updates, edits, clears, pauses, resumes, or completes a live goal.";

export const GOAL_GUIDELINES = [
  "Use goal only when no live goal is active and the work may require multiple turns toward a verifiable end state; completed goals are not live, so a fresh goal may be started after status complete.",
  "When calling goal, put the objective, done criteria, verification signal, constraints, and stop/block condition into the single goal string; include compact checkpoint-progress expectations when useful.",
  "Do not call goal to replace or narrow a live goal. If another goal is active, checking, or waiting for user input, continue it or ask the user to pause or clear it; edit only when the goal is not checking.",
] as const;

export function buildActiveGoalSystemPrompt(goal: ActiveGoal): string {
  return `Active goal-controller goal:\n${goalBlock(goal)}\n\nGoal-controller rules:\n- Work toward the exact active goal.\n- The worker model cannot complete, update, replace, clear, pause, resume, or override this goal. Only the goal-controller checker can complete it.\n- Surface evidence in normal responses and tool output: commands run, results observed, files or artifacts changed, remaining gaps, and blockers.\n- If the missing evidence is the user's reaction, preference, or confirmation, ask the user directly; use an available focused user-question tool when appropriate.\n- If the goal text asks for compact checkpoint progress, honor that in normal responses.\n- If you believe the goal is complete, state the evidence; do not call or invent a completion tool.\n- If blocked, state the blocker and the exact external input or state needed.`;
}

export function buildContinuationPrompt(goal: ActiveGoal, verdict: CheckerVerdict): string {
  const guidance = verdict.nextTurnGuidance?.trim() || verdict.reason;
  return `The goal-controller checker says the active goal is not complete. Continue working toward this goal.\n\n${goalBlock(goal)}\n\nChecker reason:\n${verdict.reason}\n\nNext guidance:\n${guidance}\n\nRemember: only the checker can complete the goal. Surface concrete verification evidence as you proceed.`;
}

export function buildCheckerPrompt(goal: ActiveGoal, context: CheckerSessionContext): string {
  const state = JSON.stringify(goalForChecker(goal), null, 2);
  const sessionContext = JSON.stringify(context, null, 2);
  return `You are the independent goal-controller checker. Your only job is to decide whether the active goal is truly complete. You are not the worker that did the task. Be skeptical and evidence-driven.

Rules:
- Treat completion as unproven.
- Audit the exact goal text requirement by requirement.
- Worker claims are claims, not proof. Prefer concrete evidence surfaced in the session artifact: command outputs, test/build/lint results, file/artifact descriptions, diffs summarized by the worker, or other surfaced evidence.
- You receive compact session navigation context, not an inline transcript. Use it to decide whether deeper session inspection is needed.
- Pi session files are JSONL trees. The first line is a session header; later entries use id and parentId. The active branch is the path from currentLeafId to the root. Do not assume the last JSONL line is on the active branch.
- ${checkerAuditProfilePromptText()}
- When read/search/list tools and a session file are available, you may inspect evidence needed for judgment: read the session artifact, read referenced files, search the workspace, or activate relevant skills.
- If the session file or needed inspection tool is unavailable, do not pretend to have inspected missing history; return complete=false unless the provided goal state and navigation context already prove every requirement.
- Distinguish evidence the worker surfaced from evidence you inspected yourself. Checker-side inspection may corroborate completion, reveal missing evidence, or sharpen next guidance.
- Do not use checker-side tools to perform omitted primary success work on the worker's behalf. If tests, builds, evals, deployments, shell commands, or other primary verification are required and the session state does not show they were done, return complete=false and tell the worker to do or surface that verification.
- Avoid destructive or unnecessary state-changing actions; this checker profile is inspection-only.
- If required verification is missing, weak, indirect, or the goal was narrowed by the worker, return complete=false and tell the worker what evidence to surface next.
- Before returning blocked, identify the smallest useful next action the worker could take. If one exists — inspect, test, retry, ask the user, or use an available focused user-question tool — return decision=continue with that nextTurnGuidance.
- Use decision=waiting_for_user only when the worker has already asked for the needed user/external signal and no useful automatic continuation remains before that answer.
- Use decision=blocked only when no safe/actionable next step remains inside the session, or continuing would loop or waste work.
- Budget or time limits are not completion.
- Prefer a false negative over a false positive.

Return ONLY valid JSON with this shape:
{
  "decision": "complete|continue|waiting_for_user|blocked",
  "complete": boolean,
  "blocked": boolean,
  "reason": "short explanation",
  "nextTurnGuidance": "what the worker should do next if not complete",
  "evidence": ["evidence you relied on"],
  "unmetRequirements": ["requirements not yet proven"],
  "requirements": [
    {"requirement": "...", "status": "satisfied|unsatisfied|unclear|not_applicable", "evidence": "..."}
  ]
}

Decision meanings:
- complete: all goal requirements are proven; set complete=true.
- continue: incomplete, but the worker has a meaningful next action. Missing evidence alone usually belongs here.
- waiting_for_user: incomplete, the worker already asked for the needed user/external answer, and the next event should be that answer.
- blocked: incomplete and no safe/actionable next step remains; blocked is a last resort.

Goal state:
${state}

Session navigation context:
${sessionContext}`;
}

export function buildCheckerSessionContext(
  entries: SessionEntryLike[],
  sessionFile: string | undefined,
  currentLeafId: string | null,
  latestTurnMessages: MessageLike[],
  turnHadToolUse: boolean,
): CheckerSessionContext {
  const normalizedSessionFile = sessionFile?.trim() || undefined;
  return {
    sessionFormat: "pi-jsonl-tree",
    sessionFile: normalizedSessionFile,
    sessionUnavailableReason: normalizedSessionFile ? undefined : "in_memory_or_not_persisted",
    currentLeafId,
    branchEntryCount: entries.length,
    branchMessageCount: entries.filter((entry) => entry.type === "message").length,
    latestTurn: latestTurnSummary(latestTurnMessages, turnHadToolUse),
  };
}

function latestTurnSummary(messages: MessageLike[], turnHadToolUse: boolean): CheckerSessionContext["latestTurn"] {
  let assistantMessageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let finalAssistantStopReason: string | undefined;
  let finalAssistantErrorMessage: string | undefined;
  const toolNames: string[] = [];

  for (const message of messages) {
    if (message.role === "assistant") assistantMessageCount += 1;
    if (message.role === "toolResult") {
      toolResultCount += 1;
      addUnique(toolNames, stringProperty(message, "toolName"));
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isToolCallBlock(block)) continue;
        toolCallCount += 1;
        addUnique(toolNames, block.name);
      }
    }
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    finalAssistantStopReason = message.stopReason;
    finalAssistantErrorMessage = message.errorMessage;
    break;
  }

  return {
    messageCount: messages.length,
    assistantMessageCount,
    toolCallCount,
    toolResultCount,
    toolNames,
    hadToolUse: turnHadToolUse,
    finalAssistantStopReason,
    finalAssistantErrorMessage,
  };
}

function goalBlock(goal: ActiveGoal): string {
  return `<goal_objective>\n${escapeXml(goal.goal)}\n</goal_objective>`;
}

function goalForChecker(goal: ActiveGoal): Record<string, unknown> {
  return {
    id: goal.id,
    goal: goal.goal,
    status: goal.status,
    iteration: goal.iteration,
    checkerIteration: goal.checkerIteration,
    tokensUsed: goal.tokensUsed,
    turnsUsed: goal.turnsUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    tokenBudget: goal.tokenBudget,
    turnBudget: goal.turnBudget,
    timeBudgetSeconds: goal.timeBudgetSeconds,
    lastCheckerVerdict: goal.lastCheckerVerdict,
    lastTransitionReason: goal.lastTransitionReason,
    consecutiveNoToolContinuations: goal.consecutiveNoToolContinuations,
  };
}

function addUnique(values: string[], value: string | undefined): void {
  if (!value || values.includes(value)) return;
  values.push(value);
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const property = value[key];
  return typeof property === "string" && property.trim().length > 0 ? property.trim() : undefined;
}

function isToolCallBlock(value: unknown): value is ToolCallBlockLike {
  return isRecord(value) && value.type === "toolCall" && typeof value.name === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
