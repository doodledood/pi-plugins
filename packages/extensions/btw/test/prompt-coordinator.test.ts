import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildPromptCoordinator,
  type ChildPromptSessionPort,
  type ParentUpdateAnnouncement,
} from "../src/prompt-coordinator.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function coordinatorHarness(overrides: Partial<ChildPromptSessionPort> = {}) {
  const events: string[] = [];
  const discarded: string[] = [];
  let aborts = 0;
  const port: ChildPromptSessionPort = {
    async prompt(text) {
      events.push(`preflight:${text}`);
      events.push(`agent:${text}`);
    },
    async appendAnnouncement(announcement) {
      events.push(`announcement:${announcement.parentHeadId}`);
    },
    isIdle: () => true,
    clearQueue() { events.push("clear"); },
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
  });
  return { coordinator, events, discarded, aborts: () => aborts };
}

const announcement = (parentHeadId: string): ParentUpdateAnnouncement => ({
  parentHeadId,
  completedIds: [parentHeadId],
});

test("coordinator owns announcement flush and serialized prompt order", async () => {
  const gate = deferred();
  const { coordinator, events } = coordinatorHarness({
    isIdle: () => false,
    async prompt(text) {
      events.push(`preflight:${text}`);
      events.push(`agent:${text}`);
      if (text === "first") await gate.promise;
    },
  });

  await coordinator.enqueueAnnouncement(announcement("head-1"));
  const first = coordinator.prompt("first");
  const second = coordinator.prompt("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    "announcement:head-1",
    "delivered:head-1",
    "preflight:first",
    "agent:first",
  ]);

  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events.slice(-4), [
    "preflight:first",
    "agent:first",
    "preflight:second",
    "agent:second",
  ]);
});

test("abort during an in-flight prompt's async preflight aborts its late agent_start", async () => {
  const preflightStarted = deferred();
  const releasePreflight = deferred();
  let modelCalls = 0;
  let agentAbortedAtStart = false;
  let coordinator!: ChildPromptCoordinator;
  let abortsAtStart = 0;
  const harness = coordinatorHarness({
    async prompt() {
      preflightStarted.resolve();
      await releasePreflight.promise;
      // The session emits agent_start synchronously before model work.
      abortsAtStart = harness.aborts();
      coordinator.onAgentStart();
      await new Promise((resolve) => setImmediate(resolve));
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

test("prompts still queued behind an aborted prompt never reach the session", async () => {
  const gate = deferred();
  const { coordinator, events } = coordinatorHarness({
    async prompt(text) {
      events.push(`agent:${text}`);
      if (text === "first") await gate.promise;
    },
  });
  const first = coordinator.prompt("first");
  const second = coordinator.prompt("second");
  await new Promise((resolve) => setImmediate(resolve));
  const aborting = coordinator.abort();
  gate.resolve();
  await Promise.all([first, second, aborting]);
  assert.deepEqual(events.filter((event) => event.startsWith("agent:")), ["agent:first"]);
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
