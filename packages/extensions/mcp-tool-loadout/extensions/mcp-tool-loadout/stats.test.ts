import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { attributeToolNames, recencyScores, UsageLog, type UsageEvent } from "./stats.ts";
import { priorFor } from "./select.ts";
import { tmpDir } from "./testutil.ts";

test("attributeToolNames unwraps proxy and wake calls and records only MCP tools", () => {
  const isMcp = (name: string) => name.startsWith("alpha_");
  assert.deepEqual(attributeToolNames("mcp", { tool: "alpha_get_x" }, isMcp), ["alpha_get_x"]);
  assert.deepEqual(attributeToolNames("mcp", {}, isMcp), []);
  assert.deepEqual(attributeToolNames("mcp", { tool: "" }, isMcp), []);
  assert.deepEqual(attributeToolNames("load_tools", { names: ["a", "b"] }, isMcp), ["a", "b"]);
  assert.deepEqual(attributeToolNames("load_tools", { names: ["a", 3] }, isMcp), ["a"]);
  assert.deepEqual(attributeToolNames("load_tools", {}, isMcp), []);
  assert.deepEqual(attributeToolNames("alpha_get_x", {}, isMcp), ["alpha_get_x"]);
  assert.deepEqual(attributeToolNames("grep", {}, isMcp), []);
});

test("recencyScores decays older events", () => {
  const now = 1_000_000_000_000;
  const day = 86_400_000;
  const halfLife = 7;
  const events: UsageEvent[] = [
    { name: "a", ts: now }, // weight 1
    { name: "a", ts: now - halfLife * day }, // weight 0.5
    { name: "b", ts: now - 2 * halfLife * day }, // weight 0.25
  ];
  const s = recencyScores(events, halfLife, now);
  assert.ok(Math.abs((s.get("a") ?? 0) - 1.5) < 1e-6);
  assert.ok(Math.abs((s.get("b") ?? 0) - 0.25) < 1e-6);
  assert.ok((s.get("a") ?? 0) > (s.get("b") ?? 0));
});

test("prior pseudo-count ranks a no-usage-but-prior tool above an unknown tool", () => {
  const recency = recencyScores([], 14, Date.now()); // empty
  const prior = { rare: 5 };
  const scoreRare = (recency.get("rare") ?? 0) + priorFor("rare", "", prior);
  const scoreUnknown = (recency.get("unknown") ?? 0) + priorFor("unknown", "", prior);
  assert.equal(scoreRare, 5);
  assert.equal(scoreUnknown, 0);
  assert.ok(scoreRare > scoreUnknown);
});

test("UsageLog records per-project and round-trips through disk", () => {
  const dir = tmpDir();
  const log = join(dir, "usage.jsonl");
  const legacy = join(dir, "stats.json");
  const s1 = UsageLog.open(log, legacy);
  assert.deepEqual(s1.eventsFor("proj"), []);
  s1.record("proj1", ["a", "b"], 111);
  s1.record("proj2", ["c"], 222);

  const s2 = UsageLog.open(log, legacy);
  assert.deepEqual(s2.eventsFor("proj1"), [{ name: "a", ts: 111 }, { name: "b", ts: 111 }]);
  assert.equal(s2.eventsFor("proj2").length, 1);
  assert.deepEqual(s2.eventsFor("missing"), []);
});

test("allEvents pools usage across every project", () => {
  const dir = tmpDir();
  const log = join(dir, "usage.jsonl");
  UsageLog.open(log, join(dir, "stats.json")).record("repoA", ["x"], 1);
  UsageLog.open(log, join(dir, "stats.json")).record("repoB", ["y", "x"], 2);
  const names = UsageLog.open(log, join(dir, "stats.json")).allEvents().map((e) => e.name).sort();
  assert.deepEqual(names, ["x", "x", "y"]);
});

test("record ignores empty name lists", () => {
  const dir = tmpDir();
  const log = join(dir, "usage.jsonl");
  UsageLog.open(log, join(dir, "stats.json")).record("p", []);
  assert.equal(existsSync(log), false);
});

