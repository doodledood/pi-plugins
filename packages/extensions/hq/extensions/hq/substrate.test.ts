import assert from "node:assert/strict";
import { appendFile, readdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  appendJsonl,
  atomicWriteJson,
  createWriteQueue,
  materializeIfAbsent,
  readJsonl,
  scanJsonDir,
  truncatePreview,
  withFileLock,
} from "./io.ts";
import { assertSafeId, hqPaths, projectSlug, resolveStateRoot } from "./paths.ts";
import { dropRoot, makeRoot, makeStore, packetDraftFixture, sessionStateFixture } from "./testing.ts";
import {
  packetBarViolations,
  parsePacket,
  parseRuling,
  parseSessionState,
  type Packet,
  ruleGeneralityViolations,
} from "./types.ts";

test("the state root resolves from HQ_HOME, then the pi dir, then the default", () => {
  assert.equal(resolveStateRoot({ HQ_HOME: "/tmp/explicit" }), "/tmp/explicit");
  assert.equal(
    resolveStateRoot({ PI_CODING_AGENT_DIR: "/home/someone/.pi/agent" }),
    "/home/someone/.pi/hq",
  );
  assert.match(resolveStateRoot({}), /\/\.pi\/hq$/);
});

test("a tilde in the pi directory is expanded, not resolved against the cwd", () => {
  // pi expands ~ itself; resolving it instead would give every project its own
  // literal "~" state root and split the one substrate the fleet shares.
  const root = resolveStateRoot({ PI_CODING_AGENT_DIR: "~/custom/agent" });
  assert.equal(root.startsWith("~"), false);
  assert.equal(root.includes("/~/"), false);
  assert.equal(root.endsWith("/custom/hq"), true);
  assert.equal(resolveStateRoot({ HQ_HOME: "~" }).includes("~"), false);
});

test("ids that would escape the state root are refused", () => {
  assert.throws(() => assertSafeId("../escape", "session id"));
  assert.throws(() => assertSafeId("a/b", "session id"));
  assert.throws(() => assertSafeId("", "session id"));
  assert.equal(assertSafeId("pkt-20260728-abc", "packet id"), "pkt-20260728-abc");
  assert.equal(projectSlug("/Users/someone/Projects/pi-plugins/"), "projects-pi-plugins");
});

test("whole-file writes are atomic and seeding never overwrites an edit", async () => {
  const root = await makeRoot("hq-io");
  try {
    const target = join(root, "nested", "value.json");
    await atomicWriteJson(target, { a: 1 });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { a: 1 });

    const seed = join(root, "doctrine.md");
    assert.equal(await materializeIfAbsent(seed, "original\n"), true);
    await writeFile(seed, "the user's edit\n", "utf8");
    assert.equal(await materializeIfAbsent(seed, "original\n"), false);
    assert.equal(await readFile(seed, "utf8"), "the user's edit\n");
  } finally {
    await dropRoot(root);
  }
});

test("a whole-file write replaces the file rather than editing it in place", async () => {
  const root = await makeRoot("hq-io-atomic");
  try {
    const target = join(root, "value.json");
    await atomicWriteJson(target, { a: 1 });
    const before = await stat(target);
    await atomicWriteJson(target, { a: 2 });
    const after = await stat(target);
    // A rename swaps in a new inode; an in-place rewrite would keep the old one,
    // which is what a concurrent reader could observe half-written.
    assert.notEqual(after.ino, before.ino);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), { a: 2 });
    const residue = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(residue, [], "no temp files are left behind");
  } finally {
    await dropRoot(root);
  }
});

test("an append-only log rejects a record it cannot trust instead of typing it as valid", async () => {
  const root = await makeRoot("hq-log-parse");
  try {
    const store = makeStore(root);
    await store.ensure();
    await store.appendAudit({
      at: "2026-07-28T12:00:00.000Z",
      sourceSessionId: "sess-a",
      domain: "ci-flake",
      project: "/work/alpha",
      ruleCitation: "global.md § Tastes L10",
      action: "continue",
      summary: "retried the suite",
      sampledForReview: true,
    });
    // A hand-edited or differently-versioned line: valid JSON, wrong shape.
    await appendFile(hqPaths(root).auditLog, `${JSON.stringify({ domain: "x" })}\n`, "utf8");
    await appendFile(hqPaths(root).defectsLog, `${JSON.stringify({ packetId: 42 })}\n`, "utf8");

    const audits = await store.readAuditLines();
    assert.equal(audits.length, 1, "the malformed line is absence, not a half-typed record");
    assert.equal(audits[0]?.domain, "ci-flake");
    assert.deepEqual(await store.readDefects(), []);

    // The seat's counters read the same logs and must not throw on them.
    assert.deepEqual(await store.countToday("2026-07-28"), { rulings: 0, audits: 1 });
  } finally {
    await dropRoot(root);
  }
});

