// Goal decisions against a real Pi AgentSession: the controller must decide only
// once Pi has settled the run (retries, compaction, queued messages), never at
// the first agent_end. Only the checker subprocess and the provider are scripted.
import test from "node:test";
import assert from "node:assert/strict";
import type { Context } from "@earendil-works/pi-ai/compat";
import {
  completeVerdict,
  continueVerdict,
  createHarness,
  lastUserText,
  ScriptedChecker,
  textOf,
  waitingVerdict,
  waitUntil,
} from "./real-pi-harness.ts";

async function settle(h: { session: { agent: { waitForIdle(): Promise<void> } } }): Promise<void> {
  await h.session.agent.waitForIdle();
  await new Promise((resolve) => setTimeout(resolve, 30));
}

test("a provider error Pi retries successfully is checked and does not pause the goal", { timeout: 10_000 }, async () => {
  const checker = new ScriptedChecker([completeVerdict("proved")]);
  const h = await createHarness({
    checker,
    replies: (_ctx, call) => (call === 1 ? { kind: "error", errorMessage: "529 overloaded_error: Overloaded" } : { kind: "text", text: "Work finished, tests pass." }),
  });
  await h.session.prompt("/goal make tests pass");
  await waitUntil(() => h.providerCalls.length >= 2);
  await settle(h);
  assert.equal(h.providerCalls.length, 2, "Pi auto-retried the turn");
  assert.equal(checker.inputs.length, 1, "the checker judges the retried turn");
  assert.equal(h.stateEntries().some((goal) => goal.status === "paused"), false);
  assert.equal(h.goalState().status, "complete");
});

test("a provider error Pi gives up on pauses the goal without running the checker", { timeout: 10_000 }, async () => {
  const checker = new ScriptedChecker([]);
  const h = await createHarness({
    checker,
    replies: () => ({ kind: "error", errorMessage: "529 overloaded_error: Overloaded" }),
  });
  await h.session.prompt("/goal make tests pass");
  await waitUntil(() => h.goalState().status !== "active", 5_000);
  await settle(h);
  assert.ok(h.providerCalls.length >= 2, "Pi retried before giving up");
  assert.equal(checker.inputs.length, 0);
  assert.equal(h.goalState().status, "paused");
  assert.match(h.goalState().lastTransitionReason, /agent error/u);
});

test("a reply the user queues while the checker runs resumes a waiting goal", { timeout: 10_000 }, async () => {
  const checker = new ScriptedChecker(["defer", completeVerdict("answer applied")]);
  const h = await createHarness({
    checker,
    replies: (ctx) => (lastUserText(ctx).includes("Option B")
      ? { kind: "text", text: "Applied option B; verified." }
      : { kind: "text", text: "Should I use option A or option B?" }),
  });
  const arrived = checker.waitForRun();
  await h.session.prompt("/goal pick and apply an option");
  await arrived;
  assert.equal(h.goalState().status, "checking");
  await h.session.prompt("Option B please", { streamingBehavior: "followUp" });
  checker.resolveNext(waitingVerdict("worker asked which option"));
  await waitUntil(() => checker.inputs.length >= 2);
  await settle(h);
  assert.equal(lastUserText(h.providerCalls[1]!), "Option B please");
  assert.equal(h.goalState().status, "complete", "the queued reply resumed the goal and its turn was checked");
});

test("a question the user queues during checking is not counted as an automatic no-tool continuation", { timeout: 10_000 }, async () => {
  const checker = new ScriptedChecker(["defer", continueVerdict("more"), completeVerdict("done")]);
  const h = await createHarness({
    checker,
    config: { continuation: { noToolContinuationLimit: 1 } },
    replies: (ctx) => (lastUserText(ctx).includes("status?") ? { kind: "text", text: "We are halfway." } : { kind: "text", text: "Started work." }),
  });
  const arrived = checker.waitForRun();
  await h.session.prompt("/goal do the long task");
  await arrived;
  await h.session.prompt("quick status?", { streamingBehavior: "followUp" });
  checker.resolveNext(continueVerdict("keep going"));
  await waitUntil(() => checker.inputs.length >= 3);
  await settle(h);
  assert.equal(h.stateEntries().some((goal) => goal.status === "blocked"), false, "the user's turn was counted as an automatic continuation");
  assert.equal(h.goalState().status, "complete");
});

test("the turn that uses up a budget is still checked", { timeout: 10_000 }, async () => {
  const checker = new ScriptedChecker([completeVerdict("all proven")]);
  const h = await createHarness({
    checker,
    config: { defaultTurnBudget: 1 },
    replies: () => ({ kind: "text", text: "Done: all tests pass." }),
  });
  await h.session.prompt("/goal one-shot task");
  await settle(h);
  assert.equal(checker.inputs.length, 1);
  assert.equal(h.goalState().status, "complete");
});