test("the pre-log stats file is imported once and renamed aside", () => {
  const dir = tmpDir();
  const log = join(dir, "usage.jsonl");
  const legacy = join(dir, "stats.json");
  writeFileSync(legacy, JSON.stringify({ version: 1, projects: { p: [{ name: "alpha_x", ts: 5 }, { name: "bad" }] } }));
  assert.deepEqual(UsageLog.open(log, legacy).eventsFor("p"), [{ name: "alpha_x", ts: 5 }]);
  assert.equal(existsSync(legacy), false);
  assert.equal(existsSync(`${legacy}.imported`), true);
  // A not-yet-restarted older version writes the old file again: it is not imported twice.
  writeFileSync(legacy, JSON.stringify({ version: 1, projects: { p: [{ name: "alpha_x", ts: 5 }] } }));
  assert.equal(UsageLog.open(log, legacy).eventsFor("p").length, 1);
});

test("an unreadable pre-log stats file is kept for a later import, not dropped", () => {
  const dir = tmpDir();
  const log = join(dir, "usage.jsonl");
  const legacy = join(dir, "stats.json");
  const full = JSON.stringify({ version: 1, projects: { p: [{ name: "alpha_x", ts: 5 }] } });
  writeFileSync(legacy, full.slice(0, 20));
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(UsageLog.open(log, legacy).eventsFor("p"), []);
  } finally {
    console.error = original;
  }
  writeFileSync(legacy, full);
  assert.deepEqual(UsageLog.open(log, legacy).eventsFor("p"), [{ name: "alpha_x", ts: 5 }]);
});

test("compaction keeps the newest events per project and appends made meanwhile", () => {
  const dir = tmpDir();
  const log = join(dir, "usage.jsonl");
  const legacy = join(dir, "stats.json");
  const writer = UsageLog.open(log, legacy);
  for (let i = 0; i < 12_000; i++) writer.record("busy", ["alpha_x"], i);
  writer.record("quiet", ["alpha_y"], 1);
  const compacted = UsageLog.open(log, legacy, 20_000);
  assert.equal(compacted.eventsFor("busy").length, 5_000);
  assert.equal(compacted.eventsFor("busy")[0]!.ts, 7_000, "the oldest events were the ones dropped");
  writer.record("busy", ["alpha_z"], 12_000);
  const reread = UsageLog.open(log, legacy, 20_000);
  assert.equal(reread.eventsFor("busy").at(-1)!.name, "alpha_z");
  assert.deepEqual(reread.eventsFor("quiet"), [{ name: "alpha_y", ts: 1 }]);
  const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  assert.equal(lines, 5_002);
});

test("a compaction another session just claimed is left alone, even when the log was idle", () => {
  const dir = tmpDir();
  const log = join(dir, "usage.jsonl");
  const legacy = join(dir, "stats.json");
  UsageLog.open(log, legacy).record("p", ["alpha_x"], 1);
  // The log was last written two minutes ago; a session claims it for compaction now.
  const idle = (Date.now() - 120_000) / 1000;
  utimesSync(log, idle, idle);
  const now = Date.now();
  const claimed = `${log}.compacting-99999-${now}`;
  renameSync(log, claimed);
  UsageLog.open(log, legacy, now + 5);
  assert.ok(existsSync(claimed), "a live session's compaction claim was taken over");
  assert.equal(existsSync(log) ? readFileSync(log, "utf8").trim() : "", "", "the claimed events were appended a second time");
});

test("the claim of a session that died mid-compaction is carried over once it is a minute old", () => {
  const dir = tmpDir();
  const log = join(dir, "usage.jsonl");
  const legacy = join(dir, "stats.json");
  UsageLog.open(log, legacy).record("p", ["alpha_x"], 1);
  const claimedAt = 1_000_000;
  renameSync(log, `${log}.compacting-99999-${claimedAt}`);
  assert.deepEqual(UsageLog.open(log, legacy, claimedAt + 59_000).eventsFor("p"), [], "recovered before the claim was a minute old");
  assert.deepEqual(UsageLog.open(log, legacy, claimedAt + 61_000).eventsFor("p"), [{ name: "alpha_x", ts: 1 }]);
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes("compacting")), [], "the abandoned claim was left behind");
});
