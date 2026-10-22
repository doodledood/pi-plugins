// openai-tts loaded by a real Pi session from its file path and driven through Pi's agent loop. The model and
// OpenAI's speech endpoint are local HTTP servers; the audio players Pi would spawn are stand-in scripts on
// PATH that log when they start and stop. HOME and the agent directory live in a temporary directory.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { COST_RECORD_TYPE } from "./index.ts";

process.env.PI_OFFLINE ??= "1";

const EXTENSION_PATH = new URL("./index.ts", import.meta.url).pathname;
const PROVIDER = "ttslab";
const MODEL = "ttslab-1";
const TOOL = "openai_tts_speak";

// ── The model: answers a scripted user message with speak calls ─────────────

const SCRIPTS: Record<string, string[]> = {
  SPEAK_TWO: ["first words", "second words"],
  SPEAK_ONE: ["only words"],
};

function sse(blocks: Array<Record<string, unknown>>, stopReason: string): string {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
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

function modelReply(body: any): string {
  const last = body.messages?.at(-1);
  const content = Array.isArray(last?.content) ? last.content : [{ type: "text", text: String(last?.content ?? "") }];
  if (content.some((block: { type?: string }) => block.type === "tool_result")) return sse([{ type: "text", text: "done" }], "end_turn");
  const said = content.map((block: { text?: string }) => block.text ?? "").join("");
  const texts = SCRIPTS[said.trim()];
  if (!texts) return sse([{ type: "text", text: "ok" }], "end_turn");
  return sse(texts.map((text, index) => ({ type: "tool_use", id: `toolu_${index}`, name: TOOL, input: { text } })), "tool_use");
}

// ── OpenAI's speech endpoint, with a per-test behavior ──────────────────────

type SpeechBehavior = (input: string, res: ServerResponse) => void | Promise<void>;
const audioOk: SpeechBehavior = (input, res) => {
  res.writeHead(200, { "content-type": "audio/mpeg" });
  res.end(Buffer.from(`audio:${input}`));
};
let speech: SpeechBehavior = audioOk;
let speechRequests: string[] = [];

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(JSON.parse(raw || "{}")));
  });
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

// ── Setup ───────────────────────────────────────────────────────────────────

let dir: string;
let agentDir: string;
let cwd: string;
let playLog: string;
let modelServer: { server: Server; url: string };
let speechServer: { server: Server; url: string };
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PI_AGENT_HOME", "PATH", "OPENAI_TTS_API_KEY", "OPENAI_TTS_ENDPOINT", "FAKE_PLAY_LOG", "FAKE_PLAY_SECONDS", "OPENAI_TTS_MAX_CHARS", "OPENAI_TTS_TIMEOUT_MS", "OPENAI_TTS_MAX_AUDIO_BYTES", "OPENAI_TTS_PLAYBACK_TIMEOUT_MS", "OPENAI_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  modelServer = await listen((req, res) => {
    void readJson(req).then((body) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(modelReply(body));
    });
  });
  speechServer = await listen((req, res) => {
    void readJson(req).then((body) => {
      speechRequests.push(body.input);
      void speech(body.input, res);
    });
  });
  dir = mkdtempSync(join(tmpdir(), "openai-tts-real-pi-"));
  const home = join(dir, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(dir, "workspace");
  const bin = join(dir, "bin");
  for (const path of [agentDir, cwd, bin]) mkdirSync(path, { recursive: true });
  playLog = join(dir, "play.log");
  // Every player the extension may try: log start and end, play for FAKE_PLAY_SECONDS.
  const player = `#!/bin/sh\nfile="$(eval echo \\"\\\${$#}\\")"\necho "start $(cat "$file")" >> "$FAKE_PLAY_LOG"\nsleep "\${FAKE_PLAY_SECONDS:-0.2}"\necho "end $(cat "$file")" >> "$FAKE_PLAY_LOG"\n`;
  for (const name of ["afplay", "ffplay", "mpv", "paplay", "aplay"]) {
    writeFileSync(join(bin, name), player);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          baseUrl: modelServer.url,
          apiKey: "test-key",
          api: "anthropic-messages",
          models: [{ id: MODEL, name: MODEL, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 }],
        },
      },
    }),
  );
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
  process.env.PATH = `${bin}:${process.env.PATH}`;
});

afterEach(() => {
  speech = audioOk;
  speechRequests = [];
  for (const key of ["FAKE_PLAY_SECONDS", "OPENAI_TTS_MAX_CHARS", "OPENAI_TTS_TIMEOUT_MS", "OPENAI_TTS_MAX_AUDIO_BYTES", "OPENAI_TTS_PLAYBACK_TIMEOUT_MS"] as const) delete process.env[key];
  writeFileSync(playLog, "");
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  modelServer.server.close();
  speechServer.server.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Pi {
  session: AgentSession;
  notices: string[];
  /** Feed raw terminal input to the extensions' onTerminalInput handlers. */
  type(data: string): void;
}

async function startPi(): Promise<Pi> {
  process.env.OPENAI_TTS_API_KEY = "test-key";
  process.env.OPENAI_TTS_ENDPOINT = speechServer.url;
  process.env.FAKE_PLAY_LOG = playLog;
  writeFileSync(playLog, "");
  const settingsManager = SettingsManager.create(cwd, agentDir);
  settingsManager.setProjectTrusted(true);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [EXTENSION_PATH], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getAllModels().find((m) => m.provider === PROVIDER && m.id === MODEL);
  assert.ok(model);
  const { session } = await createAgentSession({ cwd, agentDir, sessionManager: SessionManager.inMemory(cwd), settingsManager, modelRuntime, resourceLoader: loader, model: model as never, tools: [TOOL] });
  const notices: string[] = [];
  const inputHandlers = new Set<(data: string) => unknown>();
  const inert = () => undefined;
  const ui: Record<string, unknown> = {
    notify: (message: string) => notices.push(message),
    onTerminalInput: (handler: (data: string) => unknown) => {
      inputHandlers.add(handler);
      return () => inputHandlers.delete(handler);
    },
    getEditorText: () => "",
    getToolsExpanded: () => false,
    getAllThemes: () => [],
    getTheme: inert,
    setTheme: () => ({ success: false }),
  };
  for (const name of ["setStatus", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "getEditorComponent", "setEditorComponent", "addAutocompleteProvider", "setToolsExpanded", "select", "confirm", "input", "editor", "custom"]) {
    ui[name] = inert;
  }
  await session.bindExtensions({ uiContext: ui as never, mode: "tui" });
  return { session, notices, type: (data) => [...inputHandlers].forEach((handler) => handler(data)) };
}

function playEvents(): string[] {
  return readFileSync(playLog, "utf8").split("\n").filter(Boolean);
}

function toolResults(session: AgentSession): Array<{ text: string; isError: boolean }> {
  return session.messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === TOOL
      ? [{ text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""), isError: message.isError }]
      : [],
  );
}

