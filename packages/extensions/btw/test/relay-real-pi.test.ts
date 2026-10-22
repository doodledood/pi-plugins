// send_to_main through a real parent session with BTW loaded as an extension, and the real child runtime
// BTW creates. Both sessions talk to one local model server; HOME, the agent directory and sessions live
// in a temporary directory. Only the parent's UI is a stand-in.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { SEND_TO_MAIN_PREFIX, SEND_TO_MAIN_TOOL } from "../src/runtime.ts";

process.env.PI_OFFLINE ??= "1";
initTheme("dark", false);

const EXTENSION_PATH = new URL("../index.ts", import.meta.url).pathname;
const PROVIDER = "btwlab";
const MODEL = "btwlab-relay-1";

// ── The model server ────────────────────────────────────────────────────────

let summaryGate: Promise<void> = Promise.resolve();
let summaryRequested = false;
/** Relay tool calls the server has handed to a BTW child. */
let relayCallsServed = 0;

function sse(blocks: Array<Record<string, unknown>>, stopReason: string): string {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ];
  blocks.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block: { type?: string; text?: string }) => (block.type === "text" ? (block.text ?? "") : "")).join("");
}

const text = (value: string) => ({ type: "text", text: value });
const relay = (id: string, message: string) => ({ type: "tool_use", id, name: SEND_TO_MAIN_TOOL, input: { message } });

async function respond(body: any): Promise<string> {
  const system = JSON.stringify(body.system ?? "");
  if (system.includes("context summarization")) {
    summaryRequested = true;
    await summaryGate;
    return sse([text("## Goal\nSummary of the parent conversation.")], "end_turn");
  }
  const last = body.messages?.at(-1);
  if (Array.isArray(last?.content) && last.content.some((block: { type?: string }) => block.type === "tool_result")) {
    return sse([text("done relaying")], "end_turn");
  }
  const said = blockText(last?.content);
  if (said.startsWith(SEND_TO_MAIN_PREFIX)) return sse([text("main got it")], "end_turn");
  if (said.includes("RELAY_TWICE")) return sse([relay("toolu_a", "first relay"), relay("toolu_b", "second relay")], "tool_use");
  if (said.includes("RELAY_ONCE")) {
    relayCallsServed += 1;
    return sse([relay("toolu_c", "relay during compaction")], "tool_use");
  }
  return sse([text("ok")], "end_turn");
}

function modelServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      void respond(JSON.parse(raw || "{}")).then((payload) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(payload);
      });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })));
}

// ── One Pi home for the file ────────────────────────────────────────────────

let dir: string;
let agentDir: string;
let cwd: string;
let server: { url: string; server: Server };
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PI_AGENT_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  server = await modelServer();
  dir = mkdtempSync(join(tmpdir(), "btw-relay-real-pi-"));
  const home = join(dir, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(dir, "workspace");
  for (const path of [agentDir, cwd]) mkdirSync(path, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          baseUrl: server.url,
          apiKey: "test-key",
          api: "anthropic-messages",
          models: [{ id: MODEL, name: MODEL, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 1_000 }],
        },
      },
    }),
  );
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 10 } }));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  server.server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The parent's TUI, reduced to what an overlay needs. */
function overlayUi() {
  const notices: string[] = [];
  const panels: Component[] = [];
  const inert = () => undefined;
  const plain = (_tone: string, value: string) => value;
  const theme = new Proxy({}, { get: (_target, key) => (key === "fg" || key === "bg" ? plain : (value: string) => value) });
  const tui = { requestRender() {}, terminal: { rows: 40, columns: 120, write() {} }, children: [], showOverlay: () => ({ hide() {} }) } as unknown as TUI;
  const handle = { hide() {}, setHidden() {}, isHidden: () => false, focus() {}, unfocus() {}, isFocused: () => true, getBounds: () => undefined } as unknown as OverlayHandle;
  const context: Record<string, unknown> = {
    theme,
    custom(factory: any, options?: { onHandle?: (handle: OverlayHandle) => void }) {
      return new Promise((resolve) => {
        let component: (Component & { dispose?(): void }) | undefined;
        const done = (value: unknown) => {
          component?.dispose?.();
          resolve(value);
        };
        void Promise.resolve(factory(tui, theme, {}, done)).then((made: Component) => {
          component = made;
          panels.push(made);
          options?.onHandle?.(handle);
        });
      });
    },
    notify(message: string) {
      notices.push(message);
    },
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    onTerminalInput: () => inert,
    getEditorText: () => "",
    getEditorComponent: inert,
    getToolsExpanded: () => false,
    getAllThemes: () => [],
    getTheme: inert,
    setTheme: () => ({ success: false }),
  };
  for (const name of ["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"]) {
    context[name] = inert;
  }
  return { notices, panels, context };
}

