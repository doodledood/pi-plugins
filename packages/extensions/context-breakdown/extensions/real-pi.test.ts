// /context inside a real Pi runtime, against the requests Pi actually sends. The
// providers and Anthropic's count_tokens endpoint are one local HTTP server; the agent
// directory, HOME and sessions live in a temporary directory per test.
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

process.env.PI_OFFLINE ??= "1";

const EXTENSION_PATH = new URL("./context-breakdown.ts", import.meta.url).pathname;
const OPUS = "claude-opus-5-5";
const GPT = "gpt-5.6-sol";

interface Request {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
}

/** Deterministic stand-in for Anthropic's tokenizer: every part of the body counts. */
function fakeCount(body: Record<string, any>): number {
  let n = 3;
  if (body.system !== undefined) n += Math.ceil(JSON.stringify(body.system).length / 4);
  for (const t of body.tools ?? []) n += Math.ceil(JSON.stringify({ n: t.name, d: t.description, s: t.input_schema }).length / 4);
  for (const m of body.messages ?? []) n += Math.ceil(JSON.stringify(m).length / 4);
  return n;
}

function anthropicSse(text: string, inputTokens: number): string {
  return [
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: OPUS, content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function responsesSse(inputTokens: number): string {
  const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] };
  const response = { id: "resp_1", object: "response", status: "completed", model: GPT, output: [message], usage: { input_tokens: inputTokens, output_tokens: 0, total_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 } } };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...message, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: "ok" },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** One server for Anthropic messages, Anthropic count_tokens and OpenAI responses. */
