import assert from "node:assert/strict";
import { appendFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
} from "./io.ts";
import { assertSafeId, hqPaths, projectSlug, resolveStateRoot } from "./paths.ts";
import { dropRoot, makeRoot, makeStore, packetDraftFixture, sessionStateFixture } from "./testing.ts";
import {
  packetBarViolations,
  parsePacket,
  parseRuling,
  parseSessionState,
  type Packet,
} from "./types.ts";

test("the state root resolves from HQ_HOME, then the pi dir, then the default", () => {
  assert.equal(resolveStateRoot({ HQ_HOME: "/tmp/explicit" }), "/tmp/explicit");
  assert.equal(
    resolveStateRoot({ PI_CODING_AGENT_DIR: "/home/someone/.pi/agent" }),
    "/home/someone/.pi/hq",
  );
  assert.match(resolveStateRoot({}), /\/\.pi\/hq$/);
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
  ]);
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
