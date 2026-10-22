// Behavioral tests that drive the real event handlers in index.ts through a typed mock
// (LoadoutPi) — no casts, no `any`. Covers AC-2.2, AC-3.2, and INV-G4 (catalog stability).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

test("session_start gates once: keeps non-MCP + infra as they were, drops over-budget MCP", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  const { tools, alpha_mcpSmall, chat } = fixtureTools();
  const budget = estimateTokens(alpha_mcpSmall) + estimateTokens(chat); // excludes the big tool
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: true, budgetTokens: budget, prior: {} });

  const pi = new MockPi(tools, tools.map((t) => t.name));
  activate(pi);
  await pi.handlers.session_start?.(undefined, ctx);

  assert.equal(pi.setActiveCalls.length, 1, "setActiveTools called exactly once");
  const set = new Set(pi.setActiveCalls[0]);
  for (const must of ["read", "bash", "load_tools", "mcp", "alpha_b", "chat_x"]) {
    assert.ok(set.has(must), `${must} must be active`);
  }
  assert.ok(!set.has("alpha_a"), "over-budget MCP tool must be dormant");
});

test("before_agent_start sets a byte-identical catalog section across turns and loads", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: true, prior: {} });

  const { tools } = fixtureTools();
  const pi = new MockPi(tools);
  activate(pi);
  await pi.handlers.session_start?.(undefined, ctx);

  const run = async () => {
    const event = { systemPromptOptions: { sections: { other: "kept" } as Record<string, string> } };
    const result = await pi.handlers.before_agent_start?.(event, ctx);
    assert.equal(result, undefined, "no forced system prompt");
    assert.equal(event.systemPromptOptions.sections.other, "kept", "other sections untouched");
    return event.systemPromptOptions.sections.mcp_tool_catalog ?? "";
  };
  const cat1 = await run();
  const cat2 = await run();

  assert.ok(cat1.includes("MCP tool catalog"), "catalog injected");
  assert.equal(cat1, cat2, "catalog section must be byte-identical across turns");

  // Even if a later explicit hard load mutates the active tool set, this extension
  // must not regenerate the session catalog mid-session and churn the cached prefix.
  pi.setActiveTools([...pi.getActiveTools(), "alpha_a"]);
  assert.equal(await run(), cat1, "catalog stays byte-identical after load-like active-set changes");
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

  const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
  await pi.handlers.before_agent_start?.(event, ctx);
  assert.deepEqual(event.systemPromptOptions.sections, {}, "no catalog injected when disabled");
});

/**
 * Every stored event's tool name, read straight from disk in either storage format: the
 * usage log, or the whole-file stats an older version wrote (and the log imports once).
 */
function usageNames(dir: string): string[] {
  const names: string[] = [];
  const log = join(dir, "mcp-tool-loadout-usage.jsonl");
  if (existsSync(log)) {
    for (const line of readFileSync(log, "utf8").split("\n")) {
      try {
        const parsed = JSON.parse(line) as { n?: unknown };
        if (typeof parsed.n === "string") names.push(parsed.n);
      } catch {
        // torn line
      }
    }
  }
  const legacy = join(dir, "mcp-tool-loadout-stats.json");
  if (existsSync(legacy)) {
    const parsed = JSON.parse(readFileSync(legacy, "utf8")) as { projects: Record<string, Array<{ name: string }>> };
    for (const events of Object.values(parsed.projects)) names.push(...events.map((event) => event.name));
  }
  return names.sort();
}

/** Pi ends a turn: run whatever turn_end handler the extension registered. */
async function endTurn(pi: MockPi): Promise<void> {
  await (pi.handlers as Record<string, ((event: unknown, ctx: LoadoutCtx) => unknown) | undefined>).turn_end?.({}, ctx);
}

test("two overlapping sessions both keep every event they record", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: true, prior: {} });
  const { tools } = fixtureTools();
  const a = new MockPi(tools, tools.map((t) => t.name));
  const b = new MockPi(tools, tools.map((t) => t.name));
  activate(a);
  activate(b);
  await a.handlers.session_start?.(undefined, ctx);
  await b.handlers.session_start?.(undefined, ctx);
  await a.handlers.tool_call?.({ toolName: "alpha_a", input: {} }, ctx);
  await endTurn(a);
  await b.handlers.tool_call?.({ toolName: "chat_x", input: {} }, ctx);
  await endTurn(b);
  await a.handlers.tool_call?.({ toolName: "mcp", input: { tool: "q" } }, ctx);
  await endTurn(a);
  assert.deepEqual(usageNames(dir), ["alpha_a", "chat_x", "q"]);
});

test("a stats file caught mid-write at session start never costs stored events", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: true, prior: {} });
  const stats = join(dir, "mcp-tool-loadout-stats.json");
  const full = JSON.stringify({ version: 1, projects: { other: Array.from({ length: 100 }, (_, i) => ({ name: "alpha_a", ts: Date.now() - i })) } });
  writeFileSync(stats, full.slice(0, full.length / 2)); // what a reader sees while another session writes
  const { tools } = fixtureTools();
  const pi = new MockPi(tools, tools.map((t) => t.name));
  activate(pi);
  const original = console.error;
  console.error = () => {};
  try {
    await pi.handlers.session_start?.(undefined, ctx);
  } finally {
    console.error = original;
  }
  writeFileSync(stats, full); // the other session's write completes
  await pi.handlers.tool_call?.({ toolName: "chat_x", input: {} }, ctx);
  await endTurn(pi);
  assert.equal(usageNames(dir).filter((n) => n === "alpha_a").length, 100, "every stored event survives");
  assert.ok(usageNames(dir).includes("chat_x"));
});

test("a torn last line in the usage log costs only that line", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: true, prior: {} });
  const now = Date.now();
  const stored = Array.from({ length: 100 }, (_, i) => JSON.stringify({ p: "other", n: "alpha_a", t: now - i })).join("\n");
  writeFileSync(join(dir, "mcp-tool-loadout-usage.jsonl"), `${stored}\n{"p":"other","n":"alp`);
  const { tools } = fixtureTools();
  const pi = new MockPi(tools, tools.map((t) => t.name));
  activate(pi);
  await pi.handlers.session_start?.(undefined, ctx);
  await pi.handlers.tool_call?.({ toolName: "chat_x", input: {} }, ctx);
  const { UsageLog } = await import("./stats.ts");
  const events = UsageLog.open(join(dir, "mcp-tool-loadout-usage.jsonl"), join(dir, "none.json")).allEvents();
  assert.equal(events.filter((e) => e.name === "alpha_a").length, 100);
  assert.ok(events.some((e) => e.name === "chat_x"), "the new event is not swallowed by the torn line");
});

test("only MCP tool calls are recorded", async () => {
  const dir = tmpDir();
  process.env.PI_CODING_AGENT_DIR = dir;
  writeCache(dir);
  writeJson(join(dir, "mcp-tool-loadout.json"), { enabled: true, prior: {} });
  const { tools } = fixtureTools();
  const pi = new MockPi(tools, tools.map((t) => t.name));
  activate(pi);
  await pi.handlers.session_start?.(undefined, ctx);
  for (const toolName of ["read", "bash", "load_tools", "alpha_b"]) {
    await pi.handlers.tool_call?.({ toolName, input: toolName === "load_tools" ? { names: ["alpha_a"] } : {} }, ctx);
  }
  await endTurn(pi);
  assert.deepEqual(usageNames(dir), ["alpha_a", "alpha_b"]);
});
