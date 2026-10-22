// advisor_consult inside a real Pi runtime. The parent's model is a local HTTP server that calls the tool;
// the advisor is a stand-in `pi` on PATH (the process the extension spawns) that narrates and then errors,
// stops at the output limit, finishes during shutdown, ignores SIGTERM, or streams before a timeout.
// HOME, the agent directory and sessions live in a temporary directory.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";

process.env.PI_OFFLINE ??= "1";

const EXTENSION_PATH = new URL("./index.ts", import.meta.url).pathname;
const PROVIDER = "advlab";
const MODEL = "advlab-sage-1";
const OTHER_MODEL = "advlab-sage-2";

// ── The stand-in advisor ────────────────────────────────────────────────────

const FAKE_PI = String.raw`#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const mode = process.env.FAKE_PI_MODE;
const pids = process.env.FAKE_PI_PIDS;
appendFileSync(pids, process.pid + "\n");
const out = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const provider = process.env.FAKE_PI_PROVIDER || "advlab";
const model = process.env.FAKE_PI_MODEL || "advlab-sage-1";
const assistant = (text, stopReason, extra = {}) => ({ type: "message_end", message: { role: "assistant", provider, model, stopReason, content: text ? [{ type: "text", text }] : [], ...extra } });
const settle = () => { out({ type: "agent_end", messages: [], willRetry: false }); out({ type: "agent_settled", aborted: false }); };
const forever = () => setInterval(() => {}, 1000);
if (mode === "advice") {
  setTimeout(() => { out(assistant("FULL ADVICE: ship it behind a flag.", "stop")); settle(); }, Number(process.env.FAKE_PI_DELAY_MS || 0));
} else if (mode === "narrate-then-error") {
  out(assistant("Let me look at the deploy logs first.", "toolUse"));
  out(assistant("", "error", { errorMessage: "529 overloaded_error: Overloaded" }));
  settle();
} else if (mode === "length") {
  out(assistant("My read: ship it behind a fl", "length"));
  settle();
} else if (mode === "finish-slow-shutdown") {
  // The answer is written and the run settled; the advisor's own extensions then take seconds to shut down.
  process.on("SIGTERM", () => setTimeout(() => process.exit(143), 20));
  out(assistant("FULL ADVICE: ship it behind a flag.", "stop"));
  settle();
  setTimeout(() => process.exit(0), 3000);
} else if (mode === "ignore-term") {
  // Handles SIGTERM and never exits, and has started a process of its own that ignores it too.
  process.on("SIGTERM", () => {});
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
  appendFileSync(pids, grandchild.pid + "\n");
  forever();
} else if (mode === "midstream") {
  const words = "My recommendation is to ship the migration now without the flag because".split(" ");
  let i = 0;
  setInterval(() => { if (i < words.length) out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: words[i++] + " " } }); }, 20);
} else {
  process.stderr.write("unknown FAKE_PI_MODE " + mode + "\n");
  process.exit(2);
}
`;

// ── The parent's model: calls advisor_consult once per prompt, then answers ──

let nextToolInput: Record<string, unknown> = {};

function anthropicSse(blocks: Array<Record<string, unknown>>, stopReason: string): string {
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

let toolUseCount = 0;
function parentModelServer(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const last = body.messages?.at(-1);
      const answeredTool = Array.isArray(last?.content) && last.content.some((block: { type?: string }) => block.type === "tool_result");
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        answeredTool
          ? anthropicSse([{ type: "text", text: "noted" }], "end_turn")
          : anthropicSse([{ type: "tool_use", id: `toolu_${++toolUseCount}`, name: "advisor_consult", input: nextToolInput }], "tool_use"),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server })));
}

// ── One Pi home for the file ────────────────────────────────────────────────

let dir: string;
let agentDir: string;
let cwd: string;
let pidsFile: string;
let parent: { url: string; server: Server };
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PI_AGENT_HOME", "PATH", "FAKE_PI_MODE", "FAKE_PI_PIDS", "FAKE_PI_DELAY_MS", "FAKE_PI_MODEL"] as const;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  parent = await parentModelServer();
  dir = mkdtempSync(join(tmpdir(), "advisor-consult-real-pi-"));
  const home = join(dir, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(dir, "workspace");
  const bin = join(dir, "bin");
  for (const path of [agentDir, cwd, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(bin, "pi"), FAKE_PI);
  chmodSync(join(bin, "pi"), 0o755);
  pidsFile = join(dir, "pids");
  const model = (id: string) => ({ id, name: id, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8_000 });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({ providers: { [PROVIDER]: { baseUrl: parent.url, apiKey: "test-key", api: "anthropic-messages", models: [model(MODEL), model(OTHER_MODEL)] } } }),
  );
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_PI_PIDS = pidsFile;
  initTheme("dark");
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  parent.server.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeAdvisorConfig(overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(agentDir, "advisor-consult.json"),
    JSON.stringify({ defaultModel: `${PROVIDER}/${MODEL}`, defaultThinking: "low", minTimeoutMs: 100, maxTimeoutMs: 60_000, defaultTimeoutMs: 800, excludedTools: [], ...overrides }),
  );
}