test("today's count is per record, not per line, and stops at the day boundary", async () => {
  const root = await makeRoot("hq-count-today");
  try {
    const store = makeStore(root);
    await store.ensure();
    const paths = hqPaths(root);

    // Two appends of one ruling (record-before-route), one deferral, one ruling on
    // an earlier day, and one on a later day.
    const ruling = (id: string, at: string, form: string) =>
      `${JSON.stringify({ version: 1, id, at, form, packetId: "p" })}\n`;
    await appendFile(paths.rulingsLog, ruling("rul-old", "2026-07-27T10:00:00.000Z", "accept"), "utf8");
    await appendFile(paths.rulingsLog, ruling("rul-1", "2026-07-28T10:00:00.000Z", "accept"), "utf8");
    await appendFile(paths.rulingsLog, ruling("rul-1", "2026-07-28T10:00:00.000Z", "accept"), "utf8");
    await appendFile(paths.rulingsLog, ruling("rul-2", "2026-07-28T11:00:00.000Z", "defer"), "utf8");
    await appendFile(paths.rulingsLog, ruling("rul-3", "2026-07-28T12:00:00.000Z", "alternative"), "utf8");

    const counts = await store.countToday("2026-07-28");
    assert.equal(counts.rulings, 2, "the double-appended ruling counts once; the deferral not at all");
    assert.equal((await store.countToday("2026-07-27")).rulings, 1);
    assert.equal((await store.countToday("2026-07-29")).rulings, 0);
  } finally {
    await dropRoot(root);
  }
});

test("a real ruling counts once, however many times it was appended", async () => {
  const root = await makeRoot("hq-count-real");
  try {
    const store = makeStore(root, () => new Date("2026-07-28T09:00:00.000Z"));
    await store.ensure();
    const { packet } = await store.createPacket(packetDraftFixture());
    const { applyRuling } = await import("./rulings.ts");
    const { recordingSpawner } = await import("./testing.ts");
    const result = await applyRuling(
      { store, spawner: recordingSpawner().spawner, now: () => new Date("2026-07-28T09:00:00.000Z") },
      { packetId: packet.id, form: "accept" },
    );
    assert.equal("error" in result, false);
    assert.equal((await store.listRulings()).length, 1);
    assert.equal((await store.countToday("2026-07-28")).rulings, 1);
  } finally {
    await dropRoot(root);
  }
});

test("HQ prunes its own bookkeeping and never the user's records", async () => {
  const root = await makeRoot("hq-retention");
  try {
    const store = makeStore(root);
    await store.ensure();
    const { pruneState } = await import("./store.ts");
    const { writeStopRecord } = await import("./stops.ts");
    const now = new Date("2026-08-30T12:00:00.000Z");
    const old = "2026-07-01T12:00:00.000Z";

    await store.publishSessionState(
      sessionStateFixture({ sessionId: "gone", pid: 999_999_999, lastEventAt: old }),
    );
    await store.publishSessionState(
      sessionStateFixture({ sessionId: "alive", pid: process.pid, lastEventAt: old }),
    );
    await store.publishSessionState(
      sessionStateFixture({ sessionId: "recent", pid: 999_999_999, lastEventAt: now.toISOString() }),
    );
    await writeStopRecord(root, {
      version: 1,
      stopId: "old--done",
      sessionId: "gone",
      sessionFile: null,
      project: "/work/alpha",
      kind: "worker",
      stopState: "idle-done",
      preview: "",
      createdAt: old,
      status: "done",
      claimedByPid: null,
      claimedAt: null,
      outcome: "packet",
      packetId: "pkt-1",
    });
    await writeStopRecord(root, {
      version: 1,
      stopId: "old--open",
      sessionId: "gone",
      sessionFile: null,
      project: "/work/alpha",
      kind: "worker",
      stopState: "idle-done",
      preview: "",
      createdAt: old,
      status: "open",
      claimedByPid: null,
      claimedAt: null,
      outcome: null,
      packetId: null,
    });
    const { packet } = await store.createPacket(packetDraftFixture());

    const pruned = await pruneState(root, { days: 14, now });
    assert.equal(pruned.sessions, 1, "only the dead, aged-out session row goes");
    assert.equal(pruned.stops, 1, "only the finished, aged-out stop goes");

    const remaining = (await store.listFleet()).map((state) => state.sessionId).sort();
    assert.deepEqual(remaining, ["alive", "recent"]);
    const { readStopRecord } = await import("./stops.ts");
    assert.equal(await readStopRecord(root, "old--done"), undefined);
    assert.notEqual(await readStopRecord(root, "old--open"), undefined, "unfinished work survives");
    assert.notEqual(await store.readPacket(packet.id), undefined, "packets are never pruned");
  } finally {
    await dropRoot(root);
  }
});

