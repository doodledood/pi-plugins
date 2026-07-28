import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  readDrillLog,
  startCompletionDrill,
  startDrill,
  submitDrillResult,
  type DrillDeps,
} from "./drills.ts";
import { seedDoctrine } from "./doctrine.ts";
import {
  dropRoot,
  fixedClock,
  makeRoot,
  makeStore,
  packetDraftFixture,
  recordingSpawner,
  sessionStateFixture,
  writeSessionFile,
} from "./testing.ts";
import type { SpawnRequest } from "./spawn.ts";
import type { Packet } from "./types.ts";

interface Harness {
  root: string;
  deps: DrillDeps;
  calls: SpawnRequest[];
  packet: Packet;
  sessionFile: string;
}

async function harness(label: string, overrides: Partial<Packet> = {}): Promise<Harness> {
  const root = await makeRoot(label);
  const now = fixedClock();
  const store = makeStore(root, now);
  await store.ensure();
  await seedDoctrine(root);
  const { spawner, calls } = recordingSpawner();

  const sessionFile = `${root}/sess-a.jsonl`;
  await writeSessionFile(sessionFile, [
    { role: "user", text: "run the integration suite" },
    { role: "assistant", text: "The failure was in parser.spec.ts, line 42, a timeout." },
  ]);
  await store.publishSessionState(sessionStateFixture({ sessionFile }));

  const { packet } = await store.createPacket({
    ...packetDraftFixture({ sourceSessionFile: sessionFile }),
    ...overrides,
  } as never);

  return { root, deps: { store, spawner, now }, calls, packet, sessionFile };
}

test("a drill starts by reading, and the origin session is the row that shows it", async () => {
  const h = await harness("hq-drill-start");
  try {
    const started = await startDrill(h.deps, h.packet, "which test failed?");
    assert.equal(started.spawnedSessionId, "run-1");

    const drill = h.calls[0];
    assert.equal(drill?.kind, "drill");
    assert.equal(drill?.forkSessionFile, undefined, "tier 1 opens no copy");
    assert.equal(drill?.env?.HQ_DRILL_TIER, "1");
    assert.equal(drill?.originSessionId, h.packet.sourceSessionId);

    const state = await h.deps.store.readSessionState(h.packet.sourceSessionId);
    assert.equal(state?.drillingPacketId, h.packet.id);
    assert.equal(state?.state, "drilling");

    const log = await readDrillLog(h.deps.store);
    assert.deepEqual(log.map((entry) => entry.action), ["read"]);
  } finally {
    await dropRoot(h.root);
  }
});

test("a question answered by reading never resurrects the session", async () => {
  const h = await harness("hq-drill-tier1");
  try {
    await startDrill(h.deps, h.packet, "which test failed?");
    const outcome = await submitDrillResult(h.deps, {
      packetId: h.packet.id,
      question: "which test failed?",
      tier: 1,
      answer: "parser.spec.ts timed out at line 42.",
      quotes: [
        { text: "The failure was in parser.spec.ts, line 42, a timeout.", attribution: "sess-a" },
      ],
    });
    assert.equal("error" in outcome, false);
    if ("error" in outcome) return;
    assert.equal(outcome.kind, "annotated");

    assert.equal(
      h.calls.some((call) => call.forkSessionFile),
      false,
      "no fork was opened for a question reading could answer",
    );
    const log = await readDrillLog(h.deps.store);
    assert.equal(log.some((entry) => entry.action === "fork"), false);
    assert.deepEqual(log.map((entry) => entry.action), ["read", "answered"]);
  } finally {
    await dropRoot(h.root);
  }
});

