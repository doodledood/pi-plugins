// simple-statusline's cost figures inside a real Pi runtime, measured against Pi's own
// accounting. The provider is a local HTTP server speaking the OpenAI Responses stream;
// the agent directory, HOME and session files live in a temporary directory per test.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { analyzeSessionTree } from "./cost-report.ts";

process.env.PI_OFFLINE ??= "1";

// Pi's per-key cost breakdown is what its own session view sums. It is not exported
// from the package root, so load it from the installed module beside the entry point.
const { getUsageCostBreakdown } = (await import(
  new URL("./core/usage-totals.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as { getUsageCostBreakdown(entries: unknown[]): Array<{ key: string; cost: number }> };

const STATUSLINE_PATH = new URL("../simple-statusline.ts", import.meta.url).pathname;
const GPT_FAST_PATH = new URL("../../../gpt-fast-toggle/extensions/gpt-fast-toggle.ts", import.meta.url).pathname;
// gpt-5.6-sol: $4 per million input tokens, priority billed at twice that.
const MODEL = "gpt-5.6-sol";
const INPUT_TOKENS = 100_000;

interface Hit {
  body: Record<string, any>;
}

function responsesSse(serviceTier: string | undefined): string {
  const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
  const response = {
    id: "resp_1",
    object: "response",
    status: "completed",
    model: MODEL,
    output: [message],
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    usage: { input_tokens: INPUT_TOKENS, output_tokens: 0, total_tokens: INPUT_TOKENS, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Bills each request at the tier the request asked for, as OpenAI does. */
async function openaiServer(hits: Hit[]): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      hits.push({ body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(responsesSse(body.service_tier));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, server };
}

interface PiHome {
  dir: string;
  agentDir: string;
  cwd: string;
  sessionDir: string;
}

async function withPiHome<T>(files: { modelsJson: unknown; agentFiles?: Record<string, unknown> }, run: (home: PiHome) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "simple-statusline-real-pi-"));
  const home = join(dir, "home");
  // The agent directory sits where Pi puts it by default, so an extension that resolves
  // it from HOME and one that honours PI_CODING_AGENT_DIR both land in the temp tree.
  const agentDir = join(home, ".pi", "agent");
  const cwd = join(dir, "workspace");
  const sessionDir = join(dir, "sessions");
  for (const path of [agentDir, cwd, sessionDir]) mkdirSync(path, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(files.modelsJson));
  for (const [name, value] of Object.entries(files.agentFiles ?? {})) writeFileSync(join(agentDir, name), JSON.stringify(value));
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_AGENT_HOME: process.env.PI_AGENT_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
  process.env.OPENAI_API_KEY = "sk-test";
  try {
    return await run({ dir, agentDir, cwd, sessionDir });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const plainTheme = { fg: (_tone: string, text: string) => text, bg: (_tone: string, text: string) => text, bold: (text: string) => text };
const footerData = { getGitBranch: () => "main", getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} };

/** A UI that records the footer and notices; every other UI call is inert. */
function recordingUi() {
  const ui = { footer: undefined as any, notices: [] as string[] };
  const inert = () => undefined;
  const context: Record<string, unknown> = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
    onTerminalInput: () => inert,
    getEditorText: () => "",
    getEditorComponent: inert,
    getToolsExpanded: () => false,
    getAllThemes: () => [],
    getTheme: inert,
    setTheme: () => ({ success: false }),
    theme: plainTheme,
    setFooter(factory: any) {
      ui.footer = factory;
    },
    notify(message: string) {
      ui.notices.push(message);
    },
  };
  for (const name of ["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"]) {
    context[name] = inert;
  }
  return { ui, context };
}

async function startSession(home: PiHome, extensionPaths: string[]) {
  const settingsManager = SettingsManager.create(home.cwd, home.agentDir);
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd: home.cwd,
    agentDir: home.agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getAllModels().find((m) => m.provider === "openai" && m.id === MODEL);
  assert.ok(model, `${MODEL} is in Pi's catalog`);
  const { session } = await createAgentSession({
    cwd: home.cwd,
    agentDir: home.agentDir,
    sessionManager: SessionManager.create(home.cwd, home.sessionDir),
    settingsManager,
    modelRuntime,
    resourceLoader: loader,
    model: model as never,
    tools: [],
  });
  const { ui, context } = recordingUi();
  await session.bindExtensions({ uiContext: context as never });
  return { session, ui };
}

function footerCost(ui: { footer: any }): string {
  assert.ok(ui.footer, "simple-statusline installed its footer");
  const line = ui.footer({ requestRender() {} }, plainTheme, footerData).render(400)[0] as string;
  const match = line.match(/~?\$\d+\.\d+/);
  assert.ok(match, `footer shows a cost: ${line}`);
  return match[0];
}

async function costReport(session: any, ui: { notices: string[] }): Promise<{ lifetime: string; branch: string }> {
  ui.notices.length = 0;
  await session.prompt("/cost");
  const report = ui.notices.join("\n");
  const lifetime = report.match(/Session tree lifetime cost: (~?\$\d+\.\d+)/)?.[1];
  const branch = report.match(/the active branch alone: (\$\d+\.\d+)/)?.[1];
  assert.ok(lifetime && branch, `the /cost report carries both figures:\n${report}`);
  return { lifetime, branch };
}

const piTotal = (entries: unknown[]) => getUsageCostBreakdown(entries).reduce((sum, row) => sum + row.cost, 0);
const dollars = (value: number) => `$${value.toFixed(3)}`;

test("a priority turn is priced once: footer, /cost and active branch equal Pi's own total", { timeout: 20_000 }, async () => {
  const hits: Hit[] = [];
  const provider = await openaiServer(hits);
  try {
    await withPiHome(
      {
        modelsJson: { providers: { openai: { baseUrl: provider.url } } },
        // An existing user's state file from before the fix still names a premium.
        agentFiles: { "gpt-fast-toggle.json": { mode: "fast", priorityMultiplier: 2 } },
      },
      async (home) => {
        const { session, ui } = await startSession(home, [GPT_FAST_PATH, STATUSLINE_PATH]);
        await session.prompt("hello");
        assert.equal(hits.at(-1)?.body.service_tier, "priority", "gpt-fast-toggle asked for priority");

        const entries = session.sessionManager.getEntries();
        const pi = piTotal(entries);
        assert.ok(Math.abs(pi - 0.8) < 1e-9, `pi-ai already priced the premium in: ${pi}`);

        assert.equal(footerCost(ui), dollars(pi), "the footer counts the premium once");
        const report = await costReport(session, ui);
        assert.equal(report.lifetime, dollars(pi), "/cost counts the premium once");
        assert.equal(report.branch, dollars(pi), "the active branch counts the premium once");
        assert.equal(analyzeSessionTree(session.sessionManager.getSessionFile()!).totalCost, piTotal(SessionManager.open(session.sessionManager.getSessionFile()!).getEntries()), "and so does the figure read back from disk");
        await session.dispose?.();
      },
    );
  } finally {
    provider.server.close();
  }
});

test("price-tier records left in a session by older versions are not applied again", { timeout: 20_000 }, async () => {
  const hits: Hit[] = [];
  const provider = await openaiServer(hits);
  try {
    await withPiHome({ modelsJson: { providers: { openai: { baseUrl: provider.url } } } }, async (home) => {
      const { session, ui } = await startSession(home, [STATUSLINE_PATH]);
      // What an older gpt-fast-toggle wrote: the tier and a premium, ahead of a priority turn.
      session.sessionManager.appendCustomEntry("pi-price-tier", { tier: "priority", multiplier: 2 });
      await session.prompt("hello");

      const pi = piTotal(session.sessionManager.getEntries());
      assert.equal(footerCost(ui), dollars(pi));
      const report = await costReport(session, ui);
      assert.equal(report.lifetime, dollars(pi));
      assert.equal(report.branch, dollars(pi));
      await session.dispose?.();
    });
  } finally {
    provider.server.close();
  }
});

test("Pi's usage entries are billed: footer, /cost and active branch equal Pi's total in memory and on disk", { timeout: 20_000 }, async () => {
  const hits: Hit[] = [];
  const provider = await openaiServer(hits);
  try {
    await withPiHome({ modelsJson: { providers: { openai: { baseUrl: provider.url } } } }, async (home) => {
      const { session, ui } = await startSession(home, [STATUSLINE_PATH]);
      await session.prompt("hello");
      // What Pi's cache warmer writes after a warming call: a usage entry, not a message.
      const usage = { input: 0, output: 1, cacheRead: 250_000, cacheWrite: 0, totalTokens: 250_001, cost: { input: 0, output: 0, cacheRead: 0.1, cacheWrite: 0, total: 0.1 } };
      session.sessionManager.appendUsage("cache_warm", "openai", MODEL, usage as never);

      const inMemory = piTotal(session.sessionManager.getEntries());
      assert.ok(Math.abs(inMemory - 0.5) < 1e-9, `the turn and the warming call: ${inMemory}`);
      const report = await costReport(session, ui);
      assert.equal(report.lifetime, dollars(inMemory), "/cost includes the warming call");
      assert.equal(report.branch, dollars(inMemory), "the active branch includes the warming call");
      assert.equal(footerCost(ui), dollars(inMemory), "the footer includes the warming call");

      const file = session.sessionManager.getSessionFile()!;
      const onDisk = piTotal(SessionManager.open(file).getEntries());
      assert.ok(Math.abs(onDisk - inMemory) < 1e-9, "Pi reads the same total back from disk");
      assert.ok(Math.abs(analyzeSessionTree(file).totalCost - onDisk) < 1e-9, "and so does the statusline");
      await session.dispose?.();
    });
  } finally {
    provider.server.close();
  }
});