test("a dead completion drill stops claiming the board and the packet stays honest", async () => {
  const root = await makeRoot("hq-stalled-held");
  try {
    const store = makeStore(root, () => new Date("2026-07-28T12:00:00.000Z"));
    await store.ensure();
    const { reopenStalledDrills } = await import("./store.ts");

    // A completion drill runs against a packet that is held, not drilling.
    const { packet } = await store.createPacket(packetDraftFixture({ flipCondition: "TBD" }));
    assert.equal(packet.status, "held");
    await store.publishSessionState(
      sessionStateFixture({ sessionId: packet.sourceSessionId, drillingPacketIds: [packet.id] }),
    );

    const reopened = await reopenStalledDrills(store, {
      minutes: 30,
      now: new Date("2026-07-28T13:00:00.000Z"),
    });
    assert.deepEqual(reopened, [packet.id]);
    assert.equal(
      (await store.readPacket(packet.id))?.status,
      "held",
      "its gaps are still unfilled, so it stays held rather than reaching the user",
    );
    assert.deepEqual(
      (await store.readSessionState(packet.sourceSessionId))?.drillingPacketIds,
      [],
      "but the board stops showing a drill that is not running",
    );
  } finally {
    await dropRoot(root);
  }
});

test("an unreadable authority file is kept aside, never overwritten as empty", async () => {
  const root = await makeRoot("hq-grad-corrupt");
  try {
    const store = makeStore(root, () => new Date("2026-07-28T12:00:00.000Z"));
    await store.ensure();
    // A file from a newer HQ, or a hand edit: valid JSON, unparsable as state.
    await writeFile(
      hqPaths(root).graduation,
      JSON.stringify({ version: 2, domains: { "ci-flake": { graduated: true } } }),
      "utf8",
    );

    await store.updateDomain("perf", (stats) => ({ ...stats, agreements: 1 }));

    const kept = (await readdir(root)).filter((name) => name.includes("unreadable"));
    assert.equal(kept.length, 1, "the file HQ could not read is preserved, not destroyed");
    assert.match(
      await readFile(join(root, kept[0] ?? ""), "utf8"),
      /ci-flake/,
      "and it still holds the grants that were in it",
    );
    assert.equal((await store.readGraduation()).domains.perf?.agreements, 1);
  } finally {
    await dropRoot(root);
  }
});

test("a session row survives two processes patching different fields at once", async () => {
  const root = await makeRoot("hq-row-lock");
  try {
    const store = makeStore(root);
    await store.ensure();
    await store.publishSessionState(sessionStateFixture({ sessionId: "sess-a", title: null }));

    // The titler and the session's own reporter, interleaved: each owns its field,
    // and neither may revert the other's.
    await Promise.all([
      store.patchSessionState("sess-a", { title: "migrate the eval runner" }),
      store.patchSessionState("sess-a", { state: "running", stopState: "working" }),
      store.mutateSessionState("sess-a", (current) => ({
        ...current,
        drillingPacketIds: [...current.drillingPacketIds, "pkt-1"],
      })),
    ]);

    const row = await store.readSessionState("sess-a");
    assert.equal(row?.title, "migrate the eval runner");
    assert.equal(row?.state, "running");
    assert.deepEqual(row?.drillingPacketIds, ["pkt-1"]);
  } finally {
    await dropRoot(root);
  }
});

