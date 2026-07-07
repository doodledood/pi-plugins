import { test } from "node:test";
import assert from "node:assert/strict";
import { performCacheSafeLoadTools, resolveLoadTools, performLoadTools, type ToolHost } from "./actions.ts";

test("resolveLoadTools splits loadable vs unknown and unions active", () => {
  const out = resolveLoadTools(["a", "x"], new Set(["a", "read"]), ["read"]);
  assert.deepEqual(out.loadable, ["a"]);
  assert.deepEqual(out.unknown, ["x"]);
  assert.deepEqual(out.nextActive, ["read", "a"]);
  assert.match(out.message, /Loaded: a\./);
  assert.match(out.message, /No registered schema available.*x/);
});

test("resolveLoadTools handles empty request", () => {
  const out = resolveLoadTools([], new Set(["a"]), ["read"]);
  assert.deepEqual(out.loadable, []);
  assert.deepEqual(out.nextActive, ["read"]);
  assert.match(out.message, /No tool names provided\./);
});

function mockHost(known: string[], active: string[]): { host: ToolHost; calls: string[][] } {
  const calls: string[][] = [];
  const host: ToolHost = {
    getAllTools: () => known.map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names) => calls.push(names),
  };
  return { host, calls };
}

test("performLoadTools activates the union when something is loadable", () => {
  const { host, calls } = mockHost(["alpha_a", "read"], ["read", "mcp"]);
  const out = performLoadTools(host, ["alpha_a"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["read", "mcp", "alpha_a"]);
  assert.deepEqual(out.loadable, ["alpha_a"]);
});

test("performLoadTools does not call setActiveTools when nothing is loadable", () => {
  const { host, calls } = mockHost(["read"], ["read"]);
  const out = performLoadTools(host, ["ghost"]);
  assert.equal(calls.length, 0);
  assert.deepEqual(out.unknown, ["ghost"]);
});

test("performCacheSafeLoadTools returns schemas and proxy examples without changing active tools", () => {
  const calls: string[][] = [];
  const host: ToolHost = {
    getAllTools: () => [
      {
        name: "alpha_a",
        description: "alpha tool",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
      { name: "mcp", description: "proxy", parameters: {} },
    ],
    getActiveTools: () => ["mcp"],
    setActiveTools: (names) => calls.push(names),
  };

  const out = performCacheSafeLoadTools(host, ["alpha_a"]);
  assert.equal(calls.length, 0, "default cache-safe load must not mutate the active tool set");
  assert.deepEqual(out.nextActive, ["mcp"], "active tool set stays unchanged");
  assert.deepEqual(out.loadable, ["alpha_a"]);
  assert.match(out.message, /Cache-safe load/);
  assert.match(out.message, /"name": "alpha_a"/);
  assert.match(out.message, /mcp\(\{ tool: "alpha_a", args:/);
  assert.ok(out.message.includes('args: "{\\"q\\":\\"...\\"}"'), "proxy example carries JSON-string args");
});