interface Main {
  session: AgentSession;
  sessionsDir: string;
  errors: string[];
  /** BTW panes opened over main, newest last. */
  panels: Component[];
}

async function startMain(history = 0): Promise<Main> {
  const sessionsDir = mkdtempSync(join(dir, "sessions-"));
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
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
  const model = modelRuntime.getAllModels().find((m) => m.provider === PROVIDER && m.id === MODEL);
  assert.ok(model, "the model is registered from models.json");
  const sessionManager = SessionManager.create(cwd, sessionsDir);
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < history; i += 1) {
    sessionManager.appendMessage({ role: "user", content: `parent question ${i} ${"x".repeat(400)}`, timestamp: i * 2 + 1 });
    sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: `answer ${i} ${"y".repeat(400)}` }], api: "anthropic-messages", provider: PROVIDER, model: MODEL, usage, stopReason: "stop", timestamp: i * 2 + 2 } as never);
  }
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager, settingsManager, modelRuntime, resourceLoader: loader, model: model as never, tools: ["read"] });
  const errors: string[] = [];
  const { context, panels } = overlayUi();
  await session.bindExtensions({
    uiContext: context as never,
    mode: "tui",
    // What every Pi mode binds; the other actions are not reached here.
    commandContextActions: { waitForIdle: () => session.waitForIdle() } as never,
    onError: (error) => errors.push(error.error),
  });
  return { session, sessionsDir, errors, panels };
}

function relaysInMain(main: Main): string[] {
  return main.session.sessionManager.getEntries().flatMap((entry) =>
    entry.type === "message" && entry.message.role === "user" && blockText(entry.message.content).startsWith(SEND_TO_MAIN_PREFIX)
      ? [blockText(entry.message.content).slice(SEND_TO_MAIN_PREFIX.length).trim()]
      : [],
  );
}

/** send_to_main results recorded in the BTW child's own session file. */
function childRelayResults(main: Main): Array<{ text: string; isError: boolean }> {
  const parentFile = main.session.sessionManager.getSessionFile();
  const files: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".jsonl") && full !== parentFile) files.push(full);
    }
  };
  walk(main.sessionsDir);
  return files.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === SEND_TO_MAIN_TOOL)
      .map((entry) => ({ text: blockText(entry.message.content), isError: entry.message.isError === true })),
  );
}

