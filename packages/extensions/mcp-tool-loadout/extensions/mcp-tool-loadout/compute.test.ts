import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLoadout, planActivation } from "./compute.ts";
import { estimateTokens } from "./select.ts";
import { DEFAULTS, type LoadoutConfig } from "./config.ts";
import type { McpToolMeta } from "./mcp-detect.ts";
import type { UsageEvent } from "./stats.ts";
import { mcpTool, builtinTool, ourTool } from "./testutil.ts";

function cfg(over: Partial<LoadoutConfig> = {}): LoadoutConfig {
  return { ...DEFAULTS, prior: {}, alwaysActiveMcpTools: [], excludeFromCatalog: [], ...over };
}

const universe: McpToolMeta[] = [
  { server: "alpha_mcp", name: "a", description: "" },
  { server: "alpha_mcp", name: "b", description: "" },
  { server: "chat", name: "x", description: "" },
  { server: "warehouse_mcp", name: "q", description: "runs a query" }, // proxy-only
];

test("never deactivates non-MCP tools; keeps infra (mcp) active; gates over-budget MCP", () => {
  const allTools = [
    builtinTool("read"),
    builtinTool("bash"),
    ourTool("load_tools"),
    mcpTool("mcp"), // proxy infra
    mcpTool("alpha_a", "", 20), // large
    mcpTool("alpha_b", "", 0), // small
    mcpTool("chat_x", "", 0), // small
  ];
  const budget = estimateTokens(mcpTool("alpha_b", "", 0)) + estimateTokens(mcpTool("chat_x", "", 0));
  const r = computeLoadout({ allTools, universe, cfg: cfg({ budgetTokens: budget }), recency: new Map() });

  for (const must of ["read", "bash", "load_tools", "mcp"]) {
    assert.ok(r.activeToolNames.includes(must), `${must} must stay active`);
  }
  assert.ok(r.activeToolNames.includes("alpha_b"));
  assert.ok(r.activeToolNames.includes("chat_x"));
  assert.ok(!r.activeToolNames.includes("alpha_a"), "over-budget MCP tool is dormant");
  assert.equal(r.activeMcpCount, 2);
  assert.equal(r.dormantMcpCount, 1);
});

test("catalog lists registered (active/dormant) and proxy-only tools", () => {
  const allTools = [
    mcpTool("mcp"),
    mcpTool("alpha_a", "alpha tool", 20),
    mcpTool("alpha_b", "beta tool", 0),
    mcpTool("chat_x", "x tool", 0),
  ];
  const budget = estimateTokens(mcpTool("alpha_b", "beta tool", 0));
  const r = computeLoadout({ allTools, universe, cfg: cfg({ budgetTokens: budget }), recency: new Map() });
  assert.match(r.catalog, /`alpha_a`/);
  assert.match(r.catalog, /`alpha_b`/);
  assert.match(r.catalog, /`chat_x`/);
  assert.match(r.catalog, /`q` ·proxy/); // snowflake proxy-only from cache
  assert.doesNotMatch(r.catalog, /`mcp`/); // infra proxy tool not catalogued
});

test("deterministic for identical input", () => {
  const allTools = [builtinTool("read"), mcpTool("alpha_a"), mcpTool("alpha_b")];
  const a = computeLoadout({ allTools, universe, cfg: cfg(), recency: new Map() });
  const b = computeLoadout({ allTools, universe, cfg: cfg(), recency: new Map() });
  assert.deepEqual(a.activeToolNames, b.activeToolNames);
  assert.equal(a.catalog, b.catalog);
});

test("empty universe + only built-ins: no throw, all non-MCP active", () => {
  const allTools = [builtinTool("read"), builtinTool("bash")];
  const r = computeLoadout({ allTools, universe: [], cfg: cfg(), recency: new Map() });
  assert.deepEqual(r.activeToolNames.sort(), ["bash", "read"]);
  assert.equal(r.activeMcpCount, 0);
});

test("planActivation: recent usage promotes a tool within a one-slot budget", () => {
  const now = 2_000_000_000_000;
  const allTools = [mcpTool("alpha_a", "", 0), mcpTool("alpha_b", "", 0)];
  const budget = estimateTokens(mcpTool("alpha_a", "", 0)); // fits exactly one
  const c = cfg({ budgetTokens: budget, minProjectEvents: 1 });

  const noEvents = planActivation(allTools, universe, c, [], [], now);
  assert.ok(noEvents.activeToolNames.includes("alpha_a")); // tie -> name asc
  assert.ok(!noEvents.activeToolNames.includes("alpha_b"));

  const events: UsageEvent[] = [{ name: "alpha_b", ts: now }];
  const withUse = planActivation(allTools, universe, c, events, [], now);
  assert.ok(withUse.activeToolNames.includes("alpha_b"), "recent usage promotes alpha_b");
  assert.ok(!withUse.activeToolNames.includes("alpha_a"));
});

test("planActivation falls back to global usage when project data is sparse", () => {
  const now = 2_000_000_000_000;
  const allTools = [mcpTool("alpha_a", "", 0), mcpTool("alpha_b", "", 0)];
  const budget = estimateTokens(mcpTool("alpha_a", "", 0)); // one slot
  const c = cfg({ budgetTokens: budget, minProjectEvents: 3 });
  const global: UsageEvent[] = [
    { name: "alpha_b", ts: now },
    { name: "alpha_b", ts: now },
    { name: "alpha_b", ts: now },
  ];

  // Sparse project (< 3 relevant MCP events) → rank by global usage (favors alpha_b).
  const sparse = planActivation(allTools, universe, c, [{ name: "alpha_a", ts: now }], global, now);
  assert.ok(sparse.activeToolNames.includes("alpha_b"), "global promotes alpha_b on sparse project");
  assert.ok(!sparse.activeToolNames.includes("alpha_a"));

  // Project meets the threshold (favoring alpha_a) → trust project, ignore global.
  const proj: UsageEvent[] = [
    { name: "alpha_a", ts: now },
    { name: "alpha_a", ts: now },
    { name: "alpha_a", ts: now },
  ];
  const dense = planActivation(allTools, universe, c, proj, global, now);
  assert.ok(dense.activeToolNames.includes("alpha_a"), "project usage wins once threshold met");
  assert.ok(!dense.activeToolNames.includes("alpha_b"));
});
