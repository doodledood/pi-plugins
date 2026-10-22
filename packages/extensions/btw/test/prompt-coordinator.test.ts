import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildPromptCoordinator,
  type ChildPromptSessionPort,
  type ParentUpdateAnnouncement,
  type QueuedPrompt,
} from "../src/prompt-coordinator.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A stand-in for AgentSession's prompt path: idle, a prompt starts a run that lasts until
 * `runGate` opens; while a run is active, a prompt is queued under its streaming behavior,
 * as Pi does.
 */
function coordinatorHarness(overrides: Partial<ChildPromptSessionPort> = {}) {
  const events: string[] = [];
  const discarded: string[] = [];
  const queue: QueuedPrompt[] = [];
  let running = false;
  let runGate = Promise.resolve();
  let aborts = 0;
  let queueChanges = 0;
  const port: ChildPromptSessionPort = {
    async prompt(text, mode, onAdmitted) {
      events.push(`preflight:${text}`);
      if (running) {
        queue.push({ text, mode });
        events.push(`queued-${mode}:${text}`);
        onAdmitted();
        return;
      }
      running = true;
      events.push(`run:${text}`);
      onAdmitted();
      try {
        await runGate;
      } finally {
        running = false;
        events.push(`run-end:${text}`);
      }
    },
    async appendAnnouncement(announcement, mode) {
      events.push(running ? `announcement-${mode}:${announcement.parentHeadId}` : `announcement:${announcement.parentHeadId}`);
    },
    isIdle: () => !running,
    clearQueue() {
      events.push("clear");
      return queue.splice(0);
    },
    queuedPrompts: () => [...queue],
    abortCompaction() { events.push("abort-compaction"); },
    abortBranchSummary() { events.push("abort-branch-summary"); },
    async abort() {
      aborts += 1;
      events.push("abort-agent");
    },
    ...overrides,
  };
  const coordinator = new ChildPromptCoordinator(port, {
    onAnnouncementDelivered(announcement) {
      events.push(`delivered:${announcement.parentHeadId}`);
    },
    onAnnouncementDiscarded(announcement) {
      discarded.push(announcement.parentHeadId);
    },
    onQueueChange() { queueChanges += 1; },
  });
  return {
    coordinator,
    events,
    discarded,
    queue,
    aborts: () => aborts,
    queueChanges: () => queueChanges,
    holdRuns(gate: Promise<void>) { runGate = gate; },
  };
}

const announcement = (parentHeadId: string): ParentUpdateAnnouncement => ({
  parentHeadId,
  completedIds: [parentHeadId],
});

test("a prompt submitted while the child runs joins that run instead of waiting for it to end", async () => {
  const gate = deferred();
  const harness = coordinatorHarness();
  harness.holdRuns(gate.promise);

  const first = harness.coordinator.prompt("first");
  await tick();
  const second = harness.coordinator.prompt("second");
  const third = harness.coordinator.prompt("third", "followUp");
  await second;
  await third;

  assert.deepEqual(harness.events, [
    "preflight:first",
    "run:first",
    "preflight:second",
    "queued-steer:second",
    "preflight:third",
    "queued-followUp:third",
  ], "steer and follow-up reach the session while the first run is still going");
  assert.deepEqual(harness.coordinator.queued(), [
    { text: "second", mode: "steer" },
    { text: "third", mode: "followUp" },
  ]);
  assert.ok(harness.queueChanges() > 0, "the pane is told the queue moved");

  gate.resolve();
  await first;
  assert.equal(harness.events.at(-1), "run-end:first");
});

test("only preflight is serialized: a prompt waits for the previous admission, not its run", async () => {
  const preflight = deferred();
  const runGate = deferred();
  let running = false;
  const calls: string[] = [];
  const { coordinator } = coordinatorHarness({
    async prompt(text, _mode, onAdmitted) {
      calls.push(`preflight:${text}`);
      if (text === "first") {
        await preflight.promise;
        running = true;
        onAdmitted();
        await runGate.promise;
        running = false;
        return;
      }
      calls.push(running ? `queued:${text}` : `run:${text}`);
      onAdmitted();
    },
    isIdle: () => !running,
  });

  const first = coordinator.prompt("first");
  const second = coordinator.prompt("second");
  await tick();
  assert.deepEqual(calls, ["preflight:first"], "the second prompt is held while the first is in preflight");
  assert.deepEqual(coordinator.queued(), [{ text: "second", mode: "steer" }]);

  preflight.resolve();
  await second;
  assert.deepEqual(calls, ["preflight:first", "preflight:second", "queued:second"]);
  runGate.resolve();
  await first;
});