test("a drill that never reports gives its packet back to the queue", async () => {
  const root = await makeRoot("hq-stalled-drill");
  try {
    const store = makeStore(root, () => new Date("2026-07-28T12:00:00.000Z"));
    await store.ensure();
    const { reopenStalledDrills } = await import("./store.ts");

    const { packet } = await store.createPacket(packetDraftFixture());
    await store.mutateSessionState;
    await store.publishSessionState(
      sessionStateFixture({ sessionId: packet.sourceSessionId, drillingPacketIds: [packet.id] }),
    );
    await store.updatePacket(packet.id, (current) => ({ ...current, status: "drilling" }));

    // Not yet stale: the drill may still be working.
    assert.deepEqual(
      await reopenStalledDrills(store, { minutes: 30, now: new Date("2026-07-28T12:10:00.000Z") }),
      [],
    );
    assert.equal((await store.readPacket(packet.id))?.status, "drilling");

    const reopened = await reopenStalledDrills(store, {
      minutes: 30,
      now: new Date("2026-07-28T13:00:00.000Z"),
    });
    assert.deepEqual(reopened, [packet.id]);

    const revived = await store.readPacket(packet.id);
    assert.equal(revived?.status, "pending", "the decision comes back rather than being lost");
    assert.match(revived?.annotations.at(-1)?.answer ?? "", /did not|back in the queue/i);
    assert.deepEqual(
      (await store.readSessionState(packet.sourceSessionId))?.drillingPacketIds,
      [],
      "and the board stops claiming a drill is running",
    );
  } finally {
    await dropRoot(root);
  }
});

test("a log survives a torn line and keeps the healthy records", async () => {
  const root = await makeRoot("hq-log");
  try {
    const log = join(root, "records.jsonl");
    await appendJsonl(log, { n: 1 });
    await appendJsonl(log, { n: 2 });
    await writeFile(log, `${await readFile(log, "utf8")}{"n":`, "utf8");
    const records = await readJsonl(log, (value) => value as { n: number });
    assert.deepEqual(records.map((record) => record.n), [1, 2]);
  } finally {
    await dropRoot(root);
  }
});

test("a scan reports an identity mismatch instead of trusting the file", async () => {
  const root = await makeRoot("hq-scan");
  try {
    const dir = join(root, "sessions");
    await atomicWriteJson(join(dir, "sess-a.json"), sessionStateFixture());
    await atomicWriteJson(
      join(dir, "sess-b.json"),
      sessionStateFixture({ sessionId: "sess-a" }),
    );
    await writeFile(join(dir, "sess-c.json"), "{ not json", "utf8");

    const errors: string[] = [];
    const scan = await scanJsonDir(
      dir,
      parseSessionState,
      (record) => record.sessionId,
      (message) => errors.push(message),
    );
    assert.deepEqual(scan.records.map((entry) => entry.id), ["sess-a"]);
    assert.deepEqual(scan.failures.map((entry) => entry.id).sort(), ["sess-b", "sess-c"]);
    assert.equal(errors.length >= 2, true);
  } finally {
    await dropRoot(root);
  }
});

test("a lock left behind by a dead holder is broken, not waited on", async () => {
  const root = await makeRoot("hq-lock-stale");
  try {
    const target = join(root, "row.json");
    await atomicWriteJson(target, { a: 1 });
    // A holder that died leaves its lock file behind.
    await writeFile(`${target}.lock`, "999999999\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 30));

    let ran = false;
    const result = await withFileLock(target, async () => {
      ran = true;
      return "done";
    }, { staleMs: 10 });
    assert.equal(ran, true, "a stale lock must not park the caller forever");
    assert.equal(result, "done");
  } finally {
    await dropRoot(root);
  }
});

test("a lock that never frees is reported and the work still happens", async () => {
  const root = await makeRoot("hq-lock-busy");
  try {
    const target = join(root, "row.json");
    await atomicWriteJson(target, { a: 1 });
    // Held continuously and never stale: the give-up path.
    await writeFile(`${target}.lock`, "1\n", "utf8");
    const held = setInterval(() => {
      const when = new Date();
      void utimes(`${target}.lock`, when, when).catch(() => undefined);
    }, 5);
    const problems: string[] = [];
    try {
      const result = await withFileLock(target, async () => "ran anyway", {
        staleMs: 60_000,
        attempts: 3,
        onError: (message) => problems.push(message),
      });
      assert.equal(result, "ran anyway", "a stuck lock must not stall the seat");
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? "", /Could not take the lock/);
    } finally {
      clearInterval(held);
    }
  } finally {
    await dropRoot(root);
  }
});