// Holds docs/adr/20261022-resume-budget-limited-goals-into-a-fresh-budget-window.md — weakening this test reverses that decision.
test("resuming a budget-limited goal opens a fresh budget window and can complete", { timeout: 10_000 }, async () => {
  const checker = new ScriptedChecker([continueVerdict("not yet"), completeVerdict("all proven")]);
  const h = await createHarness({
    checker,
    config: { defaultTurnBudget: 1 },
    replies: () => ({ kind: "text", text: "Progress made." }),
  });
  await h.session.prompt("/goal two-step task");
  await settle(h);
  assert.equal(h.goalState().status, "budget_limited", "a continue verdict past the budget stops continuation");
  assert.equal(h.goalState().turnsUsed, 1);
  await h.session.prompt("/goal_resume");
  await waitUntil(() => checker.inputs.length >= 2);
  await settle(h);
  const goal = h.goalState();
  assert.equal(goal.status, "complete");
  assert.equal(goal.turnsUsed, 2, "lifetime turn count keeps both turns");
  assert.deepEqual(goal.budgetWindowStart?.turns, 1, "the resumed window started after the first turn");
});

function contextTexts(ctx: Context): string[] {
  return ctx.messages.map((message) => textOf((message as { content?: unknown }).content));
}

test("a goal the model starts mid-run carries its own reminder after the old goal's retraction", { timeout: 10_000 }, async () => {
  const checker = new ScriptedChecker(["defer", continueVerdict("continue B"), completeVerdict("B done")]);
  let phase = "A";
  const h = await createHarness({
    checker,
    replies: (ctx) => {
      const last = ctx.messages.at(-1) as { role?: string } | undefined;
      if (phase === "B-start" && last?.role === "user") return { kind: "tool", name: "goal", args: { goal: "GOAL-B: write docs" } };
      if (phase === "B-start" && last?.role === "toolResult") return { kind: "text", text: "Started goal B." };
      return { kind: "text", text: "working" };
    },
  });
  const arrivedA = checker.waitForRun();
  await h.session.prompt("/goal GOAL-A: refactor module");
  await arrivedA;
  await h.session.prompt("/goal_pause");
  await settle(h);
  assert.equal(h.goalState().status, "paused");

  phase = "B-start";
  const before = h.providerCalls.length;
  await h.session.prompt("Start a new goal for writing docs.");
  phase = "B";
  await waitUntil(() => checker.inputs.length >= 3);
  await settle(h);
  assert.equal(h.goalState().status, "complete");

  // Every call after the goal tool ran belongs to GOAL-B's run.
  const goalBCalls = h.providerCalls.slice(before + 1);
  assert.ok(goalBCalls.length >= 2);
  for (const call of goalBCalls) {
    const texts = contextTexts(call);
    const reminderB = texts.findLastIndex((text) => text.startsWith("Active goal-controller goal") && text.includes("GOAL-B"));
    const reminderA = texts.findLastIndex((text) => text.startsWith("Active goal-controller goal") && text.includes("GOAL-A"));
    const retraction = texts.findLastIndex((text) => text.includes("reminder no longer applies"));
    assert.ok(reminderB >= 0, "GOAL-B's reminder is in context");
    assert.ok(retraction > reminderA && retraction < reminderB, "GOAL-A's reminder is retracted before GOAL-B's reminder");
  }
});

test("a budget-limited goal's fresh window starts at the resume, after turns run while it was stopped", { timeout: 10_000 }, async () => {
  // Each provider call bills 15 tokens; the budget is 20, so the goal's second turn uses it up.
  const checker = new ScriptedChecker([continueVerdict("not yet"), continueVerdict("not yet"), continueVerdict("one more"), completeVerdict("all proven")]);
  const h = await createHarness({
    checker,
    config: { defaultTokenBudget: 20 },
    replies: () => ({ kind: "text", text: "Progress made." }),
  });
  await h.session.prompt("/goal token task");
  await waitUntil(() => h.goalState().status === "budget_limited");
  await settle(h);
  const stopped = h.goalState();
  // The user chats while the goal is stopped.
  for (const text of ["unrelated question 1", "unrelated question 2", "unrelated question 3"]) {
    await h.session.prompt(text);
    await settle(h);
  }
  await h.session.prompt("/goal_resume");
  await waitUntil(() => h.goalState().status !== "active" && h.goalState().status !== "checking", 5_000);
  await settle(h);
  const goal = h.goalState();
  assert.equal(goal.budgetWindowStart?.tokens, stopped.tokensUsed + 3 * 15, "the window started before the chat turns");
  assert.equal(goal.status, "complete", `the resumed goal stopped early: ${goal.lastTransitionReason}`);
  assert.equal(goal.turnsUsed, stopped.turnsUsed + 2, "the resumed window allowed a full budget of goal turns");
});
