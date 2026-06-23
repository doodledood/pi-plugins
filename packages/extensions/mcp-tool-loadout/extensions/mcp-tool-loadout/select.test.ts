import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, priorFor, selectActiveMcp, type Candidate } from "./select.ts";
import { mcpTool } from "./testutil.ts";

test("estimateTokens grows with schema size", () => {
  const small = estimateTokens(mcpTool("a", "short", 0));
  const big = estimateTokens(mcpTool("a", "short", 10));
  assert.ok(big > small);
});

test("estimateTokens uses the calibrated ~2.5 chars/token divisor for tool JSON", () => {
  // Pin the divisor (calibrated against Anthropic count_tokens; tool-schema JSON is
  // ~2.48 chars/token, not the ~4 that holds for prose). Plain parameters object keeps
  // the expected serialization deterministic and independent of TypeBox output.
  const tool = { name: "alpha_get_page", description: "Get a Notion page", parameters: { type: "object" } };
  const serialized = JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
  assert.equal(estimateTokens(tool), Math.ceil(serialized.length / 2.5));
});

test("priorFor: tool-specific wins over server, else 0", () => {
  assert.equal(priorFor("t", "s", { t: 9, s: 3 }), 9);
  assert.equal(priorFor("t", "s", { s: 3 }), 3);
  assert.equal(priorFor("t", "s", {}), 0);
  assert.equal(priorFor("t", "", { s: 3 }), 0);
});

const cands = (xs: Array<[string, number, number]>): Candidate[] =>
  xs.map(([name, tokens, score]) => ({ name, tokens, score }));

test("selectActiveMcp keeps top-scored within budget", () => {
  const c = cands([
    ["a", 100, 5],
    ["b", 100, 3],
    ["c", 100, 1],
  ]);
  const { active, dormant } = selectActiveMcp(c, 250, []);
  assert.deepEqual(active, ["a", "b"]);
  assert.deepEqual(dormant, ["c"]);
});

test("budget=0 yields only always-active", () => {
  const c = cands([
    ["a", 100, 5],
    ["b", 100, 3],
  ]);
  const { active, dormant } = selectActiveMcp(c, 0, ["b"]);
  assert.deepEqual(active, ["b"]);
  assert.deepEqual(dormant, ["a"]);
});

test("always-active is included regardless of score and counts toward budget", () => {
  const c = cands([
    ["hi", 100, 9],
    ["low", 100, 0],
  ]);
  const { active } = selectActiveMcp(c, 100, ["low"]);
  // low is forced in (uses the whole 100 budget); hi cannot fit afterwards
  assert.deepEqual(active, ["low"]);
});

test("ties break deterministically by name", () => {
  const c = cands([
    ["b", 10, 5],
    ["a", 10, 5],
  ]);
  const { active } = selectActiveMcp(c, 1000, []);
  assert.deepEqual(active, ["a", "b"]);
});