async function providerServer(requests: Request[], usage: { anthropicInput: number; openaiInput: number }): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const path = req.url ?? "";
      requests.push({ path, headers: req.headers, body });
      if (path.endsWith("/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: fakeCount(body) }));
      } else if (path.endsWith("/responses")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(responsesSse(usage.openaiInput));
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(anthropicSse("ok", usage.anthropicInput));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

interface PiHome {
  agentDir: string;
  cwd: string;
  sessionDir: string;
  url: string;
  requests: Request[];
}

async function withPiHome<T>(
  options: { settings?: unknown; countTokensKey?: boolean; usage?: { anthropicInput?: number; openaiInput?: number } },
  run: (home: PiHome) => Promise<T>,
): Promise<T> {
  const requests: Request[] = [];
  const provider = await providerServer(requests, { anthropicInput: options.usage?.anthropicInput ?? 10, openaiInput: options.usage?.openaiInput ?? 10 });
  const dir = mkdtempSync(join(tmpdir(), "context-breakdown-real-pi-"));
  const home = join(dir, "home");
  // Pi's default location under HOME, so the agent directory is the same whether it is
  // found through PI_CODING_AGENT_DIR or through HOME.
  const agentDir = join(home, ".pi", "agent");
  const cwd = join(dir, "workspace");
  const sessionDir = join(dir, "sessions");
  for (const path of [agentDir, cwd, sessionDir]) mkdirSync(path, { recursive: true });
  // Pi authenticates the provider from models.json; the extension's count_tokens key is
  // the environment variable, set only when a test wants the exact path.
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { anthropic: { baseUrl: provider.url, apiKey: "sk-ant-provider" }, openai: { baseUrl: `${provider.url}/v1`, apiKey: "sk-openai" } } }),
  );
  if (options.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
  const keys = ["HOME", "PI_CODING_AGENT_DIR", "PI_AGENT_HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
  // Never let count_tokens leave the machine.
  process.env.ANTHROPIC_BASE_URL = provider.url;
  delete process.env.OPENAI_API_KEY;
  if (options.countTokensKey) process.env.ANTHROPIC_API_KEY = "sk-ant-count";
  else delete process.env.ANTHROPIC_API_KEY;
  try {
    return await run({ agentDir, cwd, sessionDir, url: provider.url, requests });
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    provider.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Overlay {
  data: {
    totalTokens: number;
    estimated: boolean;
    sourceLabel: string;
    window: number;
    categories: Array<{ label: string; tokens: number }>;
    mcpServers: Array<{ server: string; tokens: number; count: number }>;
    mcpToolCount: number;
    systemToolCount: number;
  };
}

function recordingUi() {
  const ui = { overlays: [] as Overlay[], notices: [] as string[] };
  const inert = () => undefined;
  const theme = { fg: (_tone: string, text: string) => text, bg: (_tone: string, text: string) => text, bold: (text: string) => text };
  const context: Record<string, unknown> = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    async custom(factory: any) {
      ui.overlays.push(await factory({ requestRender() {} }, theme, {}, inert));
      return undefined;
    },
    onTerminalInput: () => inert,
    getEditorText: () => "",
    getEditorComponent: inert,
    getToolsExpanded: () => false,
    getAllThemes: () => [],
    getTheme: inert,
    setTheme: () => ({ success: false }),
    theme,
    notify(message: string) {
      ui.notices.push(message);
    },
  };
  for (const name of ["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"]) {
    context[name] = inert;
  }
  return { ui, context };
}

async function startSession(home: PiHome, model: { provider: string; id: string }, tools = ["read"]) {
  const settingsManager = SettingsManager.create(home.cwd, home.agentDir);
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd: home.cwd,
    agentDir: home.agentDir,
    settingsManager,
    additionalExtensionPaths: [EXTENSION_PATH],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create();
  const find = (provider: string, id: string) => {
    const found = modelRuntime.getAllModels().find((m) => m.provider === provider && m.id === id);
    assert.ok(found, `${provider}/${id} is in Pi's catalog`);
    return found as never;
  };
  const { session } = await createAgentSession({
    cwd: home.cwd,
    agentDir: home.agentDir,
    sessionManager: SessionManager.create(home.cwd, home.sessionDir),
    settingsManager,
    modelRuntime,
    resourceLoader: loader,
    model: find(model.provider, model.id),
    tools,
  });
  const { ui, context } = recordingUi();
  await session.bindExtensions({ uiContext: context as never });
  return { session, ui, find };
}

async function runContext(session: any, ui: { overlays: Overlay[] }): Promise<Overlay["data"]> {
  ui.overlays.length = 0;
  await session.prompt("/context");
  const overlay = ui.overlays.at(-1);
  assert.ok(overlay, "/context opened its overlay");
  return overlay.data;
}

const category = (data: Overlay["data"], label: string) => data.categories.find((c) => c.label.startsWith(label))?.tokens ?? Number.NaN;
const providerRequests = (home: PiHome) => home.requests.filter((r) => !r.path.endsWith("/count_tokens"));
const countRequests = (home: PiHome) => home.requests.filter((r) => r.path.endsWith("/count_tokens"));

// ── AC-6.1 ──────────────────────────────────────────────────────────────────

test("Anthropic: mid-conversation system messages are counted, and Pi's deferred placeholder is Pi's own tool", { timeout: 30_000 }, async () => {
  await withPiHome({ countTokensKey: true }, async (home) => {
    const { session, ui } = await startSession(home, { provider: "anthropic", id: OPUS });
    await session.prompt("first");
    // A tool activated mid-session reaches opus-5-5 as a role:"system" tool_addition.
    session.setActiveToolsByName(["read", "bash"]);
    await session.prompt("second");
    const sent = providerRequests(home).at(-1)!.body;
    assert.ok(sent.messages.some((m: any) => m.role === "system"), "Pi sent a mid-conversation system message");
    assert.ok(sent.tools.some((t: any) => t.name === "__pi_deferred_placeholder__"), "and its deferred placeholder");

    const before = countRequests(home).length;
    const data = await runContext(session, ui);
    assert.equal(data.estimated, false, data.sourceLabel);
    assert.equal(data.totalTokens, fakeCount(sent), "the total is what the request sent");
    const sum = ["System prompt", "System tools", "MCP tools", "Messages"].reduce((s, label) => s + category(data, label), 0);
    assert.equal(sum, data.totalTokens, "the categories add up to it");
    assert.deepEqual(data.mcpServers, [], "the placeholder is not an MCP server");
    assert.equal(data.mcpToolCount, 0);
    // The SDK sends the payload's betas as the anthropic-beta header; count_tokens must too.
    const sentBetas = String(providerRequests(home).at(-1)!.headers["anthropic-beta"] ?? "").split(",").filter(Boolean);
    assert.ok(sentBetas.length > 0, "the request carried betas");
    for (const call of countRequests(home).slice(before)) {
      const counted = String(call.headers["anthropic-beta"] ?? "").split(",").filter(Boolean);
      assert.deepEqual(counted.filter((b) => !sentBetas.includes(b)), [], "count_tokens sends no beta the request did not");
      assert.ok(sentBetas.filter((b) => !counted.includes(b)).every((b) => !/mid-conversation|inline-tools/.test(b)), `count_tokens keeps the request's message betas: ${counted}`);
    }
    await session.dispose?.();
  });
});

// ── AC-6.2 ──────────────────────────────────────────────────────────────────

test("OpenAI: Messages is non-zero and the total agrees with Pi's context usage", { timeout: 30_000 }, async () => {
  await withPiHome({ usage: { openaiInput: 12_000 } }, async (home) => {
    const { session, ui } = await startSession(home, { provider: "openai", id: GPT });
    await session.prompt("hello there");
    const usage = session.getContextUsage();
    assert.ok(usage?.tokens, "Pi knows the context size");
    const data = await runContext(session, ui);
    assert.ok(category(data, "Messages") > 0, `Messages: ${category(data, "Messages")}`);
    assert.equal(data.totalTokens, usage.tokens);
    assert.ok(data.estimated, "the split is labelled as estimated");
    await session.dispose?.();
  });
});

test("OpenAI: a total smaller than the estimated system prompt and tools still comes from Pi, with Messages kept", { timeout: 30_000 }, async () => {
  await withPiHome({ usage: { openaiInput: 300 } }, async (home) => {
    const { session, ui } = await startSession(home, { provider: "openai", id: GPT });
    await session.prompt("hello there");
    const usage = session.getContextUsage();
    assert.equal(usage?.tokens, 300, "Pi's context size is the 300 input tokens the provider reported");
    const data = await runContext(session, ui);
    assert.equal(data.totalTokens, usage!.tokens, "the total fell back to the estimate");
    assert.ok(category(data, "Messages") > 0, `Messages: ${category(data, "Messages")}`);
    await session.dispose?.();
  });
});

// ── AC-6.3 ──────────────────────────────────────────────────────────────────

const MARKER = "STALE-CONTEXT-MARKER ";

test("after /compact, /context never shows the pre-compaction request", { timeout: 30_000 }, async () => {
  await withPiHome({ countTokensKey: true, settings: { compaction: { keepRecentTokens: 1 } } }, async (home) => {
    const { session, ui } = await startSession(home, { provider: "anthropic", id: OPUS });
    await session.prompt(MARKER.repeat(2000));
    await session.prompt("short follow-up");
    const before = await runContext(session, ui);
    await session.compact();
    const mark = countRequests(home).length;
    const after = await runContext(session, ui);
    for (const call of countRequests(home).slice(mark)) {
      assert.ok(!JSON.stringify(call.body).includes(MARKER), "nothing compacted away is counted");
    }
    assert.ok(after.totalTokens < before.totalTokens, `${after.totalTokens} < ${before.totalTokens}`);
    assert.ok(after.estimated, "messages are estimated until the next request, and say so");
    await session.dispose?.();
  });
});

test("after /tree, /context never shows the abandoned branch's request", { timeout: 30_000 }, async () => {
  await withPiHome({ countTokensKey: true }, async (home) => {
    const { session, ui } = await startSession(home, { provider: "anthropic", id: OPUS });
    await session.prompt("short start");
    const target = session.sessionManager.getLeafId();
    await session.prompt(MARKER.repeat(2000));
    const result = await session.navigateTree(target!, { summarize: false });
    assert.equal(result.cancelled, false);
    const mark = countRequests(home).length;
    const data = await runContext(session, ui);
    for (const call of countRequests(home).slice(mark)) {
      assert.ok(!JSON.stringify(call.body).includes(MARKER), "nothing from the abandoned branch is counted");
    }
    assert.ok(category(data, "Messages") > 0, "the branch navigated to still has messages");
    assert.ok(category(data, "Messages") < 1000, `Messages: ${category(data, "Messages")}`);
    await session.dispose?.();
  });
});

test("after switching provider, count_tokens uses the current model and estimates are disclosed", { timeout: 30_000 }, async () => {
  await withPiHome({ countTokensKey: true }, async (home) => {
    const { session, ui, find } = await startSession(home, { provider: "openai", id: GPT });
    await session.prompt("hello from gpt");
    await session.setModel(find("anthropic", OPUS));
    const mark = countRequests(home).length;
    const data = await runContext(session, ui);
    const calls = countRequests(home).slice(mark);
    assert.ok(calls.length > 0, "the current model is Anthropic, so tokens are counted");
    for (const call of calls) assert.equal(call.body.model, OPUS, "never the previous provider's model");
    assert.ok(data.estimated, "the messages part is an estimate until the next request");
    assert.match(data.sourceLabel, /estimat/);
    await session.dispose?.();
  });
});

/** A valid, incompressible PNG: random RGB noise, so its base64 is hundreds of KB. */
function noisePng(size: number): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 3 + 1));
  let seed = 7;
  for (let i = 0; i < rows.length; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    rows[i] = i % (size * 3 + 1) === 0 ? 0 : seed >>> 24;
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  return png.toString("base64");
}

