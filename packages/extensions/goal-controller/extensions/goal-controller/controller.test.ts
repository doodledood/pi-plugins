import test from "node:test";
import assert from "node:assert/strict";
import { applyCheckerVerdict, loadGoalFromSession, markChecking, maybeApplyBudgetLimit, pauseGoal, resumeGoal, startGoal, updateUsage } from "./controller.ts";
import { DEFAULT_CONFIG } from "./config.ts";

const config = DEFAULT_CONFIG;

test("startGoal accepts any non-empty goal when no non-terminal goal exists", () => {
  const result = startGoal(undefined, "  implement PLAN.md  ", config, 100);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected accepted goal");
  assert.equal(result.goal.goal, "implement PLAN.md");
  assert.equal(result.goal.status, "active");
  assert.equal(result.goal.baselineTokens, 100);
});

test("startGoal rejects blank goals", () => {
  const result = startGoal(undefined, "   ", config, 0);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected rejected goal");
  assert.equal(result.error, "empty_goal");
});

test("startGoal rejects when non-terminal goal exists and preserves current goal", () => {
  const first = startGoal(undefined, "first", config, 0);
  if (!first.ok) throw new Error("expected first goal");
  const second = startGoal(first.goal, "second", config, 0);
  assert.equal(second.ok, false);
  if (second.ok) throw new Error("expected active goal error");
  assert.equal(second.error, "active_goal_exists");
  assert.equal(second.activeGoal, first.goal);
  assert.equal(first.goal.goal, "first");
});

test("startGoal rejects while a goal is waiting for user input", () => {
  const first = startGoal(undefined, "first", config, 0);
  if (!first.ok) throw new Error("expected first goal");
  const waiting = applyCheckerVerdict(first.goal, { decision: "waiting_for_user", complete: false, reason: "waiting" }, config, true);
  const second = startGoal(waiting, "second", config, 0);
  assert.equal(second.ok, false);
  if (second.ok) throw new Error("expected active goal error");
  assert.equal(second.error, "active_goal_exists");
});

test("startGoal can create a new goal after terminal complete", () => {
  const first = startGoal(undefined, "first", config, 0);
  if (!first.ok) throw new Error("expected first goal");
  const complete = applyCheckerVerdict(first.goal, { decision: "complete", complete: true, reason: "done" }, config, true);
  const second = startGoal(complete, "second", config, 0);
  assert.equal(second.ok, true);
  if (!second.ok) throw new Error("expected second goal");
  assert.equal(second.goal.goal, "second");
});

