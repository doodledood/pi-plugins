import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ORCHESTRATION_DENYLIST,
  HARD_DENIED_TOOLS,
  isMcpTool,
  resolveExcludedTools,
} from "./child-profile.ts";

test("resolveExcludedTools always includes the hard denylist", () => {
  const resolved = resolveExcludedTools([]);
  for (const name of HARD_DENIED_TOOLS) assert.ok(resolved.includes(name), `missing ${name}`);
});

test("resolveExcludedTools merges and de-duplicates configured tools", () => {
  const resolved = resolveExcludedTools([...DEFAULT_ORCHESTRATION_DENYLIST, "advisor_consult", " custom_tool "]);
  assert.ok(resolved.includes("goal"));
  assert.ok(resolved.includes("subagent"));
  assert.ok(resolved.includes("custom_tool"));
  assert.equal(resolved.filter((n) => n === "advisor_consult").length, 1);
});

test("resolveExcludedTools ignores blank entries but keeps hard denies", () => {
  const resolved = resolveExcludedTools(["", "   "]);
  assert.deepEqual(new Set(resolved), new Set(HARD_DENIED_TOOLS));
});

test("isMcpTool detects pi-mcp-adapter tools by source info", () => {
  assert.equal(isMcpTool({ source: "pi-mcp-adapter", path: "" }), true);
  assert.equal(isMcpTool({ source: "extension", path: "/x/mcp-adapter/index.ts" }), true);
  assert.equal(isMcpTool({ source: "builtin", path: "" }), false);
  assert.equal(isMcpTool(undefined), false);
});
