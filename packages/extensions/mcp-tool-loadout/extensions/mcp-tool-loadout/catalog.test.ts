import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, type CatalogTool } from "./catalog.ts";

const tools: CatalogTool[] = [
  { name: "alpha_a", server: "alpha_mcp" },
  { name: "alpha_b", server: "alpha_mcp" },
  { name: "warehouse_q", server: "warehouse_mcp", proxyOnly: true },
];

test("every tool name appears exactly once", () => {
  const out = buildCatalog(tools, new Set(["alpha_a"]));
  for (const t of tools) {
    const occurrences = out.split(`\`${t.name}\``).length - 1;
    assert.equal(occurrences, 1, `${t.name} should appear once`);
  }
});

test("active vs dormant vs proxy marking; names only (no gist)", () => {
  const out = buildCatalog(tools, new Set(["alpha_a"]));
  assert.match(out, /- `alpha_a`\n/); // active: name only, no marker
  assert.match(out, /`alpha_b` ·dormant/);
  assert.match(out, /`warehouse_q` ·proxy/);
  // No gists on tool lines (names only); the howto header may contain em-dashes.
  for (const line of out.split("\n").filter((l) => l.startsWith("- `"))) {
    assert.doesNotMatch(line, / — /);
  }
});

test("deterministic for identical input", () => {
  const a = buildCatalog(tools, new Set(["alpha_a"]));
  const b = buildCatalog(tools, new Set(["alpha_a"]));
  assert.equal(a, b);
});

test("groups by server and includes how-to header", () => {
  const out = buildCatalog(tools, new Set());
  assert.match(out, /### alpha_mcp/);
  assert.match(out, /### warehouse_mcp/);
  assert.match(out, /load_tools/);
});

test("catalog stays under ~1.5k tokens for a ~100-tool universe", () => {
  const big: CatalogTool[] = [];
  const servers = ["alpha_mcp", "chat", "chrome-devtools", "eval_mcp", "tools_mcp"];
  for (let i = 0; i < 100; i++) {
    const server = servers[i % servers.length]!;
    big.push({ name: `${server}_tool_${i}`, server });
  }
  const active = new Set(big.filter((_, i) => i % 5 < 2).map((t) => t.name));
  const out = buildCatalog(big, active);
  const estTokens = Math.ceil(out.length / 4);
  assert.ok(estTokens <= 1500, `catalog est ${estTokens} tokens should be <= 1500`);
});