function recordingUi() {
  const notices: string[] = [];
  const inert = () => undefined;
  const theme = { fg: (_tone: string, text: string) => text, bg: (_tone: string, text: string) => text, bold: (text: string) => text };
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
    theme,
    notify(message: string) {
      notices.push(message);
    },
  };
  for (const name of ["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"]) {
    context[name] = inert;
  }
  return { notices, context };
}

async function startSession() {
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
  assert.ok(model, "the parent's model is registered from models.json");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, join(dir, "sessions")),
    settingsManager,
    modelRuntime,
    resourceLoader: loader,
    model: model as never,
    tools: ["advisor_consult"],
  });
  const { notices, context } = recordingUi();
  await session.bindExtensions({ uiContext: context as never });
  return { session, notices };
}

interface Consult {
  text: string;
  isError: boolean;
  details: Record<string, any>;
  args: Record<string, unknown>;
  /** Wall-clock span of the tool call; undefined when it had not finished by the deadline. */
  durationMs?: number;
  notices: string[];
  pids: number[];
}

function readPids(): number[] {
  try {
    return readFileSync(pidsFile, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one consult through the parent's model. `abortAfterMs` aborts the parent run that long after the tool
 * starts. A consult still pending at `deadlineMs` is reported unfinished, and its processes are then killed so
 * the next test starts clean.
 */
async function runConsult(
  mode: string,
  input: Record<string, unknown>,
  options: { abortAfterMs?: number; deadlineMs?: number; env?: Record<string, string> } = {},
): Promise<Consult> {
  writeFileSync(pidsFile, "");
  process.env.FAKE_PI_MODE = mode;
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value;
  nextToolInput = { query: "Should we ship the migration behind a flag?", ...input };
  const { session, notices } = await startSession();
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  session.subscribe((event: { type: string; toolName?: string }) => {
    if (event.type === "tool_execution_start" && event.toolName === "advisor_consult") {
      startedAt = Date.now();
      if (options.abortAfterMs !== undefined) setTimeout(() => void session.abort(), options.abortAfterMs);
    }
    if (event.type === "tool_execution_end" && event.toolName === "advisor_consult") endedAt = Date.now();
  });
  const prompt = session.prompt("Get a second opinion.");
  const deadline = new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), options.deadlineMs ?? 15_000).unref());
  const outcome = await Promise.race([prompt.then(() => "done" as const), deadline]);
  const pids = readPids();
  const durationMs = startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined;
  if (outcome === "deadline") {
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    await prompt.catch(() => undefined);
  }
  for (const key of Object.keys(options.env ?? {})) delete process.env[key];
  const result = session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "advisor_consult") as any;
  const call = session.messages
    .flatMap((m: any) => (m.role === "assistant" && Array.isArray(m.content) ? m.content : []))
    .find((block: any) => block.type === "toolCall" && block.name === "advisor_consult") as any;
  session.dispose();
  return {
    text: (result?.content ?? []).map((block: { text?: string }) => block.text ?? "").join("\n"),
    isError: result?.isError === true,
    details: result?.details ?? {},
    args: call?.arguments ?? {},
    durationMs: outcome === "deadline" ? undefined : durationMs,
    notices,
    pids,
  };
}

// ── AC-7.1: only a completed final answer counts ──────────────────────────────

test("narration before a final call that errors is not advice, and the result is an error", { timeout: 30_000 }, async () => {
  writeAdvisorConfig();
  const consult = await runConsult("narrate-then-error", {});
  assert.doesNotMatch(consult.text, /Let me look at the deploy logs/, "mid-run narration was returned as the advice");
  assert.match(consult.text, /no advice/i);
  assert.equal(consult.isError, true, "a consult with no advice is flagged as a failed tool call");
});

test("a final answer cut off at the output limit is not advice", { timeout: 30_000 }, async () => {
  writeAdvisorConfig();
  const consult = await runConsult("length", {});
  assert.doesNotMatch(consult.text, /ship it behind a fl/, "the truncated answer was returned as complete advice");
  assert.match(consult.text, /output token limit/);
  assert.equal(consult.isError, true);
});

test("a finished answer counts even when the timeout lands while the advisor shuts down", { timeout: 30_000 }, async () => {
  writeAdvisorConfig({ defaultTimeoutMs: 1_000 });
  const consult = await runConsult("finish-slow-shutdown", {});
  assert.doesNotMatch(consult.text, /no reliable advice/i, "the settled answer was thrown away by the timeout");
  assert.match(consult.text, /^\[advisor · model: advlab\/advlab-sage-1 · [^\]]+\]\n+FULL ADVICE: ship it behind a flag\.$/u);
  assert.equal(consult.isError, false);
});

