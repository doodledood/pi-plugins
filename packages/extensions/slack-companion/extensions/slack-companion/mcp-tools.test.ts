// Holds docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md: the helper's
// MCP tools are only read-only ones main has active, or ones the owner listed; never the send tool.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exposedNamesFor, helperMcpTools, missingSlackTools, readMcpCache, type McpCache } from "./mcp-tools.ts";

const tool = (name: string, readOnly: boolean) => ({ name, description: name, inputSchema: { type: "object" }, readOnly });

const cache: McpCache = new Map([
  ["slack", [tool("slack_send_message", true), tool("slack_read_thread", true), tool("slack_search_public_and_private", true)]],
  ["data-mcp", [tool("lookup", true), tool("write_row", false)]],
  ["other", [tool("lookup", true)]],
]);

test("only read-only tools active in main, or listed by the owner; the send tool never, even if marked read-only or listed", () => {
  const active = new Set(["slack_read_thread", "slack_send_message", "data_lookup", "other_lookup"]);
  const names = (investigative: string[]) => helperMcpTools(cache, active, investigative, ["slack_send_message"]).map((t) => t.exposedName).sort();
  assert.deepEqual(names([]), ["data-mcp__lookup", "other__lookup", "slack_read_thread"], "two servers sharing a name get <server>__ names");
  assert.deepEqual(names(["slack_send_message", "data-mcp/write_row"]), ["data-mcp__lookup", "other__lookup", "slack_read_thread", "write_row"]);
  assert.equal(names([]).includes("slack_search_public_and_private"), false, "read-only but not active in main");
  assert.deepEqual(helperMcpTools(undefined, active, ["x"], []), []);
});

test("every name the adapter can give a tool is recognized", () => {
  assert.deepEqual(new Set(exposedNamesFor("data-mcp", "lookup")), new Set(["lookup", "data-mcp_lookup", "data_lookup", "mcp__data-mcp_lookup", "mcp__data_mcp__lookup"]));
  assert.ok(exposedNamesFor("slack", "slack_read_thread").includes("slack_read_thread"), "a name already carrying the prefix keeps it");
});

test("tool names are judged only against the server that would serve them", () => {
  const names = ["slack_read_channel", "slack_read_thread", "slack_send_message", "slack_read_user_profile"];
  assert.deepEqual(missingSlackTools(cache, names, undefined), ["slack_read_channel", "slack_read_user_profile"]);
  assert.deepEqual(missingSlackTools(cache, names, "not-cached-yet"), [], "a server not discovered yet is not judged");
  assert.deepEqual(missingSlackTools(new Map([["other", [tool("x", true)]]]), names, undefined), [], "no server lists any of them yet");
  assert.deepEqual(missingSlackTools(undefined, names, undefined), []);
});

test("the cache is read whole; a missing cache is no cache, a broken one is an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-"));
  assert.equal(readMcpCache(join(dir, "none.json")), undefined);
  writeFileSync(join(dir, "c.json"), JSON.stringify({ version: 1, servers: { s: { tools: [{ name: "t", annotations: { readOnlyHint: true } }, { bad: 1 }] } } }));
  assert.deepEqual(readMcpCache(join(dir, "c.json"))!.get("s"), [{ name: "t", description: "", inputSchema: { type: "object", properties: {} }, readOnly: true }]);
  writeFileSync(join(dir, "broken.json"), "{");
  assert.throws(() => readMcpCache(join(dir, "broken.json")));
  writeFileSync(join(dir, "shape.json"), JSON.stringify({ version: 2, tools: [] }));
  assert.throws(() => readMcpCache(join(dir, "shape.json")), /no "servers" object/);
});
