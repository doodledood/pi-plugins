import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLoadTools, performLoadTools, type ToolHost } from "./actions.ts";

test("resolveLoadTools splits loadable vs unknown and unions active", () => {
  const out = resolveLoadTools(["a", "x"], new Set(["a", "read"]), ["read"]);
  assert.deepEqual(out.loadable, ["a"]);
  assert.deepEqual(out.unknown, ["x"]);
  assert.deepEqual(out.nextActive, ["read", "a"]);
  assert.match(out.message, /Loaded: a\./);
  assert.match(out.message, /Not directly loadable.*x/);
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