test("same-key writes are serialized", async () => {
  const queue = createWriteQueue();
  const order: number[] = [];
  await Promise.all([
    queue("k", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(1);
    }),
    queue("k", async () => {
      order.push(2);
    }),
  ]);
  assert.deepEqual(order, [1, 2]);
});

test("a preview is collapsed and clipped on a grapheme boundary", () => {
  assert.equal(truncatePreview("  a\n\n b  "), "a b");
  const clipped = truncatePreview("👍".repeat(200), 10);
  assert.equal(clipped.endsWith("…"), true);
  assert.equal(clipped.length <= 10, true);
});

test("parsers refuse records they cannot trust", () => {
  assert.equal(parseSessionState({ version: 2 }), undefined);
  assert.equal(parseSessionState({ ...sessionStateFixture(), role: "wat" }), undefined);
  assert.notEqual(parseSessionState(sessionStateFixture()), undefined);
  assert.equal(parsePacket({ version: 1 }), undefined);
  assert.equal(parseRuling({ version: 1, id: "r" }), undefined);
});

test("a packet whose sub-fields are malformed is untrusted, not silently emptied", () => {
  const base = {
    ...packetDraftFixture(),
    version: 1,
    id: "pkt-1",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    generation: 1,
    status: "pending",
  };
  // Each of these drives a different decision: coverage, ratification, ordering.
  assert.equal(parsePacket({ ...base, doctrineCitations: [1, 2] }), undefined);
  assert.equal(parsePacket({ ...base, dependsOn: "pkt-9" }), undefined);
  assert.equal(parsePacket({ ...base, proposal: { kind: "bogus" } }), undefined);
  // Absent is different from malformed, and stays healthy.
  const { doctrineCitations, dependsOn, proposal, ...withoutOptionals } = base;
  assert.notEqual(parsePacket(withoutOptionals), undefined);
});

test("the packet bar rejects placeholders as firmly as blanks", () => {
  const complete: Packet = {
    ...packetDraftFixture(),
    version: 1,
    id: "pkt-1",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    generation: 1,
    status: "pending",
  };
  assert.deepEqual(packetBarViolations(complete), []);

  const vague = packetBarViolations({
    ...complete,
    flipCondition: "TBD",
    options: [
      { id: "a", label: "Do it", price: "n/a" },
      { id: "b", label: "", price: "costs a day of work" },
    ],
    recommendationId: "missing",
  });
  const fields = vague.map((violation) => violation.field).sort();
  assert.deepEqual(fields, [
    "flipCondition",
    "options[0].price",
    "options[1].label",
    "recommendationId",
    // A recommendation naming no option also breaks its pairing with the shadow
    // ruling, which is the same call in its graded role.
    "shadowRuling",
  ]);
});

test("a half-written packet file in the queue is never presented as complete", async () => {
  const root = await makeRoot("hq-torn-packet");
  try {
    const store = makeStore(root);
    await store.ensure();
    const { packet } = await store.createPacket(packetDraftFixture());

    // A packet file caught mid-write, and one whose id no longer matches its name:
    // both must drop out of the queue rather than be shown as a decision.
    const torn = join(hqPaths(root).queue, "pkt-torn.json");
    await writeFile(torn, '{"version":1,"id":"pkt-torn","question":"Should we', "utf8");
    const impostor = join(hqPaths(root).queue, "pkt-impostor.json");
    await atomicWriteJson(impostor, { ...packet, id: "pkt-somethingelse" });

    const presentable = (await store.listPresentable()).map((entry) => entry.id);
    assert.deepEqual(presentable, [packet.id], "only the whole, self-consistent packet is offered");
    const queued = (await store.listQueue()).map((entry) => entry.id);
    assert.deepEqual(queued, [packet.id]);
  } finally {
    await dropRoot(root);
  }
});