test("dequeue takes back prompts the session has queued and leaves the run going", async () => {
  const gate = deferred();
  const harness = coordinatorHarness();
  harness.holdRuns(gate.promise);
  const first = harness.coordinator.prompt("first");
  await tick();
  await harness.coordinator.prompt("queued in session", "followUp");

  assert.deepEqual(harness.coordinator.dequeue(), [{ text: "queued in session", mode: "followUp" }]);
  assert.deepEqual(harness.queue, []);
  assert.deepEqual(harness.coordinator.queued(), []);
  assert.ok(!harness.events.includes("abort-agent"));
  gate.resolve();
  await first;
});

test("dequeue also returns prompts still waiting for admission and settles them", async () => {
  const preflight = deferred();
  const { coordinator } = coordinatorHarness({
    async prompt(_text, _mode, onAdmitted) {
      await preflight.promise;
      onAdmitted();
    },
  });
  const first = coordinator.prompt("in preflight");
  const held = coordinator.prompt("held", "followUp");
  await tick();
  assert.deepEqual(coordinator.dequeue(), [{ text: "held", mode: "followUp" }]);
  await held;
  preflight.resolve();
  await first;
});

test("a parent-update notice never enters a running child alone; it rides in with the next prompt", async () => {
  const gate = deferred();
  const harness = coordinatorHarness();
  harness.holdRuns(gate.promise);

  await harness.coordinator.enqueueAnnouncement(announcement("head-1"));
  assert.deepEqual(harness.events, ["announcement:head-1", "delivered:head-1"], "idle: appended at once");

  const first = harness.coordinator.prompt("first");
  await tick();
  await harness.coordinator.enqueueAnnouncement(announcement("head-2"));
  assert.ok(!harness.events.some((event) => event.includes("head-2")), "held while the child runs");

  await harness.coordinator.prompt("later", "followUp");
  assert.deepEqual(harness.events.slice(-4), [
    "announcement-followUp:head-2",
    "delivered:head-2",
    "preflight:later",
    "queued-followUp:later",
  ], "the notice joins the run just ahead of the prompt, under the same mode");

  await harness.coordinator.enqueueAnnouncement(announcement("head-3"));
  gate.resolve();
  await first;
  assert.deepEqual(harness.events.slice(-2), ["announcement:head-3", "delivered:head-3"], "the rest land once the run ends");
});

test("abort during an in-flight prompt's async preflight aborts its late agent_start", async () => {
  const preflightStarted = deferred();
  const releasePreflight = deferred();
  let modelCalls = 0;
  let agentAbortedAtStart = false;
  let coordinator!: ChildPromptCoordinator;
  let abortsAtStart = 0;
  const harness = coordinatorHarness({
    async prompt(_text, _mode, onAdmitted) {
      preflightStarted.resolve();
      await releasePreflight.promise;
      onAdmitted();
      // The session emits agent_start synchronously before model work.
      abortsAtStart = harness.aborts();
      coordinator.onAgentStart();
      await tick();
      agentAbortedAtStart = harness.aborts() > abortsAtStart;
      if (!agentAbortedAtStart) modelCalls += 1;
    },
  });
  coordinator = harness.coordinator;

  const prompt = coordinator.prompt("delayed input");
  await preflightStarted.promise;
  const aborting = coordinator.abort();
  releasePreflight.resolve();
  await Promise.all([prompt, aborting]);

  assert.equal(agentAbortedAtStart, true, "abort stays armed until the in-flight prompt settles");
  assert.equal(modelCalls, 0);
  assert.deepEqual(harness.events.slice(0, 4), [
    "clear",
    "abort-compaction",
    "abort-branch-summary",
    "abort-agent",
  ]);
});

test("prompts still held behind a prompt in preflight never reach the session after abort", async () => {
  const preflight = deferred();
  const reached: string[] = [];
  const { coordinator } = coordinatorHarness({
    async prompt(text, _mode, onAdmitted) {
      reached.push(text);
      await preflight.promise;
      onAdmitted();
    },
  });
  const first = coordinator.prompt("first");
  const second = coordinator.prompt("second");
  await tick();
  const aborting = coordinator.abort();
  preflight.resolve();
  await Promise.all([first, second, aborting]);
  assert.deepEqual(reached, ["first"]);
});

test("close discards announcements, rejects new prompts, and aborts a late agent_start", async () => {
  const { coordinator, discarded, aborts } = coordinatorHarness({ isIdle: () => false });
  await coordinator.enqueueAnnouncement(announcement("head-late"));

  const closing = coordinator.close();
  coordinator.onAgentStart();
  await closing;

  assert.deepEqual(discarded, ["head-late"]);
  assert.ok(aborts() >= 2, "close and a late agent_start both request immediate abort");
  await assert.rejects(coordinator.prompt("too late"), /closing/);
});
