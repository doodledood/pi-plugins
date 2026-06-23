import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { attributeToolNames, recencyScores, StatsStore, type UsageEvent } from "./stats.ts";
import { priorFor } from "./select.ts";
import { tmpDir } from "./testutil.ts";

test("attributeToolNames unwraps proxy and wake calls", () => {
  assert.deepEqual(attributeToolNames("mcp", { tool: "alpha_get_x" }), ["alpha_get_x"]);
  assert.deepEqual(attributeToolNames("mcp", {}), []);
  assert.deepEqual(attributeToolNames("mcp", { tool: "" }), []);
  assert.deepEqual(attributeToolNames("load_tools", { names: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(attributeToolNames("load_tools", { names: ["a", 3] }), ["a"]);
  assert.deepEqual(attributeToolNames("load_tools", {}), []);
  assert.deepEqual(attributeToolNames("grep", {}), ["grep"]);
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

test("StatsStore records per-project and round-trips through disk", () => {
  const p = join(tmpDir(), "stats.json");
  const s1 = StatsStore.load(p); // missing file
  assert.deepEqual(s1.eventsFor("proj"), []);
  s1.record("proj1", ["a", "b"], 111);
  s1.record("proj2", ["c"], 222);
  s1.save();

  const s2 = StatsStore.load(p);
  assert.equal(s2.eventsFor("proj1").length, 2);
  assert.equal(s2.eventsFor("proj2").length, 1);
  assert.equal(s2.eventsFor("proj1")[0]?.name, "a");
  assert.deepEqual(s2.eventsFor("missing"), []);
});

test("allEvents pools usage across every project", () => {
  const s = StatsStore.load(join(tmpDir(), "s.json"));
  s.record("repoA", ["x"], 1);
  s.record("repoB", ["y", "x"], 2);
  const names = s.allEvents().map((e) => e.name).sort();
  assert.deepEqual(names, ["x", "x", "y"]);
});

test("StatsStore.record ignores empty name lists", () => {
  const s = StatsStore.load(join(tmpDir(), "s.json"));
  s.record("p", []);
  assert.deepEqual(s.eventsFor("p"), []);
});