// ── AC-7.2: timeout and abort settle within 5 s and leave no process ──────────

test("a timeout settles within 5 s when the advisor ignores SIGTERM, and nothing it started survives", { timeout: 30_000 }, async () => {
  writeAdvisorConfig({ defaultTimeoutMs: 500 });
  const consult = await runConsult("ignore-term", {}, { deadlineMs: 12_000 });
  assert.ok(consult.durationMs !== undefined, "the consult never settled after its timeout");
  assert.ok(consult.durationMs <= 500 + 5_000, `settled ${consult.durationMs} ms after starting; the bound is the 500 ms timeout + 5 s`);
  assert.equal(consult.pids.length, 2, "the advisor and its grandchild both started");
  assert.deepEqual(consult.pids.filter(alive), [], "an advisor process outlived the consult");
  assert.equal(consult.isError, true);
  assert.equal(consult.details.timedOut, true);
});

test("an abort after the timeout kills at once", { timeout: 30_000 }, async () => {
  writeAdvisorConfig({ defaultTimeoutMs: 300 });
  const consult = await runConsult("ignore-term", {}, { abortAfterMs: 1_000, deadlineMs: 12_000 });
  assert.ok(consult.durationMs !== undefined, "the consult never settled after the abort");
  assert.ok(consult.durationMs < 1_000 + 1_500, `settled ${consult.durationMs} ms after starting; the abort came at 1,000 ms`);
  assert.deepEqual(consult.pids.filter(alive), [], "an advisor process outlived the consult");
});

// ── AC-7.3: small contract defects ───────────────────────────────────────────

test("a timeout above Node's timer limit is capped with a warning instead of firing at once", { timeout: 30_000 }, async () => {
  writeAdvisorConfig({ maxTimeoutMs: 3_000_000_000, defaultTimeoutMs: 3_000_000_000 });
  const consult = await runConsult("advice", {}, { env: { FAKE_PI_DELAY_MS: "1000" } });
  assert.equal(consult.isError, false, "the consult was killed as soon as it started");
  assert.match(consult.text, /FULL ADVICE/);
  assert.ok(consult.notices.some((notice) => /capped at 2147483647/.test(notice)), `no cap warning in ${JSON.stringify(consult.notices)}`);
});

test("the model-not-used note follows Pi's resolution of the pattern, not its spelling", { timeout: 60_000 }, async () => {
  writeAdvisorConfig();
  const note = /was not used/;
  const suffixed = await runConsult("advice", { model: `${PROVIDER}/${MODEL}:high` });
  assert.match(suffixed.text, /FULL ADVICE/);
  assert.doesNotMatch(suffixed.text, note, "a :thinking suffix was reported as a different model");
  const fuzzy = await runConsult("advice", { model: "sage-1" });
  assert.doesNotMatch(fuzzy.text, note, "a fuzzy pattern that resolves to the model used was reported as a different model");
  const other = await runConsult("advice", { model: `${PROVIDER}/${OTHER_MODEL}` });
  assert.match(other.text, note, "a real mismatch is still reported");
});

test("a finished call's header shows the configuration it ran with", { timeout: 30_000 }, async () => {
  writeAdvisorConfig({ defaultThinking: "low" });
  const consult = await runConsult("advice", {});
  assert.match(consult.text, /FULL ADVICE/);
  writeAdvisorConfig({ defaultThinking: "max" }); // edited after the call, before the session is reopened
  const { session } = await startSession();
  const definition = session.getToolDefinition("advisor_consult");
  session.dispose();
  const row = new ToolExecutionComponent("advisor_consult", "toolu_render", consult.args, undefined, definition, { requestRender() {} } as never, cwd);
  row.setArgsComplete();
  row.markExecutionStarted();
  row.updateResult({ content: [{ type: "text", text: consult.text }], details: consult.details, isError: consult.isError });
  const header = (row.render(200).find((line) => line.includes("Advisor Consult")) ?? "").replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(header, /\blow\b/, `header ${JSON.stringify(header)} does not show the effort the call ran with`);
  assert.doesNotMatch(header, /\bmax\b/, "header shows today's configured effort");
});

test("a no-advice result carries none of the advisor's streamed text", { timeout: 30_000 }, async () => {
  writeAdvisorConfig({ defaultTimeoutMs: 600 });
  const consult = await runConsult("midstream", {});
  assert.match(consult.text, /no reliable advice/i);
  assert.doesNotMatch(consult.text, /ship the migration|recommendation/, "half-streamed advice reached the parent");
  assert.equal(consult.isError, true);
});