function costRecords(session: AgentSession): number {
  return session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === COST_RECORD_TYPE).length;
}

async function until(condition: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms))]);
}

// ── AC-12.1 ─────────────────────────────────────────────────────────────────

test("two speak calls in one message play one at a time, in call order, whichever download finishes first", { timeout: 30_000 }, async () => {
  const pi = await startPi();
  try {
    // The first call's audio arrives last.
    speech = async (input, res) => {
      if (input === "first words") await new Promise((resolve) => setTimeout(resolve, 500));
      audioOk(input, res);
    };
    await pi.session.prompt("SPEAK_TWO");
    assert.deepEqual(playEvents(), ["start audio:first words", "end audio:first words", "start audio:second words", "end audio:second words"]);
    assert.deepEqual(toolResults(pi.session).map((result) => result.isError), [false, false]);
  } finally {
    pi.session.dispose();
  }
});

// ── AC-12.2 ─────────────────────────────────────────────────────────────────

test("spend is recorded once OpenAI answers 200, even when the download is then aborted", { timeout: 30_000 }, async () => {
  const pi = await startPi();
  try {
    speech = (_input, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.write(Buffer.alloc(512));
      // ...and the rest never comes.
    };
    const turn = pi.session.prompt("SPEAK_ONE");
    await until(() => speechRequests.length === 1, "the speech request");
    await new Promise((resolve) => setTimeout(resolve, 200));
    await pi.session.abort();
    await turn;
    assert.equal(costRecords(pi.session), 1);
  } finally {
    pi.session.dispose();
  }
});

test("spend is recorded once OpenAI answers 200, even when the audio is over the size cap", { timeout: 30_000 }, async () => {
  const pi = await startPi();
  try {
    process.env.OPENAI_TTS_MAX_AUDIO_BYTES = "2048";
    speech = (_input, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.alloc(8192));
    };
    await pi.session.prompt("SPEAK_ONE");
    const [result] = toolResults(pi.session);
    assert.equal(result?.isError, true);
    assert.match(result?.text ?? "", /OPENAI_TTS_MAX_AUDIO_BYTES/);
    assert.equal(costRecords(pi.session), 1);
  } finally {
    pi.session.dispose();
  }
});

test("stopping during playback reports a stop, not a playback-timeout hint", { timeout: 30_000 }, async () => {
  const pi = await startPi();
  try {
    process.env.FAKE_PLAY_SECONDS = "5";
    const turn = pi.session.prompt("SPEAK_ONE");
    await until(() => playEvents().length === 1, "playback to start");
    await pi.session.abort();
    await turn;
    const [result] = toolResults(pi.session);
    assert.ok(result, "the tool recorded a result");
    assert.match(result.text, /stopped/i);
    assert.doesNotMatch(result.text, /OPENAI_TTS_PLAYBACK_TIMEOUT_MS/);
  } finally {
    pi.session.dispose();
  }
});

test("/openai-tts started while Pi is idle stops on Esc", { timeout: 30_000 }, async () => {
  const pi = await startPi();
  try {
    process.env.FAKE_PLAY_SECONDS = "5";
    assert.equal(pi.session.isIdle, true);
    const command = pi.session.prompt("/openai-tts read this aloud");
    await until(() => playEvents().length === 1, "playback to start");
    pi.type("\x1b");
    await within(command, 3_000, "the stopped command");
    assert.match(pi.notices.at(-1) ?? "", /stopped/i);
  } finally {
    pi.session.dispose();
  }
});

for (const [name, setup] of [
  ["OPENAI_TTS_MAX_CHARS", () => (process.env.OPENAI_TTS_MAX_CHARS = "")],
  [
    "OPENAI_TTS_TIMEOUT_MS",
    () => {
      process.env.OPENAI_TTS_TIMEOUT_MS = "";
      // Slower than the 1 s floor an empty value used to clamp to.
      speech = async (input, res) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        audioOk(input, res);
      };
    },
  ],
] as const) {
  test(`an empty ${name} is treated as unset`, { timeout: 30_000 }, async () => {
    const pi = await startPi();
    try {
      setup();
      await pi.session.prompt("SPEAK_ONE");
      assert.deepEqual(toolResults(pi.session).map((result) => result.isError), [false], JSON.stringify(toolResults(pi.session)));
    } finally {
      pi.session.dispose();
    }
  });
}
