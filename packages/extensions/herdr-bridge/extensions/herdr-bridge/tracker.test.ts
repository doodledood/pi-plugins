import assert from "node:assert/strict";
import test from "node:test";
import type { AgentStatus, AgentView } from "./herdr.ts";
import { DEFAULT_QUIET_INTERVAL_MS, type TrackedSession, type Wakeup, observe, track } from "./tracker.ts";

const MIN = 60_000;
const agent = (status: AgentStatus, completionSeq?: number, paneId = "w1:p2", kind = "pi"): AgentView => ({
  paneId,
  tabId: "w1:t2",
  workspaceId: "w1",
  name: "worker",
  kind,
  status,
  completionSeq,
});
const kinds = (wakeups: Wakeup[]) => wakeups.map((w) => w.kind);

test("the quiet interval defaults to ten minutes, /orchestrate's check-in cadence", () => {
  assert.equal(DEFAULT_QUIET_INTERVAL_MS, 10 * MIN);
});

test("a finished turn wakes once; idle and done count as one finished state", () => {
  let tracked: TrackedSession[] = [track("worker", "w1:p2", 0, 1)];
  let step = observe(tracked, [agent("working", 1)], 1_000);
  assert.deepEqual(kinds(step.wakeups), []);
  step = observe(step.tracked, [agent("idle", 2)], 2_000);
  assert.deepEqual(kinds(step.wakeups), ["finished"]);
  step = observe(step.tracked, [agent("done", 2)], 3_000);
  assert.deepEqual(kinds(step.wakeups), [], "done after idle is the same finished state");
  step = observe(step.tracked, [agent("idle", 2)], 4_000);
  assert.deepEqual(kinds(step.wakeups), [], "focusing the pane (done -> idle) adds nothing");
  tracked = step.tracked;
  assert.equal(tracked[0]!.phase, "finished");
});

test("a turn that finished and restarted between two looks still wakes, through the completion count", () => {
  const step = observe([track("worker", "w1:p2", 0, 4)], [agent("working", 5)], 1_000);
  assert.deepEqual(kinds(step.wakeups), ["finished"]);
});

test("leaving a question back to work after finishing a turn between two looks still wakes as finished", () => {
  const blocked = observe([track("worker", "w1:p2", 0, 1)], [agent("blocked", 1)], 1_000);
  const step = observe(blocked.tracked, [agent("working", 2)], 2_000);
  assert.deepEqual(kinds(step.wakeups), ["finished"]);
});

test("blocking wakes once, and unblocking back to work adds nothing", () => {
  let step = observe([track("worker", "w1:p2", 0, 1)], [agent("blocked", 1)], 1_000);
  assert.deepEqual(kinds(step.wakeups), ["blocked"]);
  step = observe(step.tracked, [agent("blocked", 1)], 2_000);
  assert.deepEqual(kinds(step.wakeups), [], "an unchanged report adds nothing");
  step = observe(step.tracked, [agent("working", 1)], 3_000);
  assert.deepEqual(kinds(step.wakeups), []);
});

test("an exit, a closed pane, or another program taking the pane is gone once and dropped", () => {
  for (const agents of [[], [agent("idle", 1, "w1:p2", "claude")]]) {
    const step = observe([track("worker", "w1:p2", 0, 1)], agents, 1_000);
    assert.deepEqual(kinds(step.wakeups), ["gone"]);
    assert.equal(step.tracked.length, 0);
  }
});

test("unknown keeps the last phase and reports nothing", () => {
  let step = observe([track("worker", "w1:p2", 0, 1)], [agent("idle", 2)], 1_000);
  assert.deepEqual(kinds(step.wakeups), ["finished"]);
  step = observe(step.tracked, [agent("unknown", 2)], 2_000);
  assert.deepEqual(kinds(step.wakeups), []);
  assert.equal(step.tracked[0]!.phase, "finished");
});

test("a session working with no change wakes after each quiet interval, and not once it changes", () => {
  let step = observe([track("worker", "w1:p2", 0, 1)], [agent("working", 1)], 9 * MIN);
  assert.deepEqual(kinds(step.wakeups), []);
  step = observe(step.tracked, [agent("working", 1)], 10 * MIN);
  assert.deepEqual(kinds(step.wakeups), ["quiet"]);
  assert.deepEqual(step.wakeups[0], { kind: "quiet", name: "worker", paneId: "w1:p2", quietMinutes: 10 });
  step = observe(step.tracked, [agent("working", 1)], 15 * MIN);
  assert.deepEqual(kinds(step.wakeups), []);
  step = observe(step.tracked, [agent("working", 1)], 20 * MIN);
  assert.deepEqual(kinds(step.wakeups), ["quiet"]);
  assert.deepEqual(step.wakeups[0], { kind: "quiet", name: "worker", paneId: "w1:p2", quietMinutes: 20 });
  step = observe(step.tracked, [agent("idle", 2)], 21 * MIN);
  assert.deepEqual(kinds(step.wakeups), ["finished"]);
  step = observe(step.tracked, [agent("idle", 2)], 40 * MIN);
  assert.deepEqual(kinds(step.wakeups), [], "a finished session is never quiet");
});

test("only tracked sessions wake: another agent's changes add nothing", () => {
  const step = observe([track("worker", "w1:p2", 0, 1)], [agent("working", 1), { ...agent("idle", 9, "w1:p9"), name: "other" }], 1_000);
  assert.deepEqual(kinds(step.wakeups), []);
});

test("generated sequences: blocked is never reported twice without a change between", () => {
  const statuses: AgentStatus[] = ["working", "idle", "done", "blocked", "unknown"];
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let run = 0; run < 200; run++) {
    let tracked: TrackedSession[] = [track("worker", "w1:p2", 0, 0)];
    let seq = 0;
    let lastReported: string | undefined;
    for (let t = 1; t <= 40; t++) {
      const status = statuses[Math.floor(rand() * statuses.length)]!;
      if (status === "idle" || status === "done") if (rand() < 0.5) seq++;
      const step = observe(tracked, [agent(status, seq)], t * 1_000, 10 * MIN);
      for (const w of step.wakeups) {
        if (w.kind === "blocked") assert.notEqual(lastReported, "blocked", "blocked reported twice with no change between");
        lastReported = w.kind;
      }
      if (status === "working" && step.wakeups.length === 0) lastReported = "working";
      tracked = step.tracked;
    }
  }
});
