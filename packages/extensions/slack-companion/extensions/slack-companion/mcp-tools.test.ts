// Holds docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md: the helper's
// MCP reach is every read-only tool or one the owner listed; never the send tool. Holds
// docs/adr/20261104-keep-the-owners-own-slack-out-of-the-helpers-reach.md: the owner's own Slack
// server's tools only when he lists them.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exposedNamesFor, helperMcpTools, missingSlackTools, readMcpCache, slackServers, type McpCache } from "./mcp-tools.ts";

const tool = (name: string, readOnly: boolean) => ({ name, description: name, inputSchema: { type: "object" }, readOnly });

const cache: McpCache = new Map([
  ["slack", [tool("slack_send_message", true), tool("slack_read_thread", true), tool("slack_search_public_and_private", true)]],
  ["data-mcp", [tool("lookup", true), tool("write_row", false)]],
  ["other", [tool("lookup", true)]],
]);

test("every read-only tool, or one the owner listed, is reachable; main's active ones are shown directly; the send tool never", () => {
  const active = new Set(["slack_read_thread", "slack_send_message", "data_lookup", "other_lookup"]);
  const reach = (investigative: string[]) => helperMcpTools(cache, active, investigative, { blocked: ["slack_send_message"] });
  const names = (tools: Array<{ exposedName: string }>) => tools.map((t) => t.exposedName).sort();
  const plain = reach([]);
  assert.deepEqual(names(plain.catalog), ["data-mcp__lookup", "other__lookup", "slack_read_thread", "slack_search_public_and_private"], "all read-only reach; shared names get <server>__");
  assert.deepEqual(names(plain.direct), ["data-mcp__lookup", "other__lookup", "slack_read_thread"], "shown directly: main's active ones");
  const listed = reach(["slack_send_message", "data-mcp/write_row"]);
  assert.ok(names(listed.catalog).includes("write_row") && names(listed.direct).includes("write_row"), "a listed tool is reachable and shown");
  for (const r of [plain, listed]) assert.equal(r.catalog.some((t) => t.name === "slack_send_message"), false, "the send tool never, even marked read-only or listed");
  assert.deepEqual(helperMcpTools(undefined, active, ["x"], { blocked: [] }), { catalog: [], direct: [] });
});

test("the owner's own Slack server is private: its tools are reachable only when he lists them", () => {
  const active = new Set(["slack_read_thread"]);
  const names = (investigative: string[]) => helperMcpTools(cache, active, investigative, { blocked: ["slack_send_message"], privateServers: slackServers(cache, ["slack_read_thread", "slack_send_message"], undefined) }).catalog.map((t) => t.name).sort();
  assert.deepEqual(names([]), ["lookup", "lookup"], "no Slack search or reads by default");
  assert.deepEqual(names(["slack/slack_read_thread"]), ["lookup", "lookup", "slack_read_thread"]);
  assert.deepEqual(slackServers(cache, ["x"], "configured"), ["configured"]);
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
  writeFileSync(join(dir, "failed.json"), JSON.stringify({ version: 1, servers: { slack: { tools: [], discoveryFailed: true } } }));
  const failed = readMcpCache(join(dir, "failed.json"));
  assert.equal(failed!.has("slack"), false, "a server whose discovery failed is not listed yet");
  assert.deepEqual(missingSlackTools(failed, ["slack_read_thread"], "slack"), [], "so its tool names are not judged");
  writeFileSync(join(dir, "broken.json"), "{");
  assert.throws(() => readMcpCache(join(dir, "broken.json")));
  writeFileSync(join(dir, "shape.json"), JSON.stringify({ version: 2, tools: [] }));
  assert.throws(() => readMcpCache(join(dir, "shape.json")), /no "servers" object/);
});