async function until(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function closeMain(main: Main): Promise<void> {
  await main.session.prompt("/btw done");
  await main.session.abort();
  main.session.dispose();
}

// ── AC-8.1 ──────────────────────────────────────────────────────────────────

test("two relays in one child message both reach an idle main, in order, and nothing is left queued", { timeout: 30_000 }, async () => {
  const main = await startMain();
  try {
    await main.session.prompt("/btw RELAY_TWICE");
    await until(() => relaysInMain(main).length >= 2 || main.errors.length > 0, "both relays");
    await until(() => childRelayResults(main).length === 2, "the child's two tool results");
    await main.session.waitForIdle();
    assert.deepEqual(main.errors, [], "Pi rejected a relay");
    assert.deepEqual(relaysInMain(main), ["first relay", "second relay"]);
    assert.equal(main.session.pendingMessageCount, 0, "a relay was left queued in main");
    assert.deepEqual(childRelayResults(main).map((r) => r.text), ["Sent to the main session.", "Sent to the main session."]);
  } finally {
    await closeMain(main);
  }
});

test("a relay sent while main runs /compact arrives once compaction ends", { timeout: 30_000 }, async () => {
  const main = await startMain(6);
  let release!: () => void;
  summaryGate = new Promise((resolve) => (release = resolve));
  summaryRequested = false;
  try {
    await main.session.prompt("/btw");
    const compacting = main.session.compact().then(
      () => "compacted",
      (error: unknown) => `compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await until(() => summaryRequested, "main to start compacting");
    relayCallsServed = 0;
    // The command returns once BTW has the prompt; the child's turn goes on in the background.
    const asked = main.session.prompt("/btw RELAY_ONCE");
    await until(() => relayCallsServed === 1, "the child to call send_to_main");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(relaysInMain(main), [], "nothing reaches main while it compacts");
    release();
    assert.equal(await compacting, "compacted");
    await asked;
    await until(() => relaysInMain(main).length > 0 || main.errors.length > 0, "the held relay");
    await until(() => childRelayResults(main).length === 1, "the child's tool result");
    await main.session.waitForIdle();
    assert.deepEqual(main.errors, [], "Pi rejected the relay");
    assert.deepEqual(relaysInMain(main), ["relay during compaction"]);
    assert.deepEqual(childRelayResults(main), [{ text: "Sent to the main session.", isError: false }]);
  } finally {
    release();
    await closeMain(main);
  }
});

test("a relay from a BTW opened while main is already compacting waits for compaction to end", { timeout: 30_000 }, async () => {
  const main = await startMain(6);
  let release!: () => void;
  summaryGate = new Promise((resolve) => (release = resolve));
  summaryRequested = false;
  try {
    const compacting = main.session.compact().then(
      () => "compacted",
      (error: unknown) => `compaction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await until(() => summaryRequested, "main to start compacting");
    await main.session.prompt("/btw");
    relayCallsServed = 0;
    const asked = main.session.prompt("/btw RELAY_ONCE");
    await until(() => relayCallsServed === 1, "the child to call send_to_main");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(main.errors, [], "Pi rejected the relay");
    assert.deepEqual(relaysInMain(main), [], "nothing reaches main while it compacts");
    release();
    assert.equal(await compacting, "compacted");
    await asked;
    await until(() => relaysInMain(main).length > 0 || main.errors.length > 0, "the held relay");
    await until(() => childRelayResults(main).length === 1, "the child's tool result");
    await main.session.waitForIdle();
    assert.deepEqual(main.errors, [], "Pi rejected the relay");
    assert.deepEqual(relaysInMain(main), ["relay during compaction"]);
    assert.deepEqual(childRelayResults(main), [{ text: "Sent to the main session.", isError: false }]);
  } finally {
    release();
    await closeMain(main);
  }
});

// ── AC-8.2 ──────────────────────────────────────────────────────────────────

test("a relay BTW closes on before main can take it is reported as not delivered", { timeout: 30_000 }, async () => {
  const main = await startMain(6);
  let release!: () => void;
  summaryGate = new Promise((resolve) => (release = resolve));
  summaryRequested = false;
  try {
    await main.session.prompt("/btw");
    const compacting = main.session.compact().catch(() => undefined);
    await until(() => summaryRequested, "main to start compacting");
    relayCallsServed = 0;
    const asked = main.session.prompt("/btw RELAY_ONCE");
    await until(() => relayCallsServed === 1, "the child to call send_to_main");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await main.session.prompt("/btw done");
    release();
    await compacting;
    await asked;
    await main.session.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(relaysInMain(main), []);
    const results = childRelayResults(main);
    assert.equal(results.length, 1, `the child recorded ${results.length} send_to_main results`);
    assert.doesNotMatch(results[0]!.text, /Sent to the main session/, "the child was told an undelivered relay was sent");
    assert.match(results[0]!.text, /not delivered/i);
    assert.equal(results[0]!.isError, true);
  } finally {
    release();
    await closeMain(main);
  }
});
