// mcp-tool-loadout inside a real Pi session: request bodies are captured from a local
// Anthropic-compatible server, with a stand-in pi-mcp-adapter and a second extension that
// deactivates one tool at start and adds another mid-session (as pi-web-access does).
// The agent directory, HOME and config live in a temporary directory per run.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

process.env.PI_OFFLINE ??= "1";

const LOADOUT_PATH = new URL("./index.ts", import.meta.url).pathname;
const MODEL = "claude-opus-5-5";
const PARAMS = `{ type: "object", properties: { q: { type: "string", description: "${"query text ".repeat(20)}" } } }`;

const SSE = [
  ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", { type: "message_stop" }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

const ADAPTER = `export default function (pi) {
  const tool = (name) => pi.registerTool({ name, label: name, description: name + " tool", parameters: ${PARAMS}, async execute() { return { content: [{ type: "text", text: "ok" }] }; } });
  for (const name of ["mcp", "alpha_one", "alpha_two", "alpha_three"]) tool(name);
}
`;

const OTHER = `export default function (pi) {
  globalThis.__loadoutTestOtherPi = pi;
  pi.registerTool({ name: "web_search", label: "web_search", description: "search", parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } });
  pi.on("session_start", () => pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "web_search")));
}
`;

interface RunResult {
  bodies: Array<Record<string, any>>;
  activeAfterStart: string[];
}

async function run(loadoutEnabled: boolean): Promise<RunResult> {
  const bodies: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "loadout-real-pi-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  for (const sub of [agentDir, cwd, join(dir, "home"), join(dir, "pi-mcp-adapter")]) mkdirSync(sub, { recursive: true });
  writeFileSync(join(dir, "pi-mcp-adapter", "index.ts"), ADAPTER);
  writeFileSync(join(dir, "other.ts"), OTHER);
  writeFileSync(join(agentDir, "mcp-tool-loadout.json"), JSON.stringify({ enabled: loadoutEnabled, budgetTokens: 150, prior: {} }));
  writeFileSync(join(agentDir, "mcp-cache.json"), JSON.stringify({ servers: { alpha: { tools: [{ name: "one" }, { name: "two" }, { name: "three" }] }, beta: { tools: [{ name: "proxyonly" }] } } }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` } } }));
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.HOME = join(dir, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(dir, "pi-mcp-adapter", "index.ts"), join(dir, "other.ts"), LOADOUT_PATH],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create();
    const { session } = await createAgentSession({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd), settingsManager, modelRuntime, resourceLoader: loader });
    try {
      await session.setModel(modelRuntime.getModel("anthropic", MODEL)!);
      await session.bindExtensions({});
      const activeAfterStart = [...session.getActiveToolNames()].sort();
      await session.prompt("first");
      // Another extension adds a tool mid-session.
      const other = (globalThis as { __loadoutTestOtherPi?: any }).__loadoutTestOtherPi;
      other.registerTool({ name: "late_tool", label: "late_tool", description: "late", parameters: { type: "object", properties: {} }, async execute() { return { content: [] }; } });
      other.setActiveTools([...other.getActiveTools(), "late_tool"]);
      await session.prompt("second");
      return { bodies, activeAfterStart };
    } finally {
      session.dispose();
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const withoutCacheMarkers = (value: unknown): string =>
  JSON.stringify(value ?? null, (key, inner) => (key === "cache_control" ? undefined : inner));

function assertPrefixKept(bodies: Array<Record<string, any>>): void {
  assert.equal(bodies.length, 2);
  const [before, after] = bodies as [Record<string, any>, Record<string, any>];
  assert.equal(withoutCacheMarkers(after.system), withoutCacheMarkers(before.system), "system unchanged");
  assert.equal(withoutCacheMarkers(after.tools), withoutCacheMarkers(before.tools), "request-level tools unchanged");
  assert.equal(
    withoutCacheMarkers(after.messages.slice(0, before.messages.length)),
    withoutCacheMarkers(before.messages),
    "earlier messages unchanged",
  );
  assert.ok(withoutCacheMarkers(after.messages).includes("late_tool"), "the added tool reaches the model");
}

const mcpTools = new Set(["mcp", "alpha_one", "alpha_two", "alpha_three"]);

test("a mid-session tool addition keeps the cached request prefix with the loadout on, as with it off", { timeout: 30_000 }, async () => {
  const control = await run(false);
  assertPrefixKept(control.bodies);
  const loadout = await run(true);
  assert.ok(withoutCacheMarkers(loadout.bodies[0]!.system).includes("MCP tool catalog"), "the catalog reaches the model");
  assertPrefixKept(loadout.bodies);
});

test("the loadout changes only MCP tools in the active set", { timeout: 30_000 }, async () => {
  const control = await run(false);
  const loadout = await run(true);
  const nonMcp = (names: string[]) => names.filter((name) => !mcpTools.has(name));
  assert.ok(!control.activeAfterStart.includes("web_search"), "control: the other extension deactivated web_search");
  assert.deepEqual(nonMcp(loadout.activeAfterStart), nonMcp(control.activeAfterStart));
  assert.ok(loadout.activeAfterStart.filter((name) => mcpTools.has(name)).length < mcpTools.size, "some MCP tools were gated");
});
