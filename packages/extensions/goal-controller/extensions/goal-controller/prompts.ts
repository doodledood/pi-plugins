import type { ActiveGoal, CheckerVerdict, MessageLike, SessionEntryLike, TextBlockLike, ToolCallBlockLike } from "./types.ts";

export const GOAL_DESCRIPTION =
  "Start a long-running goal when no non-terminal goal is active. Input is one goal string. " +
  "Use goal for work that may take multiple turns and has a meaningful completion condition. " +
  "Write the goal as a compact completion contract: state the durable objective, desired end state, verification signal, important constraints, and any stop/block condition. " +
  "The goal may reference files, docs, issues, or plans for context. Prefer text standalone enough for an independent checker to understand what done means. " +
  "For longer goals, include how compact progress should be recorded, such as checkpoint notes covering what changed, what was verified, what remains, and blockers. " +
  "goal only creates a goal; it never updates, replaces, edits, clears, pauses, resumes, or completes an active goal.";

export const GOAL_GUIDELINES = [
  "Use goal only when no goal is active and the work may require multiple turns toward a verifiable end state.",
  "When calling goal, put the objective, done criteria, verification signal, constraints, and stop/block condition into the single goal string; include compact checkpoint-progress expectations when useful.",
  "Do not call goal to replace or narrow an active goal. If another goal is active, continue it or ask the user to edit or clear it.",
] as const;

export function buildActiveGoalSystemPrompt(goal: ActiveGoal): string {
  return `Active goal-controller goal:\n${goalBlock(goal)}\n\nGoal-controller rules:\n- Work toward the exact active goal.\n- The worker model cannot complete, update, replace, clear, pause, resume, or override this goal. Only the goal-controller checker can complete it.\n- Surface evidence in normal responses and tool output: commands run, results observed, files or artifacts changed, remaining gaps, and blockers.\n- If the missing evidence is the user's reaction, preference, or confirmation, ask the user directly; use an available focused user-question tool when appropriate.\n- If the goal text asks for compact checkpoint progress, honor that in normal responses.\n- If you believe the goal is complete, state the evidence; do not call or invent a completion tool.\n- If blocked, state the blocker and the exact external input or state needed.`;
}

export function buildContinuationPrompt(goal: ActiveGoal, verdict: CheckerVerdict): string {
  const guidance = verdict.nextTurnGuidance?.trim() || verdict.reason;
  return `The goal-controller checker says the active goal is not complete. Continue working toward this goal.\n\n${goalBlock(goal)}\n\nChecker reason:\n${verdict.reason}\n\nNext guidance:\n${guidance}\n\nRemember: only the checker can complete the goal. Surface concrete verification evidence as you proceed.`;
}

export function buildCheckerPrompt(goal: ActiveGoal, transcript: string, sessionFile: string | undefined): string {
  const state = JSON.stringify(goalForChecker(goal), null, 2);
  const sessionFileText = sessionFile?.trim() || "(none: current Pi session is in-memory or not persisted)";
  return `You are the independent goal-controller checker. Your only job is to decide whether the active goal is truly complete. You are not the worker that did the task. Be skeptical and evidence-driven.\n\nRules:\n- Treat completion as unproven.\n- Audit the exact goal text requirement by requirement.\n- Worker claims are claims, not proof. Prefer concrete evidence surfaced in this transcript: command outputs, test/build/lint results, file/artifact descriptions, diffs summarized by the worker, or other surfaced evidence.\n- Tool availability is controlled by checker.toolMode: transcript mode may have no tools, inspect mode supports inspection while excluding obvious local mutation tools, and full mode is explicit opt-in for unrestricted tools.\n- When tools are available, you may use them to inspect evidence needed for judgment: read files/logs/session artifacts, search, query, or run commands that gather context or inspect state.\n- Distinguish evidence the worker surfaced from evidence you inspected yourself. Checker-side inspection may corroborate completion, reveal missing evidence, or sharpen next guidance.\n- Do not use checker-side tools to perform omitted primary success work on the worker's behalf. If tests, builds, evals, deployments, or other primary verification are required and the transcript/state does not show they were done, return complete=false and tell the worker to do or surface that verification.\n- Avoid destructive or unnecessary state-changing actions; prefer inspection over mutation.\n- The provided transcript is the main evidence source. The session file path is available so you can inspect the exact session artifact if useful.\n- If required verification is missing, weak, indirect, or the goal was narrowed by the worker, return complete=false and tell the worker what evidence to surface next.\n- Before returning blocked, identify the smallest useful next action the worker could take. If one exists — inspect, test, retry, ask the user, or use an available focused user-question tool — return decision=continue with that nextTurnGuidance.\n- Use decision=waiting_for_user only when the worker has already asked for the needed user/external signal and no useful automatic continuation remains before that answer.\n- Use decision=blocked only when no safe/actionable next step remains inside the session, or continuing would loop or waste work.\n- Budget or time limits are not completion.\n- Prefer a false negative over a false positive.\n\nReturn ONLY valid JSON with this shape:\n{\n  "decision": "complete|continue|waiting_for_user|blocked",\n  "complete": boolean,\n  "blocked": boolean,\n  "reason": "short explanation",\n  "nextTurnGuidance": "what the worker should do next if not complete",\n  "evidence": ["evidence you relied on"],\n  "unmetRequirements": ["requirements not yet proven"],\n  "requirements": [\n    {"requirement": "...", "status": "satisfied|unsatisfied|unclear|not_applicable", "evidence": "..."}\n  ]\n}\n\nDecision meanings:\n- complete: all goal requirements are proven; set complete=true.\n- continue: incomplete, but the worker has a meaningful next action. Missing evidence alone usually belongs here.\n- waiting_for_user: incomplete, the worker already asked for the needed user/external answer, and the next event should be that answer.\n- blocked: incomplete and no safe/actionable next step remains; blocked is a last resort.\n\nGoal state:\n${state}\n\nCurrent Pi session file path:\n${sessionFileText}\n\nConversation transcript/evidence, newest material toward the end:\n${transcript}`;
}

export function buildTranscript(entries: SessionEntryLike[], maxChars: number): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const line = messageToLine(entry.message);
    if (line) lines.push(line);
  }
  const transcript = lines.join("\n\n");
  if (transcript.length <= maxChars) return transcript;
  return `[Earlier transcript omitted: ${transcript.length - maxChars} chars]\n${transcript.slice(-maxChars)}`;
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
  };
}

function messageToLine(message: MessageLike): string | undefined {
  const role = message.role ?? "unknown";
  if (role === "assistant") return `assistant:\n${contentToText(message.content)}`;
  if (role === "user") return `user:\n${contentToText(message.content)}`;
  if (role === "toolResult") return `toolResult:\n${contentToText(message.content)}`;
  if (role === "bashExecution") return `bashExecution:\n${contentToText(message.content)}`;
  if (role === "custom") return undefined;
  return `${role}:\n${contentToText(message.content)}`;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (isTextBlock(item)) parts.push(item.text);
    else if (isToolCallBlock(item)) parts.push(`[tool call: ${item.name}]`);
  }
  return parts.join("\n");
}

function isTextBlock(value: unknown): value is TextBlockLike {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
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
