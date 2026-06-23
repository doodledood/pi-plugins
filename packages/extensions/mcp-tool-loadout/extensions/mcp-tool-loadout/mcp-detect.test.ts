import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isMcpTool, loadMcpUniverse, serverPrefix, inferServer } from "./mcp-detect.ts";
import { mcpTool, builtinTool, ourTool, tmpDir, writeJson, writeRaw } from "./testutil.ts";

test("isMcpTool detects adapter tools, not built-ins or our own tool", () => {
  assert.equal(isMcpTool(mcpTool("alpha_get_x")), true);
  assert.equal(isMcpTool(builtinTool("read")), false);
  assert.equal(isMcpTool(ourTool("load_tools")), false);
});

test("serverPrefix sanitizes non-alphanumerics", () => {
  assert.equal(serverPrefix("chrome-devtools"), "chrome_devtools");
  assert.equal(serverPrefix("alpha_mcp"), "alpha_mcp");
});

test("inferServer matches longest server prefix", () => {
  const servers = ["alpha_mcp", "chat", "chrome-devtools", "eval_mcp"];
  assert.equal(inferServer("chrome_devtools_click", servers), "chrome-devtools");
  assert.equal(inferServer("chat_chat_send_message", servers), "chat");
  assert.equal(inferServer("eval_mcp_list_datasets", servers), "eval_mcp");
  assert.equal(inferServer("alpha_mcp_get_page", servers), "alpha_mcp");
  assert.equal(inferServer("unknown_tool", servers), "");
});

test("loadMcpUniverse parses servers->tools from cache fixture", () => {
  const p = join(tmpDir(), "mcp-cache.json");
  writeJson(p, {
    version: 1,
    servers: {
      alpha_mcp: { tools: [{ name: "get_x", description: "gets x" }, { name: "get_y", description: "" }] },
      warehouse_mcp: { tools: [{ name: "run_query" }] },
    },
  });
  const u = loadMcpUniverse(p);
  assert.equal(u.length, 3);
  const alpha_mcp = u.filter((t) => t.server === "alpha_mcp").map((t) => t.name).sort();
  assert.deepEqual(alpha_mcp, ["get_x", "get_y"]);
  assert.equal(u.find((t) => t.name === "run_query")?.server, "warehouse_mcp");
});

test("loadMcpUniverse is graceful on missing/malformed cache", () => {
  assert.deepEqual(loadMcpUniverse(join(tmpDir(), "nope.json")), []);
  const bad = join(tmpDir(), "bad.json");
  writeRaw(bad, "{not json");
  assert.deepEqual(loadMcpUniverse(bad), []);
});
