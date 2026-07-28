import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { loadDoctrine, seedDoctrine } from "./doctrine.ts";
import { graduateDomain } from "./graduation.ts";
import { hqPaths } from "./paths.ts";
import {
  dropRoot,
  fixedClock,
  makeRoot,
  makeStore,
  recordingSpawner,
  triageDraftFixture,
  writeSessionFile,
} from "./testing.ts";
import { ensureStopRecord, readStopRecord, type StopRecord } from "./stops.ts";
import { HqStore } from "./store.ts";
import { applyTriageOutcome, MAX_RESPAWNS, sweepStops, triageContext } from "./triage.ts";
import type { Spawner, SpawnRequest } from "./spawn.ts";

interface Harness {
  root: string;
  store: HqStore;
  spawner: Spawner;
  calls: SpawnRequest[];
  stop: StopRecord;
  now: () => Date;
}

async function harness(label: string, overrides: Partial<StopRecord> = {}): Promise<Harness> {
  const root = await makeRoot(label);
  const now = fixedClock();
  const store = makeStore(root, now);
  await store.ensure();
  await seedDoctrine(root);
  const { spawner, calls } = recordingSpawner();

  const sessionFile = `${root}/sess-a.jsonl`;
  await writeSessionFile(sessionFile, [
    { role: "user", text: "run the integration suite" },
    { role: "assistant", text: "It failed on the known flaky test. Retry, or investigate?" },
  ]);

  const stop: StopRecord = {
    version: 1,
    stopId: "sess-a--leaf1",
    sessionId: "sess-a",
    sessionFile,
    project: "/work/alpha",
    kind: "worker",
    stopState: "stopped-with-question",
    preview: "Retry, or investigate?",
    createdAt: "2026-07-28T12:00:00.000Z",
    status: "claimed",
    claimedByPid: process.pid,
    claimedAt: "2026-07-28T12:00:01.000Z",
    outcome: null,
    packetId: null,
    ...overrides,
  };
  await ensureStopRecord(root, stop);
  return { root, store, spawner, calls, stop, now };
}

test("triage context carries the stop, the doctrine, and the transcript tail", async () => {
  const h = await harness("hq-triage-context");
  try {
    const context = await triageContext({ store: h.store, spawner: h.spawner, now: h.now }, h.stop.stopId);
    assert.equal("error" in context, false);
    if ("error" in context) return;
    assert.equal(context.stop.stopId, h.stop.stopId);
    assert.match(context.transcript, /known flaky test/);
    assert.match(context.doctrine, /Doors/);
    assert.deepEqual(context.graduatedDomains, []);
  } finally {
    await dropRoot(h.root);
  }
});

test("a packet outcome queues the packet and finishes the stop", async () => {
  const h = await harness("hq-triage-packet");
  try {
    const result = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now },
      h.stop.stopId,
      { kind: "packet", packet: triageDraftFixture() },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.applied, "packet");
    assert.ok(result.packetId);

    const stored = await readStopRecord(h.root, h.stop.stopId);
    assert.equal(stored?.status, "done");
    assert.equal(stored?.packetId, result.packetId);
    assert.deepEqual((await h.store.listPresentable()).map((p) => p.id), [result.packetId]);

    // A second outcome for the same stop is refused.
    const again = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now },
      h.stop.stopId,
      { kind: "packet", packet: triageDraftFixture() },
    );
    assert.equal("error" in again, true);
  } finally {
    await dropRoot(h.root);
  }
});

test("a packet that misses the bar is held and drilled instead of shown", async () => {
  const h = await harness("hq-triage-held");
  try {
    const result = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now },
      h.stop.stopId,
      { kind: "packet", packet: triageDraftFixture({ flipCondition: "TBD" }) },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.match(result.note, /held and drilled/);
    assert.deepEqual(await h.store.listPresentable(), []);
    const drills = h.calls.filter((call) => call.kind === "drill");
    assert.equal(drills.length, 1);
    assert.match(drills[0]?.env?.HQ_DRILL_QUESTION ?? "", /misses the bar/);
  } finally {
    await dropRoot(h.root);
  }
});

test("a continue in an ungraduated domain becomes a packet, and says why", async () => {
  const h = await harness("hq-triage-ungraduated");
  try {
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const citation = doctrine.rules[0]?.citation ?? "";
    const result = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now },
      h.stop.stopId,
      {
        kind: "continue",
        domain: "ci-flake",
        citation,
        instruction: "retry the suite once",
        summary: "retry a flaky suite",
        blastRadius: "low",
        reversibility: "reversible",
      },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.applied, "packet");
    assert.equal(result.escalationReason, "domain-not-graduated");
    assert.deepEqual(await h.store.readAuditLines(), []);
    assert.equal(h.calls.filter((call) => call.kind === "continuation").length, 0);

    const packet = await h.store.readPacket(result.packetId ?? "");
    assert.equal(packet?.shadowRuling?.optionId, "as-proposed");
    assert.deepEqual(packet?.doctrineCitations, [citation]);
  } finally {
    await dropRoot(h.root);
  }
});

