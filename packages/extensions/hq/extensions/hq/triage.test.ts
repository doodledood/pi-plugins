import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
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
import {
  applyTriageOutcome,
  MAX_RESPAWNS,
  sweepStops,
  triageContext,
  type TriageOutcome,
} from "./triage.ts";
import { createSpawner, MANAGED_ENV, type Spawner, type SpawnRequest } from "./spawn.ts";

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
    const citation = doctrine.rules.find((rule) => rule.decides)?.citation ?? "";
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
    const citation = doctrine.rules.find((rule) => rule.decides)?.citation ?? "";

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
    const citation = doctrine.rules.find((rule) => rule.decides)?.citation ?? "";

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

test("citing a line that only shapes a decision is citing nothing", async () => {
  const h = await harness("hq-triage-shaping");
  try {
    await graduateDomain(h.store, "ci-flake", "2026-07-20T00:00:00.000Z");
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    // A taste, or an escalation rule: parsed, citable, and unable to decide a case.
    const shaping = doctrine.rules.find((rule) => !rule.decides);
    assert.ok(shaping, "the seed carries shaping lines");

    const result = await applyTriageOutcome(
      { store: h.store, spawner: h.spawner, now: h.now },
      h.stop.stopId,
      {
        kind: "continue",
        domain: "ci-flake",
        citation: shaping.citation,
        instruction: "retry the suite once",
        summary: "retry a flaky suite",
        blastRadius: "low",
        reversibility: "reversible",
      },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.applied, "packet");
    assert.equal(result.escalationReason, "not-covered-by-doctrine");
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

test("a doctrine answer with nowhere to carry it reaches the user instead", async () => {
  const h = await harness("hq-triage-ephemeral", { sessionFile: null });
  try {
    await graduateDomain(h.store, "ci-flake", "2026-07-20T00:00:00.000Z");
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const citation = doctrine.rules.find((rule) => rule.decides)?.citation ?? "";

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

    assert.equal(result.applied, "packet", "the decision is not silently swallowed");
    assert.equal(result.escalationReason, "no-session-file");
    assert.deepEqual(await h.store.readAuditLines(), [], "and nothing claims it was answered");
    assert.equal(h.calls.filter((call) => call.kind === "continuation").length, 0);
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

/** Every file under a directory, with its bytes hashed, for a byte-identical check. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const snapshot: Record<string, string> = {};
  for (const entry of entries) {
    const full = join(entry.parentPath ?? dir, entry.name);
    if (!entry.isFile()) continue;
    snapshot[relative(dir, full)] = createHash("sha256")
      .update(await readFile(full))
      .digest("hex");
  }
  return snapshot;
}

/**
 * The claim HQ rests on: triage classifies and records, and the only thing it can
 * reach outward is a pi session (INV-G9). No outcome — not even one whose
 * instruction names a push — can perform an externally visible or irreversible
 * action itself, and no outcome touches the project directory.
 */
test("no triage outcome can act on the world itself: every effect is a pi session or a write inside the state root", async () => {
  const h = await harness("hq-triage-no-actuation");
  const workspace = await makeRoot("hq-triage-workspace");
  try {
    await writeFile(join(workspace, "tracked.txt"), "untouched\n", "utf8");
    const before = await snapshotTree(workspace);

    const spawned: Array<{ bin: string; argv: readonly string[]; options: Record<string, unknown> }> = [];
    const spawner = createSpawner({
      root: h.root,
      env: { PATH: "/usr/bin" },
      spawnImpl: ((bin: string, argv: readonly string[], options: Record<string, unknown>) => {
        spawned.push({ bin, argv, options });
        return { pid: 4242, unref() {}, once() {} };
      }) as never,
    });

    await graduateDomain(h.store, "release-chores", "2026-07-20T00:00:00.000Z");
    const citation = (await loadDoctrine(h.root, workspace)).rules.find((rule) => rule.decides)
      ?.citation ?? "";
    const deps = { store: h.store, spawner, now: h.now };

    // One stop per outcome kind, all rooted in the real project directory.
    const outcomes: Array<{ id: string; outcome: TriageOutcome }> = [
      { id: "stop-packet", outcome: { kind: "packet", packet: triageDraftFixture() } },
      {
        id: "stop-continue",
        outcome: {
          kind: "continue",
          domain: "release-chores",
          citation,
          // Deliberately an externally visible act: HQ may carry it, never do it.
          instruction: "run git push --force and publish the package",
          summary: "push and publish",
          blastRadius: "low",
          reversibility: "reversible",
        },
      },
      {
        id: "stop-close",
        outcome: { kind: "close", domain: "release-chores", summary: "nothing left to do", citation },
      },
      {
        id: "stop-respawn",
        outcome: {
          kind: "respawn",
          domain: "release-chores",
          reason: "the build died",
          instruction: "delete the stale release tag and deploy again",
        },
      },
    ];

    for (const { id, outcome } of outcomes) {
      await ensureStopRecord(h.root, { ...h.stop, stopId: id, project: workspace });
      const result = await applyTriageOutcome(deps, id, outcome);
      assert.equal("error" in result, false, `${id} applied`);
    }

    assert.ok(spawned.length > 0, "outcomes did reach the spawner, so the assertions below mean something");
    for (const call of spawned) {
      assert.equal(call.bin, "pi", "the only program HQ starts is pi");
      const argv = [...call.argv];
      const printIndex = argv.indexOf("--print");
      assert.ok(printIndex >= 0, "every child is a pi session in print mode");
      assert.equal(printIndex, argv.length - 2, "the prompt is the final argument");
      // Anything actuating appears only inside the prompt text, never as argv.
      const flags = argv.slice(0, printIndex);
      for (const flag of flags) {
        assert.match(
          flag,
          /^(--session|--fork|--model|--name|--tools|-e|\/|[^-].*)$/,
          `unexpected argument to pi: ${flag}`,
        );
        assert.doesNotMatch(flag, /(^|\s)(git|gh|npm|curl|ssh|rm)(\s|$)|[;&|`$]/, `shell-shaped argument: ${flag}`);
      }
      assert.equal((call.options.env as NodeJS.ProcessEnv)[MANAGED_ENV], "1", "the child is itself supervised");
      assert.equal(call.options.cwd, workspace);
    }

    // The instruction that named a push was carried as a prompt for the worker to
    // weigh inside its own permission envelope, and nothing else.
    const carried = spawned.filter((call) => call.argv.at(-1)?.includes("git push --force"));
    assert.equal(carried.length, 1, "the ruling was carried once, as text");

    assert.deepEqual(await snapshotTree(workspace), before, "the project directory is byte-identical");
    for (const record of await h.store.readAuditLines()) {
      assert.ok(record.at.length > 0, "records are the only durable effect, and they live under the root");
    }
  } finally {
    await dropRoot(workspace);
    await dropRoot(h.root);
  }
});
