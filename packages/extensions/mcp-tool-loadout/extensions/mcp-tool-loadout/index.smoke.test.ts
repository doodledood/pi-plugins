import { test } from "node:test";
import assert from "node:assert/strict";

test("index module loads and default-exports a factory function", async () => {
  const mod = await import("./index.ts");
  assert.equal(typeof mod.default, "function");
  // Factory takes a single argument (the Pi ExtensionAPI).
  assert.equal(mod.default.length, 1);
});

test("registered load_tools defaults to cache-safe schemas and keeps hard activation explicit", async () => {
  const mod = await import("./index.ts");
  const registered: any[] = [];
  const setActiveCalls: string[][] = [];
  const pi = {
    registerTool(definition: any) {
      registered.push(definition);
    },
    on() {},
    getAllTools() {
      return [
        {
          name: "alpha_a",
          description: "alpha tool",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
        { name: "mcp", description: "proxy", parameters: {} },
      ];
    },
    getActiveTools() {
      return ["mcp"];
    },
    setActiveTools(names: string[]) {
      setActiveCalls.push(names);
    },
  };

  mod.default(pi as any);
  const tool = registered.find((definition) => definition.name === "load_tools");
  assert.ok(tool, "load_tools registered");

  const soft = await tool.execute("call-1", { names: ["alpha_a"] });
  assert.equal(setActiveCalls.length, 0, "default path does not mutate active tools");
  assert.equal(soft.details.direct, false);
  assert.match(soft.content[0].text, /Cache-safe load/);
  assert.match(soft.content[0].text, /mcp\(\{ tool: "alpha_a"/);

  const hard = await tool.execute("call-2", { names: ["alpha_a"], direct: true });
  assert.equal(setActiveCalls.length, 1, "direct:true is the hard-activation escape hatch");
  assert.deepEqual(setActiveCalls[0], ["mcp", "alpha_a"]);
  assert.equal(hard.details.direct, true);
});