test("two options sharing an id keep the packet off the desk", async () => {
  const root = await makeRoot("hq-dup-option");
  try {
    const store = makeStore(root);
    await store.ensure();
    const { packet, violations } = await store.createPacket(
      packetDraftFixture({
        options: [
          { id: "hold", label: "Hold and wait for CI", price: "the branch waits an hour" },
          { id: "hold", label: "Ship it now", price: "ships without a green run" },
        ],
        recommendationId: "hold",
        shadowRuling: {
          optionId: "hold",
          text: "wait for CI",
          rationale: "an hour is cheaper than a revert",
          doctrineCitations: [],
        },
      }),
    );
    // A ruling is carried by option id, so a collision would send the user's
    // decision to whichever option happened to be first.
    assert.equal(packet.status, "held");
    assert.deepEqual(violations.map((violation) => violation.reason), ["two options share an id"]);
    assert.deepEqual(await store.listPresentable(), []);
  } finally {
    await dropRoot(root);
  }
});

test("a packet that misses the bar is held, and filling the gap presents it", async () => {
  const root = await makeRoot("hq-store");
  try {
    const store = makeStore(root);
    await store.ensure();

    const { packet, violations } = await store.createPacket(
      packetDraftFixture({ flipCondition: "TBD" }),
    );
    assert.equal(packet.status, "held");
    assert.equal(violations.length, 1);
    assert.deepEqual(await store.listPresentable(), []);

    const filled = await store.updatePacket(packet.id, (current) => ({
      ...current,
      flipCondition: "if the test failed on the previous two runs it is not flaky",
    }));
    assert.equal(filled?.status, "pending");
    assert.equal(filled?.generation, 2);
    assert.deepEqual((await store.listPresentable()).map((p) => p.id), [packet.id]);
  } finally {
    await dropRoot(root);
  }
});

test("an edit can never leave a sub-bar packet presentable", async () => {
  const root = await makeRoot("hq-store-demote");
  try {
    const store = makeStore(root);
    await store.ensure();
    const { packet } = await store.createPacket(packetDraftFixture());
    assert.equal(packet.status, "pending");
    const demoted = await store.updatePacket(packet.id, (current) => ({
      ...current,
      question: "?",
    }));
    assert.equal(demoted?.status, "held");
    assert.deepEqual(await store.listPresentable(), []);
  } finally {
    await dropRoot(root);
  }
});

test("the queue is re-derived from disk, so a fresh reader sees the same pending set", async () => {
  const root = await makeRoot("hq-restart");
  try {
    const first = makeStore(root);
    await first.ensure();
    const { packet } = await first.createPacket(packetDraftFixture());

    // A brand new store instance stands in for a restarted seat: no shared memory.
    const second = makeStore(root);
    assert.deepEqual((await second.listPresentable()).map((p) => p.id), [packet.id]);
    assert.equal(hqPaths(root).queue.startsWith(root), true);
  } finally {
    await dropRoot(root);
  }
});

test("a packet that recommends one option while predicting another is held", async () => {
  const root = await makeRoot("hq-shadow-split");
  try {
    const store = makeStore(root);
    await store.ensure();
    const { packet, violations } = await store.createPacket(
      packetDraftFixture({
        recommendationId: "retry",
        shadowRuling: {
          optionId: "escalate",
          text: "escalate instead",
          rationale: "predicting the opposite of the advice on the card",
          doctrineCitations: [],
        },
      }),
    );
    // The grade this pairing produces is what earns a domain its authority, so a
    // packet that advises one option and predicts another would inflate or deflate
    // the ladder with a disagreement the user never had.
    assert.equal(packet.status, "held");
    assert.deepEqual(
      violations.map((violation) => violation.field),
      ["shadowRuling"],
    );
  } finally {
    await dropRoot(root);
  }
});

