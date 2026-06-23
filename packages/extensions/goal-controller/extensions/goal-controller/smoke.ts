import assert from "node:assert/strict";
import { applyCheckerVerdict, startGoal } from "./controller.ts";
import { DEFAULT_CONFIG } from "./config.ts";

const started = startGoal(undefined, "Smoke goal: finish only when fake checker says complete", DEFAULT_CONFIG, 0);
assert.equal(started.ok, true);
if (!started.ok) throw new Error("smoke setup failed");

const activeConflict = startGoal(started.goal, "replacement attempt", DEFAULT_CONFIG, 0);
assert.equal(activeConflict.ok, false);

const completed = applyCheckerVerdict(
  started.goal,
  { decision: "complete", complete: true, reason: "fake checker complete", evidence: ["smoke"] },
  DEFAULT_CONFIG,
  true,
);
assert.equal(completed.status, "complete");
assert.equal(completed.lastCheckerVerdict?.complete, true);

console.log("goal-controller smoke PASS");