test("a graduated, covered, reversible continue is answered from doctrine and audited", async () => {
  const h = await harness("hq-triage-graduated");
  try {
    await graduateDomain(h.store, "ci-flake", "2026-07-20T00:00:00.000Z");
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const citation = doctrine.rules[0]?.citation ?? "";

    const result = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now, random: () => 0.01 },
      h.stop.stopId,
      {
        kind: "continue",
        domain: "ci-flake",
        citation,
        instruction: "retry the suite once",
        summary: "retry a flaky suite",
        blastRadius: "low",
        reversibility: "reversible",
      },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.applied, "continue");
    assert.equal(result.packetId, null);
    assert.deepEqual(await h.store.listPresentable(), [], "nothing reached the queue");

    const audit = await h.store.readAuditLines();
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.domain, "ci-flake");
    assert.equal(audit[0]?.ruleCitation, citation);
    assert.equal(audit[0]?.sampledForReview, true);

    const continuation = h.calls.filter((call) => call.kind === "continuation");
    assert.equal(continuation.length, 1);
    assert.equal(continuation[0]?.resumeSessionFile, h.stop.sessionFile);
    assert.equal((await readStopRecord(h.root, h.stop.stopId))?.outcome, "continue");
  } finally {
    await dropRoot(h.root);
  }
});

test("a one-way decision still reaches the user inside a graduated domain", async () => {
  const h = await harness("hq-triage-ceiling");
  try {
    await graduateDomain(h.store, "release", "2026-07-20T00:00:00.000Z");
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const citation = doctrine.rules[0]?.citation ?? "";

    const result = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now },
      h.stop.stopId,
      {
        kind: "continue",
        domain: "release",
        citation,
        instruction: "merge and publish the release",
        summary: "publish a release",
        blastRadius: "high",
        reversibility: "one-way",
      },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.applied, "packet");
    assert.equal(
      result.escalationReason,
      "blast-reversibility-ceiling",
      "the recorded reason is the ceiling, not missing coverage",
    );
    assert.equal(h.calls.filter((call) => call.kind === "continuation").length, 0);
    assert.deepEqual(await h.store.readAuditLines(), []);
  } finally {
    await dropRoot(h.root);
  }
});

test("a continue citing a rule that is not in the file is treated as uncovered", async () => {
  const h = await harness("hq-triage-uncited");
  try {
    await graduateDomain(h.store, "ci-flake", "2026-07-20T00:00:00.000Z");
    const result = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now },
      h.stop.stopId,
      {
        kind: "continue",
        domain: "ci-flake",
        citation: "global.md § Invented L999",
        instruction: "retry the suite once",
        summary: "retry a flaky suite",
        blastRadius: "low",
        reversibility: "reversible",
      },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.escalationReason, "not-covered-by-doctrine");
  } finally {
    await dropRoot(h.root);
  }
});

test("finished work the user has not seen arrives as a close packet", async () => {
  const h = await harness("hq-triage-close");
  try {
    const result = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now },
      h.stop.stopId,
      {
        kind: "close",
        domain: "routine-fix",
        summary: "fixed the failing parser test and pushed nothing",
        unverified: "the slow integration suite was not run",
      },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.applied, "packet");
    const packet = await h.store.readPacket(result.packetId ?? "");
    assert.match(packet?.title ?? "", /^finished:/);
    assert.deepEqual(packet?.options.map((option) => option.id), ["accept", "follow-up"]);
    assert.match(packet?.options[0]?.price ?? "", /unverified/);
  } finally {
    await dropRoot(h.root);
  }
});

test("a respawn restarts the work, but a session that keeps dying becomes a packet", async () => {
  const h = await harness("hq-triage-respawn");
  try {
    const deps = { store: h.store, spawner: h.spawner, now: h.now };
    for (let attempt = 1; attempt <= MAX_RESPAWNS; attempt += 1) {
      await ensureStopRecord(h.root, { ...h.stop, stopId: `sess-a--r${attempt}` });
      const result = await applyTriageOutcome(deps, `sess-a--r${attempt}`, {
        kind: "respawn",
        domain: "stalled",
        reason: "the build died half way",
        instruction: "run the build again",
      });
      assert.equal("error" in result, false);
      if ("error" in result) return;
      assert.equal(result.applied, "respawn");
    }
    assert.equal(h.calls.filter((call) => call.kind === "continuation").length, MAX_RESPAWNS);

    await ensureStopRecord(h.root, { ...h.stop, stopId: "sess-a--r3" });
    const limited = await applyTriageOutcome(deps, "sess-a--r3", {
      kind: "respawn",
      domain: "stalled",
      reason: "the build died half way again",
      instruction: "run the build again",
    });
    assert.equal("error" in limited, false);
    if ("error" in limited) return;
    assert.equal(limited.applied, "packet");
    assert.equal(limited.escalationReason, "respawn-limit");
    const packet = await h.store.readPacket(limited.packetId ?? "");
    assert.match(packet?.title ?? "", /^stuck:/);
    assert.equal(packet?.recommendationId, "abandon");
  } finally {
    await dropRoot(h.root);
  }
});

test("the sweep re-triages a stop whose triage never finished", async () => {
  const h = await harness("hq-triage-sweep", { status: "open", claimedByPid: null, claimedAt: null });
  try {
    const swept = await sweepStops({ store: h.store, spawner: h.spawner, now: h.now });
    assert.deepEqual(swept.retried, [h.stop.stopId]);
    const triage = h.calls.filter((call) => call.kind === "triage");
    assert.equal(triage.length, 1);
    assert.equal(triage[0]?.env?.HQ_STOP_ID, h.stop.stopId);

    // Once claimed by a live process, the sweep leaves it alone.
    const second = await sweepStops({ store: h.store, spawner: h.spawner, now: h.now });
    assert.deepEqual(second.retried, []);
  } finally {
    await dropRoot(h.root);
  }
});

test("the stops directory stays inside the state root", async () => {
  const h = await harness("hq-triage-paths");
  try {
    assert.equal(hqPaths(h.root).stops.startsWith(h.root), true);
    await writeFile(`${h.root}/marker`, "x", "utf8");
  } finally {
    await dropRoot(h.root);
  }
});