test("a question reading cannot answer escalates to a copy of the session", async () => {
  const h = await harness("hq-drill-tier2");
  try {
    const before = createHash("sha256").update(await readFile(h.sessionFile)).digest("hex");
    await startDrill(h.deps, h.packet, "why did you choose to retry rather than investigate?");

    const escalated = await submitDrillResult(h.deps, {
      packetId: h.packet.id,
      question: "why did you choose to retry rather than investigate?",
      tier: 1,
      answer: "The transcript does not say why.",
      quotes: [],
      insufficient: true,
    });
    assert.equal("error" in escalated, false);
    if ("error" in escalated) return;
    assert.equal(escalated.kind, "escalated");

    const fork = h.calls.find((call) => call.forkSessionFile);
    assert.equal(fork?.forkSessionFile, h.sessionFile);
    assert.equal(fork?.env?.HQ_DRILL_TIER, "2");
    assert.match(fork?.prompt ?? "", /Quote the exact text/);

    // The copy is the thing that gets asked; the original is untouched.
    const after = createHash("sha256").update(await readFile(h.sessionFile)).digest("hex");
    assert.equal(after, before);

    // The packet is still drilling until the copy answers.
    assert.equal((await h.deps.store.readPacket(h.packet.id))?.status, "drilling");

    const answered = await submitDrillResult(h.deps, {
      packetId: h.packet.id,
      question: "why did you choose to retry rather than investigate?",
      tier: 2,
      answer: "It retried because the same test had passed on the previous run.",
      quotes: [{ text: "it passed last run", attribution: "sess-a (copy)" }],
    });
    assert.equal("error" in answered, false);
    if ("error" in answered) return;
    assert.equal(answered.kind, "annotated");

    const packet = await h.deps.store.readPacket(h.packet.id);
    assert.equal(packet?.status, "pending");
    assert.equal(packet?.annotations.length, 1);
    assert.equal(packet?.annotations[0]?.tier, 2);
    assert.equal(packet?.annotations[0]?.quotes.length, 1);
    assert.equal((await h.deps.store.readSessionState("sess-a"))?.drillingPacketId, null);
  } finally {
    await dropRoot(h.root);
  }
});

test("an ephemeral source cannot be resurrected, and the gap is returned honestly", async () => {
  const h = await harness("hq-drill-ephemeral", { sourceSessionFile: null });
  try {
    const outcome = await submitDrillResult(h.deps, {
      packetId: h.packet.id,
      question: "why?",
      tier: 1,
      answer: "The transcript does not say.",
      quotes: [],
      insufficient: true,
    });
    assert.equal("error" in outcome, false);
    if ("error" in outcome) return;
    assert.equal(outcome.kind, "unanswered");
    const packet = await h.deps.store.readPacket(h.packet.id);
    assert.match(packet?.annotations[0]?.answer ?? "", /could not be asked directly/);
    assert.equal(h.calls.some((call) => call.forkSessionFile), false);
  } finally {
    await dropRoot(h.root);
  }
});

test("a completion drill fills a held packet's gaps and the packet becomes presentable", async () => {
  const h = await harness("hq-drill-complete", { flipCondition: "TBD" });
  try {
    assert.equal(h.packet.status, "held");
    await startCompletionDrill(h.deps, h.packet, [
      { field: "flipCondition", reason: "no stated evidence that would change the recommendation" },
    ]);
    const question = h.calls[0]?.env?.HQ_DRILL_QUESTION ?? "";
    assert.match(question, /flipCondition/);

    const outcome = await submitDrillResult(h.deps, {
      packetId: h.packet.id,
      question,
      tier: 1,
      answer: "Filled the flip condition from the log.",
      quotes: [{ text: "a timeout", attribution: "sess-a" }],
      patch: { flipCondition: "if the same test failed on the previous run it is not flaky" },
    });
    assert.equal("error" in outcome, false);
    if ("error" in outcome) return;

    const packet = await h.deps.store.readPacket(h.packet.id);
    assert.equal(packet?.status, "pending");
    assert.deepEqual((await h.deps.store.listPresentable()).map((p) => p.id), [h.packet.id]);
  } finally {
    await dropRoot(h.root);
  }
});

test("a drill on a packet that has gone is refused", async () => {
  const h = await harness("hq-drill-missing");
  try {
    const outcome = await submitDrillResult(h.deps, {
      packetId: "pkt-gone",
      question: "?",
      tier: 1,
      answer: "x",
      quotes: [],
    });
    assert.deepEqual(outcome, { error: "no such packet: pkt-gone" });
  } finally {
    await dropRoot(h.root);
  }
});
