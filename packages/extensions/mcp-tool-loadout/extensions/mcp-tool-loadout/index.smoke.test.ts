import { test } from "node:test";
import assert from "node:assert/strict";

test("index module loads and default-exports a factory function", async () => {
  const mod = await import("./index.ts");
  assert.equal(typeof mod.default, "function");
  // Factory takes a single argument (the Pi ExtensionAPI).
  assert.equal(mod.default.length, 1);
});
