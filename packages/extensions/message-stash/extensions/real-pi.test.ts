// message-stash loaded by a real Pi runtime from its file path (so /new, /resume, /fork and /reload re-import
// it, as Pi does), talking to a local model server. HOME and the agent directory live in a temporary
// directory. Only the UI is a stand-in: an editor buffer, and a confirm dialog nobody answers.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

process.env.PI_OFFLINE ??= "1";

const EXTENSION_PATH = new URL("./message-stash.ts", import.meta.url).pathname;
const PROVIDER = "stashlab";
const MODEL = "stashlab-1";
const STASH_KEY = "ctrl+alt+s";
const POP_KEY = "alt+shift+s";

let requests = 0;

function reply(): string {
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

let dir: string;
let agentDir: string;
let cwd: string;
let server: Server;
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PI_AGENT_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};

before(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(reply());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  dir = mkdtempSync(join(tmpdir(), "message-stash-real-pi-"));
  const home = join(dir, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(dir, "workspace");
  for (const path of [agentDir, cwd]) mkdirSync(path, { recursive: true });
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [PROVIDER]: {
          baseUrl: `http://127.0.0.1:${port}`,
          apiKey: "test-key",
          api: "anthropic-messages",
          models: [{ id: MODEL, name: MODEL, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1_000 }],
        },
      },
    }),
  );
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: MODEL }));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
});

after(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The parts of Pi's TUI the extension touches: the editor buffer, notices, status, and dialogs. */
class FakeUi {
  editor = "";
  notices: string[] = [];
  dialogs: string[] = [];
  status: string | undefined;

  context(): Record<string, unknown> {
    const inert = () => undefined;
    const context: Record<string, unknown> = {
      getEditorText: () => this.editor,
      setEditorText: (text: string) => {
        this.editor = text;
      },
      notify: (message: string) => {
        this.notices.push(message);
      },
      setStatus: (key: string, value: string | undefined) => {
        if (key === "message-stash") this.status = value;
      },
      // Nobody is at the keyboard: a dialog never closes.
      confirm: (title: string) => {
        this.dialogs.push(title);
        return new Promise<boolean>(() => {});
      },
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => undefined,
      onTerminalInput: () => inert,
      getEditorComponent: inert,
      getToolsExpanded: () => false,
      getAllThemes: () => [],
      getTheme: inert,
      setTheme: () => ({ success: false }),
      theme: new Proxy({}, { get: () => (_tone: string, value: string) => value }),
    };
    for (const name of ["setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "addAutocompleteProvider", "setEditorComponent", "setToolsExpanded"]) {
      context[name] = inert;
    }
    return context;
  }
}

async function startPi(ui: FakeUi): Promise<AgentSessionRuntime> {
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: { additionalExtensionPaths: [EXTENSION_PATH], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    services.settingsManager.setProjectTrusted(true);
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: ["read"] })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(dir, "sessions")) });
  const bind = async () => {
    await runtime.session.bindExtensions({ uiContext: ui.context() as never, mode: "tui" });
  };
  runtime.setRebindSession(bind);
  await bind();
  return runtime;
}

async function press(runtime: AgentSessionRuntime, key: string): Promise<void> {
  const runner = runtime.session.extensionRunner;
  const shortcut = [...runner.getShortcuts({} as never).values()].find((candidate) => candidate.shortcut === key);
  assert.ok(shortcut, `message-stash registers ${key}`);
  await shortcut.handler(runner.createContext());
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms))]);
}

// ── AC-9.1 ──────────────────────────────────────────────────────────────────

test("a message sent while the editor holds new text is not held up, and the draft stays stashed", { timeout: 20_000 }, async () => {
  const ui = new FakeUi();
  const runtime = await startPi(ui);
  try {
    ui.editor = "my long draft";
    await press(runtime, STASH_KEY);
    assert.equal(ui.editor, "");
    // A steer or extension message can start a turn while the user is typing something new.
    ui.editor = "typed since the stash";
    const before = requests;
    await within(runtime.session.prompt("temporary message"), 5_000, "the turn");
    assert.deepEqual(ui.dialogs, [], "a dialog was raised inside the agent's turn");
    assert.equal(requests, before + 1, "the message reached the provider");
    assert.equal(ui.editor, "typed since the stash", "the typed text was replaced");
    assert.match(ui.notices.at(-1) ?? "", /still stashed/);
    assert.match(ui.status ?? "", /draft stashed/);
    ui.editor = "";
    await press(runtime, POP_KEY);
    assert.equal(ui.editor, "my long draft", "the draft is still available");
  } finally {
    await runtime.dispose();
  }
});

test("a message sent from an empty editor restores the draft without a dialog", { timeout: 20_000 }, async () => {
  const ui = new FakeUi();
  const runtime = await startPi(ui);
  try {
    ui.editor = "draft to come back";
    await press(runtime, STASH_KEY);
    await within(runtime.session.prompt("temporary message"), 5_000, "the turn");
    assert.deepEqual(ui.dialogs, []);
    assert.equal(ui.editor, "draft to come back");
    assert.equal(ui.status, undefined);
  } finally {
    await runtime.dispose();
  }
});

// ── AC-9.2 ──────────────────────────────────────────────────────────────────

const swaps: Array<[string, (runtime: AgentSessionRuntime, firstSessionFile: string) => Promise<unknown>]> = [
  ["/new", (runtime) => runtime.newSession()],
  ["/resume", (runtime, file) => runtime.newSession().then(() => runtime.switchSession(file))],
  [
    "/fork",
    (runtime) => {
      const userEntry = runtime.session.sessionManager.getEntries().find((entry) => entry.type === "message" && entry.message.role === "user");
      assert.ok(userEntry, "there is a user message to fork from");
      return runtime.fork(userEntry.id);
    },
  ],
  ["/reload", (runtime) => runtime.session.reload()],
];

for (const [name, swap] of swaps) {
  test(`a stashed draft survives ${name}`, { timeout: 20_000 }, async () => {
    const ui = new FakeUi();
    const runtime = await startPi(ui);
    try {
      await runtime.session.prompt("an earlier message");
      const firstSessionFile = runtime.session.sessionManager.getSessionFile();
      assert.ok(firstSessionFile);
      ui.editor = `draft before ${name}`;
      await press(runtime, STASH_KEY);
      const result = (await swap(runtime, firstSessionFile)) as { cancelled?: boolean } | undefined;
      assert.notEqual(result?.cancelled, true, `${name} went through`);
      ui.editor = "";
      await press(runtime, POP_KEY);
      assert.equal(ui.editor, `draft before ${name}`, `the draft was lost on ${name}`);
    } finally {
      await runtime.dispose();
    }
  });
}