test("checker complete is the only terminal complete transition in controller", () => {
  const started = startGoal(undefined, "finish task", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const complete = applyCheckerVerdict(started.goal, { decision: "complete", complete: true, reason: "all criteria proven", evidence: ["tests pass"] }, config, true);
  assert.equal(complete.status, "complete");
  assert.equal(complete.lastCheckerVerdict?.complete, true);
  assert.equal(complete.awaitingContinuationTurn, false);
});

test("checker not-complete keeps active and prepares continuation guidance", () => {
  const started = startGoal(undefined, "finish task", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const next = applyCheckerVerdict(started.goal, { decision: "continue", complete: false, reason: "tests not run", nextTurnGuidance: "run tests" }, config, true);
  assert.equal(next.status, "active");
  assert.equal(next.awaitingContinuationTurn, true);
  assert.equal(next.iteration, started.goal.iteration + 1);
  assert.equal(next.lastCheckerVerdict?.reason, "tests not run");
});

test("checker waiting_for_user verdict waits without completing or blocking", () => {
  const started = startGoal(undefined, "make me laugh", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const waiting = applyCheckerVerdict(
    started.goal,
    { decision: "waiting_for_user", complete: false, reason: "worker asked the user whether they laughed" },
    config,
    true,
  );
  assert.equal(waiting.status, "waiting_for_user");
  assert.equal(waiting.awaitingContinuationTurn, false);
  assert.equal(waiting.lastCheckerVerdict?.decision, "waiting_for_user");
});

test("checker blocked verdict blocks without completing", () => {
  const started = startGoal(undefined, "finish task", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const blocked = applyCheckerVerdict(started.goal, { decision: "blocked", complete: false, blocked: true, reason: "missing credentials" }, config, true);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.lastCheckerVerdict?.blocked, true);
});

test("consecutive no-tool continuations block only after configured threshold", () => {
  const started = startGoal(undefined, "finish task", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const first = applyCheckerVerdict(started.goal, { decision: "continue", complete: false, reason: "not done" }, config, true);
  const second = applyCheckerVerdict(first, { decision: "continue", complete: false, reason: "still not done" }, config, false);
  const third = applyCheckerVerdict(second, { decision: "continue", complete: false, reason: "still not done" }, config, false);
  const fourth = applyCheckerVerdict(third, { decision: "continue", complete: false, reason: "still not done" }, config, false);
  assert.equal(second.status, "active");
  assert.equal(second.consecutiveNoToolContinuations, 1);
  assert.equal(third.status, "active");
  assert.equal(third.consecutiveNoToolContinuations, 2);
  assert.equal(fourth.status, "blocked");
  assert.match(fourth.lastTransitionReason ?? "", /3 consecutive automatic continuation/iu);
});

test("tool progress resets consecutive no-tool continuation count", () => {
  const started = startGoal(undefined, "finish task", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const first = applyCheckerVerdict(started.goal, { decision: "continue", complete: false, reason: "not done" }, config, true);
  const second = applyCheckerVerdict(first, { decision: "continue", complete: false, reason: "still not done" }, config, false);
  const third = applyCheckerVerdict(second, { decision: "continue", complete: false, reason: "tool progress" }, config, true);
  assert.equal(second.consecutiveNoToolContinuations, 1);
  assert.equal(third.status, "active");
  assert.equal(third.consecutiveNoToolContinuations, 0);
});

test("old persisted goals hydrate missing no-tool continuation count", () => {
  const started = startGoal(undefined, "finish task", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const legacyGoal = { ...started.goal } as Record<string, unknown>;
  delete legacyGoal.consecutiveNoToolContinuations;
  const loaded = loadGoalFromSession([{ type: "custom", customType: "goal-controller-state", data: { goal: legacyGoal } }]);
  assert.equal(loaded?.consecutiveNoToolContinuations, 0);
});

test("loadGoalFromSession recovers persisted checking as paused with resume guidance", () => {
  const started = startGoal(undefined, "finish task", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const checking = markChecking(started.goal);

  const loaded = loadGoalFromSession([{ type: "custom", customType: "goal-controller-state", data: { goal: checking } }]);

  assert.equal(loaded?.status, "paused");
  assert.notEqual(loaded?.status, "checking");
  assert.match(loaded?.lastTransitionReason ?? "", /checker interrupted/iu);
  assert.match(loaded?.lastTransitionReason ?? "", /\/goal_resume/iu);
  assert.equal(loaded?.awaitingContinuationTurn, false);
});

test("token budget limit is not completion", () => {
  const started = startGoal(undefined, "finish task", { ...config, defaultTokenBudget: 10 }, 100);
  if (!started.ok) throw new Error("expected goal");
  const used = updateUsage(started.goal, 111);
  const limited = maybeApplyBudgetLimit(used);
  assert.equal(limited.status, "budget_limited");
  assert.equal(limited.lastCheckerVerdict, undefined);
});

test("turn budget limit is not completion", () => {
  const started = startGoal(undefined, "finish task", { ...config, defaultTurnBudget: 1 }, 0);
  if (!started.ok) throw new Error("expected goal");
  const used = updateUsage(started.goal, 0, Date.now(), true);
  const limited = maybeApplyBudgetLimit(used);
  assert.equal(limited.status, "budget_limited");
  assert.equal(limited.lastTransitionReason, "Goal turn budget reached (1/1).");
  assert.equal(limited.lastCheckerVerdict, undefined);
});

test("pause and resume are user/system state transitions, not completion", () => {
  const started = startGoal(undefined, "finish task", config, 0);
  if (!started.ok) throw new Error("expected goal");
  const paused = pauseGoal(started.goal, "interrupted");
  assert.equal(paused.status, "paused");
  const resumed = resumeGoal(paused);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.lastTransitionReason, "resumed by user");
});
