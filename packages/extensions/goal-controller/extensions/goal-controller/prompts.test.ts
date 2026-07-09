import test from "node:test";
import assert from "node:assert/strict";
import { createGoal } from "./controller.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { buildActiveGoalSystemPrompt, GOAL_DESCRIPTION, GOAL_GUIDELINES } from "./prompts.ts";

test("active goal prompt distinguishes live restrictions from fresh start after completion", () => {
  const prompt = buildActiveGoalSystemPrompt(createGoal("finish the current task", DEFAULT_CONFIG, 0, 0));

  assert.match(prompt, /While this goal is live/u);
  assert.match(prompt, /cannot complete, update, edit, replace, clear, pause, resume, or override it/u);
  assert.match(prompt, /After the checker marks this goal complete/u);
  assert.match(prompt, /use the goal tool to start a fresh goal/u);
  assert.match(prompt, /Starting fresh is not completing, resuming, editing, or overriding the completed goal/u);
});

test("model-facing goal tool guidance allows fresh goals without acting on existing goals", () => {
  assert.match(GOAL_DESCRIPTION, /always creates a fresh goal/u);
  assert.match(GOAL_DESCRIPTION, /completed goal/u);
  assert.match(GOAL_DESCRIPTION, /prior non-live goal remains history/u);
  assert.match(GOAL_DESCRIPTION, /never updates, edits, clears, pauses, resumes, or completes any existing goal/u);
  assert.ok(
    GOAL_GUIDELINES.some(
      (guideline) =>
        guideline.includes("Completed, paused, blocked, and budget-limited goals are not live") &&
        guideline.includes("starting fresh does not update, resume, or complete the prior goal"),
    ),
  );
  assert.ok(
    GOAL_GUIDELINES.some(
      (guideline) =>
        guideline.includes("Do not call goal to replace, narrow, or edit a live goal") &&
        guideline.includes("the model-facing goal tool is start-only"),
    ),
  );
});
