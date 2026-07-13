import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, VERSION, type PromptOptions } from "@earendil-works/pi-coding-agent";
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
    async prompt(text, options) {
      events.push(`preflight:${text}`);
      options.preflightResult(true);
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

test("installed Pi 0.80.6 exposes and invokes preflightResult before model work", () => {
  let accepted: boolean | undefined;
  const options = {
    preflightResult(success: boolean) { accepted = success; },
  } satisfies PromptOptions;
  options.preflightResult(true);
  assert.equal(accepted, true, "the installed declaration accepts the hook used by the coordinator");
  assert.equal(VERSION, "0.80.6");

  const promptRuntime = AgentSession.prototype.prompt.toString();
  assert.match(promptRuntime, /preflightResult/);
  const finalAcceptedPreflight = promptRuntime.lastIndexOf("preflightResult?.(true)");
  const modelWork = promptRuntime.indexOf("_runAgentPrompt", finalAcceptedPreflight);
  assert.notEqual(finalAcceptedPreflight, -1, "the installed runtime has a final accepted-prompt callback");
  assert.notEqual(modelWork, -1, "the accepted prompt proceeds to model work");
  assert.ok(
    finalAcceptedPreflight < modelWork,
    "the final accepted-prompt callback runs before its model work",
  );
  assert.match(promptRuntime, /preflightResult\?\.\(false\)/);
});

test("coordinator owns announcement flush and serialized prompt order", async () => {
  const gate = deferred();
  const { coordinator, events } = coordinatorHarness({
    isIdle: () => false,
    async prompt(text, options) {
      events.push(`preflight:${text}`);
      options.preflightResult(true);
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

test("abort during async preflight rejects late admission before agent/model work", async () => {
  const preflightStarted = deferred();
  const releasePreflight = deferred();
  let modelCalls = 0;
  const { coordinator, events, aborts } = coordinatorHarness({
    async prompt(_text, options) {
      preflightStarted.resolve();
      await releasePreflight.promise;
      options.preflightResult(true);
      modelCalls += 1;
    },
  });

  const prompt = coordinator.prompt("delayed input");
  await preflightStarted.promise;
  const aborting = coordinator.abort();
  releasePreflight.resolve();
  await Promise.all([prompt, aborting]);

  assert.equal(modelCalls, 0);
  assert.ok(aborts() >= 1);
  assert.deepEqual(events.slice(0, 4), [
    "clear",
    "abort-compaction",
    "abort-branch-summary",
    "abort-agent",
  ]);
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