test("the same question is one packet, and the same rule proposal is one packet", async () => {
  const root = await makeRoot("hq-dedupe");
  try {
    const store = makeStore(root);
    await store.ensure();

    // Three stops in one session that raise the same question cost one decision.
    const first = await store.createPacket(packetDraftFixture() as never);
    const again = await store.createPacket(packetDraftFixture() as never);
    assert.equal(again.packet.id, first.packet.id);

    // The same question about a different session is a different decision: ruling on
    // one resumes only that session, so deduplicating them would strand the other.
    const elsewhere = await store.createPacket(
      packetDraftFixture({ sourceSessionId: "other-session" }) as never,
    );
    assert.notEqual(elsewhere.packet.id, first.packet.id);

    // A proposal acts on doctrine alone, so it deduplicates across sessions.
    const proposal = {
      kind: "new-rule" as const,
      scope: "global" as const,
      section: "Directives",
      ruleText: "Prefer the smallest fix that removes the cause.",
      replaces: null,
      domain: "ci-flake",
    };
    const ruleOne = await store.createPacket(packetDraftFixture({ proposal }) as never);
    const ruleTwo = await store.createPacket(
      packetDraftFixture({ proposal, sourceSessionId: "other-session" }) as never,
    );
    assert.equal(ruleTwo.packet.id, ruleOne.packet.id);
    assert.equal((await store.listQueue()).length, 3, "three decisions, not five");
  } finally {
    await dropRoot(root);
  }
});

test("a session has one open decision: a later stop replaces the earlier question", async () => {
  const root = await makeRoot("hq-supersede");
  try {
    const store = makeStore(root);
    await store.ensure();

    const earlier = await store.createPacket(
      packetDraftFixture({ title: "which branch", question: "which branch should this land on?" }) as never,
    );
    const later = await store.createPacket(
      packetDraftFixture({ title: "which reviewer", question: "who should review it?" }) as never,
    );

    // The session stopped again, so it has moved past the first question: ruling on
    // it would resume a session that is no longer where that question left it.
    const open = await store.listPresentable();
    assert.deepEqual(open.map((packet) => packet.id), [later.packet.id]);

    // The packet the caller was handed is the packet on disk: superseding must not
    // patch it afterwards, or every holder of it is working from a stale copy.
    assert.deepEqual(later.packet.supersedes, ["which branch"]);
    assert.equal((await store.readPacket(later.packet.id))?.generation, later.packet.generation);

    // Nothing is lost: the replaced question is kept, and the live packet names it.
    const dropped = await store.readPacket(earlier.packet.id);
    assert.equal(dropped?.status, "withdrawn");
    assert.equal(dropped?.supersededBy, later.packet.id);
    assert.deepEqual((await store.readPacket(later.packet.id))?.supersedes, ["which branch"]);

    // Another session's question is untouched by any of it.
    const other = await store.createPacket(
      packetDraftFixture({ sourceSessionId: "sess-other" }) as never,
    );
    assert.equal((await store.readPacket(other.packet.id))?.status, "pending");
    assert.equal((await store.listPresentable()).length, 2);
  } finally {
    await dropRoot(root);
  }
});

test("a rule proposal is not superseded by the session carrying on", async () => {
  const root = await makeRoot("hq-supersede-proposal");
  try {
    const store = makeStore(root);
    await store.ensure();
    const proposal = await store.createPacket(packetDraftFixture({
      title: "ratify a rule",
      proposal: {
        kind: "new-rule",
        scope: "global",
        section: "Directives",
        ruleText: "Prefer the smallest fix that removes the cause.",
        replaces: null,
        domain: "ci-flake",
      },
    }) as never);
    await store.createPacket(packetDraftFixture({ title: "which reviewer" }) as never);
    // It acts on doctrine, not on the session, so nothing the session does next
    // makes it stale.
    assert.equal((await store.readPacket(proposal.packet.id))?.status, "pending");
  } finally {
    await dropRoot(root);
  }
});

