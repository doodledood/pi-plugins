// Behavioral tests that drive the real event handlers in index.ts through a typed mock
// (LoadoutPi) — no casts, no `any`. Covers AC-2.2, AC-3.2, and INV-G4 (catalog stability).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { activate } from "./index.ts";
import type { LoadoutCtx, LoadoutHandlerMap, LoadoutPi } from "./host.ts";
import { estimateTokens } from "./select.ts";
import { mcpTool, builtinTool, ourTool, tmpDir, writeJson } from "./testutil.ts";

class MockPi implements LoadoutPi {
  active: string[];
  readonly setActiveCalls: string[][] = [];
  readonly handlers: Partial<LoadoutHandlerMap> = {};
  constructor(private readonly tools: ToolInfo[], active: string[] = []) {
    this.active = active;
  }
  on<E extends keyof LoadoutHandlerMap>(event: E, handler: LoadoutHandlerMap[E]): void {
    this.handlers[event] = handler;
  }
  getAllTools(): ToolInfo[] {
    return this.tools;
  }
  getActiveTools(): string[] {
    return this.active;
  }
  setActiveTools(names: string[]): void {
    this.active = names;
    this.setActiveCalls.push(names);
  }
}

const ctx: LoadoutCtx = { cwd: "/proj", ui: { setStatus() {} } };

function writeCache(dir: string): void {
  writeJson(join(dir, "mcp-cache.json"), {
    version: 1,
    servers: {
      alpha_mcp: { tools: [{ name: "a" }, { name: "b" }] },
      chat: { tools: [{ name: "x" }] },
      warehouse_mcp: { tools: [{ name: "q", description: "runs a query" }] },
    },
  });
}

function fixtureTools(): { tools: ToolInfo[]; alpha_mcpBig: ToolInfo; alpha_mcpSmall: ToolInfo; chat: ToolInfo } {
  const alpha_mcpBig = mcpTool("alpha_a", "alpha tool", 20);
  const alpha_mcpSmall = mcpTool("alpha_b", "beta tool", 0);
  const chat = mcpTool("chat_x", "x tool", 0);
  const tools = [
    builtinTool("read"),
    builtinTool("bash"),
    ourTool("load_tools"),
    mcpTool("mcp", "proxy"),
    alpha_mcpBig,
    alpha_mcpSmall,
    chat,
  ];
  return { tools, alpha_mcpBig, alpha_mcpSmall, chat };
}

test("session_start gates once: keeps all non-MCP + infra, drops over-budget MCP", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  const { tools, alpha_mcpSmall, chat } = fixtureTools();
  const budget = estimateTokens(alpha_mcpSmall) + estimateTokens(chat); // excludes the big tool
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: true, budgetTokens: budget, prior: {} });

  const pi = new MockPi(tools, ["read", "bash"]);
  activate(pi);
  await pi.handlers.session_start?.(undefined, ctx);

  assert.equal(pi.setActiveCalls.length, 1, "setActiveTools called exactly once");
  const set = new Set(pi.setActiveCalls[0]);
  for (const must of ["read", "bash", "load_tools", "mcp", "alpha_b", "chat_x"]) {
    assert.ok(set.has(must), `${must} must be active`);
  }
  assert.ok(!set.has("alpha_a"), "over-budget MCP tool must be dormant");
});

test("before_agent_start appends a byte-identical catalog across turns (INV-G4 / AC-2.2)", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: true, prior: {} });

  const { tools } = fixtureTools();
  const pi = new MockPi(tools);
  activate(pi);
  await pi.handlers.session_start?.(undefined, ctx);

  const r1 = await pi.handlers.before_agent_start?.({ systemPrompt: "BASE-ONE" }, ctx);
  const r2 = await pi.handlers.before_agent_start?.({ systemPrompt: "BASE-TWO" }, ctx);
  const cat1 = r1 && r1.systemPrompt ? r1.systemPrompt.slice("BASE-ONE".length) : "";
  const cat2 = r2 && r2.systemPrompt ? r2.systemPrompt.slice("BASE-TWO".length) : "";

  assert.ok(cat1.includes("MCP tool catalog"), "catalog injected");
  assert.equal(cat1, cat2, "appended catalog must be byte-identical across turns");
  assert.ok(r1?.systemPrompt?.startsWith("BASE-ONE"), "original system prompt preserved");
});

test("disabled config makes no gating change and injects no catalog", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: false });

  const { tools } = fixtureTools();
  const pi = new MockPi(tools);
  activate(pi);
  await pi.handlers.session_start?.(undefined, ctx);
  assert.equal(pi.setActiveCalls.length, 0, "no gating when disabled");

  const r = await pi.handlers.before_agent_start?.({ systemPrompt: "BASE" }, ctx);
  assert.equal(r, undefined, "no catalog injected when disabled");
});