// ── AC-6.4 ──────────────────────────────────────────────────────────────────

test("estimates count an image as an image, and the reserve follows Pi's compaction settings for the model", { timeout: 30_000 }, async () => {
  const settings = { compaction: { reserveTokens: 1000, modelOverrides: { [`anthropic/${OPUS}`]: { reserveTokens: 7777 } } } };
  await withPiHome({ settings }, async (home) => {
    const { session, ui } = await startSession(home, { provider: "anthropic", id: OPUS });
    const png = noisePng(320);
    await session.prompt("what is in this picture?", { images: [{ type: "image", data: png, mimeType: "image/png" }] });
    const sentImage = JSON.stringify(providerRequests(home).at(-1)!.body.messages).match(/"type":"image"/g)?.length ?? 0;
    assert.equal(sentImage, 1, "Pi sent the image as an image");
    assert.ok(JSON.stringify(providerRequests(home).at(-1)!.body.messages).length > 200_000, "and it is large in bytes");
    const data = await runContext(session, ui);
    assert.ok(data.estimated, "no count_tokens key: estimates, labelled");
    assert.ok(category(data, "Messages") < 5_000, `a large image is not ~100k tokens of text: ${category(data, "Messages")}`);
    assert.equal(category(data, "Reserve"), 7777, "the model's compaction override");
    await session.dispose?.();
  });
});

test("the reserve is zero when Pi's compaction is off", { timeout: 30_000 }, async () => {
  await withPiHome({ settings: { compaction: { enabled: false, reserveTokens: 4000 } } }, async (home) => {
    const { session, ui } = await startSession(home, { provider: "anthropic", id: OPUS });
    const data = await runContext(session, ui);
    assert.equal(category(data, "Reserve"), 0);
    await session.dispose?.();
  });
});