test("a rule that only restates its own case is refused before it reaches the user", () => {
  // Doctrine is read on every cycle and is meant to decide the *next* case. A rule
  // naming the case it came from can never do that, and costs a decision to reject.
  const overfit = [
    "In investigation-completion: Accept as done.",
    "When pkt-20260729-abcd asked about the timeout, raise it.",
    "Accept as done for session 019fad12-9d8b-78da-a0a2-974c6d0ee828.",
    "Update ~/Lemonade/cxllm/src/router.ts when the router changes.",
    "In this case, prefer reverting rather than holding the release.",
    "Keep `currentStepIndex` monotonic when the reply anchor stalls.",
    "Accept.",
  ];
  for (const rule of overfit) {
    assert.ok(
      ruleGeneralityViolations(rule).length > 0,
      `should have been refused: ${rule}`,
    );
  }

  const general = [
    "Prefer reverting a risky change over holding a release while a fix is found.",
    "Treat a suite that fails the same way twice as broken rather than flaky.",
    "When an investigation answers the question it was given, close it rather than widening its scope.",
  ];
  for (const rule of general) {
    assert.deepEqual(ruleGeneralityViolations(rule), [], `should have passed: ${rule}`);
  }
});

test("a decision written in implementation detail is held, not shown", async () => {
  const root = await makeRoot("hq-load");
  try {
    const store = makeStore(root);
    await store.ensure();

    // What triage reads is technical; what it writes has to be a decision. A question
    // built out of code asks the user to read code, which is the cost HQ removes.
    const technical = await store.createPacket(packetDraftFixture({
      question:
        "The `currentStepIndex` in normalizeInput did not advance because ~/src/router.ts threw at handleReply (router.ts:88); should we patch replyAnchor or retry?",
    }) as never);
    assert.equal(technical.packet.status, "held");
    assert.ok(
      technical.violations.some((violation) =>
        violation.field === "question" && /implementation detail/.test(violation.reason)
      ),
      JSON.stringify(technical.violations),
    );

    // One named thing is allowed: sometimes the choice really is between two of them.
    const named = await store.createPacket(packetDraftFixture({
      sourceSessionId: "sess-named",
      question: "The retry keeps failing on the same test. Retry once more, or look at it now?",
    }) as never);
    assert.equal(named.packet.status, "pending");

    // And a decision nobody could read in a sitting is held on length alone.
    const wordy = await store.createPacket(packetDraftFixture({
      sourceSessionId: "sess-wordy",
      question: "Should we accept this as done? ".repeat(20),
    }) as never);
    assert.equal(wordy.packet.status, "held");
    assert.ok(wordy.violations.some((violation) => /under 400/.test(violation.reason)));

    const paragraph = await store.createPacket(packetDraftFixture({
      sourceSessionId: "sess-label",
      options: [
        { id: "a", label: "Accept it as done ".repeat(6), price: "nothing changes" },
        { id: "b", label: "Send it back", price: "another pass, half a day" },
      ],
      recommendationId: "a",
    }) as never);
    assert.equal(paragraph.packet.status, "held");
    assert.ok(paragraph.violations.some((violation) => /name the course of action/.test(violation.reason)));
  } finally {
    await dropRoot(root);
  }
});

test("decisions that went cold while nobody was at the desk are expired, not presented", async () => {
  const root = await makeRoot("hq-cold");
  try {
    const store = makeStore(root);
    await store.ensure();

    // Two decisions: one queued a week ago, one this morning. createdAt is written by
    // the store's own clock and never editable afterwards, so the old one is queued
    // through a store that thinks it is last week.
    const lastWeek = makeStore(root, () => new Date("2026-07-20T09:00:00.000Z"));
    await lastWeek.createPacket({
      id: "pkt-old",
      ...packetDraftFixture({ sourceSessionId: "sess-old" }),
    } as never);
    const fresh = await store.createPacket({
      id: "pkt-fresh",
      ...packetDraftFixture({ sourceSessionId: "sess-fresh" }),
    } as never);

    const expired = await store.expireStaleDecisions(new Date("2026-07-25T00:00:00.000Z"));

    // Coming back after a week should not mean answering last week's questions: the
    // work moved on, and presenting them as live would misstate what they can change.
    assert.deepEqual(expired.map((packet) => packet.id), ["pkt-old"]);
    assert.deepEqual((await store.listPresentable()).map((packet) => packet.id), [fresh.packet.id]);
    // Archived, not deleted: the record of what was asked survives.
    assert.equal((await store.readPacket("pkt-old"))?.status, "withdrawn");
  } finally {
    await dropRoot(root);
  }
});
