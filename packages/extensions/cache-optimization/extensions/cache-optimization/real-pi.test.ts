// cache-optimization in a real Pi 1.4 session on Pi's built-in Anthropic provider, with Pi's own retry and
// cache warmer running. The network is faked at fetch (Anthropic answers from a script), and the keepalive
// gets a fake clock and a fake ping endpoint. HOME and the agent directory live in a temporary directory.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { activate, COST_RECORD_TYPE } from "../cache-optimization.ts";
import { CacheKeepalive, PING_AFTER_IDLE_MS } from "./keepalive.ts";

process.env.PI_OFFLINE ??= "1";

const MODEL = "claude-opus-5";
const WAIT_TOOL = "wait_for_build";
/** Lifetime Pi's warmer uses for this model here, so it refreshes every couple of seconds of real time. */
const PI_CACHE_TTL_SECONDS = 12;

// ── Fake Anthropic, behind fetch ────────────────────────────────────────────

type Payload = { max_tokens?: number; messages: Array<{ role: string; content: unknown }> };
type Script = (payload: Payload, attempt: number) => { status: number; blocks?: Array<Record<string, unknown>> };
let script: Script = () => ({ status: 200, blocks: [{ type: "text", text: "ok" }] });
let realRequests: Payload[] = [];
let warmRefreshes = 0;
const originalFetch = globalThis.fetch;

function sse(blocks: Array<Record<string, unknown>>): string {
  const stop = blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
  const events: Array<[string, unknown]> = [
    ["message_start", { type: "message_start", message: { id: "msg", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0, output_tokens: 1 } } }],
  ];
  blocks.forEach((block, index) => {
    if (block.type === "tool_use") {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) } }]);
    } else {
      events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
      events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  });
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`unexpected network request in a test: ${url}`);
  const raw = typeof init?.body === "string" ? init.body : input instanceof Request ? await input.text() : "";
  const payload = JSON.parse(raw) as Payload;
  if (payload.max_tokens === 1) {
    warmRefreshes += 1;
    return new Response(sse([{ type: "text", text: "." }]), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  realRequests.push(payload);
  const reply = script(payload, realRequests.length);
  if (reply.status >= 400) {
    return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }), { status: reply.status, headers: { "content-type": "application/json" } });
  }
  return new Response(sse(reply.blocks ?? [{ type: "text", text: "ok" }]), { status: 200, headers: { "content-type": "text/event-stream" } });
}

// ── The keepalive's clock and ping endpoint ─────────────────────────────────

let clock = 1_000_000;
let pings = 0;
let releasePing: (() => void) | undefined;
let holdPings = false;

function pingResponse(): Response {
  return new Response(JSON.stringify({ usage: { input_tokens: 1, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
}

async function pingFetch(): Promise<Response> {
  pings += 1;
  if (holdPings) await new Promise<void>((resolve) => (releasePing = resolve));
  return pingResponse();
}

// ── A tool that waits until the test lets it finish ─────────────────────────

let waiters: Array<() => void> = [];
let waitStarted = false;

function releaseWaits(): void {
  for (const release = waiters.splice(0); release.length > 0; ) release.shift()!();
}

function waitToolExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: WAIT_TOOL,
    label: "Wait",
    description: "Wait for the build.",
    parameters: { type: "object", properties: {}, additionalProperties: false } as never,
    async execute() {
      waitStarted = true;
      await new Promise<void>((resolve) => waiters.push(resolve));
      return { content: [{ type: "text", text: "built" }], details: {} };
    },
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────

let dir: string;
let agentDir: string;
let cwd: string;
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "PI_AGENT_HOME", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "PI_CACHE_RETENTION"] as const;
const savedEnv: Record<string, string | undefined> = {};

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), "cache-optimization-real-pi-"));
  const home = join(dir, "home");
  agentDir = join(home, ".pi", "agent");
  cwd = join(dir, "workspace");
  for (const path of [agentDir, cwd]) mkdirSync(path, { recursive: true });
  // Pi's built-in route stays untouched (the keepalive only pings that one); only the warmer's TTL is shortened.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { modelOverrides: { [MODEL]: { promptCache: { short: PI_CACHE_TTL_SECONDS } } } } } }));
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: MODEL, defaultThinkingLevel: "off", retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } }));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test-key";
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  delete process.env.PI_CACHE_RETENTION;
  globalThis.fetch = fakeFetch as typeof fetch;
});

afterEach(() => {
  script = () => ({ status: 200, blocks: [{ type: "text", text: "ok" }] });
  realRequests = [];
  warmRefreshes = 0;
  pings = 0;
  holdPings = false;
  releasePing = undefined;
  releaseWaits();
  waitStarted = false;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

interface Pi {
  runtime: AgentSessionRuntime;
  /** The keepalive of each load of the extension, newest last (one per session). */
  keepalives: CacheKeepalive[];
}

async function startPi(): Promise<Pi> {
  const keepalives: CacheKeepalive[] = [];
  const cacheOptimization = (pi: ExtensionAPI) => {
    const keepalive = new CacheKeepalive({ now: () => clock, fetch: pingFetch as never, env: process.env });
    keepalives.push(keepalive);
    activate(pi, keepalive);
  };
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: { extensionFactories: [{ name: "cache-optimization", factory: cacheOptimization }, { name: "wait-tool", factory: waitToolExtension }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
    });
    services.settingsManager.setProjectTrusted(true);
    return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [WAIT_TOOL] })), services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.create(cwd, join(dir, "sessions")) });
  const bind = () => runtime.session.bindExtensions({});
  runtime.setRebindSession(bind);
  await bind();
  assert.equal(runtime.session.model?.id, MODEL);
  return { runtime, keepalives };
}

async function until(condition: () => boolean, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Flattened message content blocks carrying a cache_control marker, by position. */
function markerPositions(payload: Payload): number[] {
  const positions: number[] = [];
  let index = 0;
  for (const message of payload.messages) {
    const blocks = Array.isArray(message.content) ? message.content : [message.content];
    for (const block of blocks) {
      if (block && typeof block === "object" && "cache_control" in block) positions.push(index);
      index += 1;
    }
  }
  return positions;
}

const toolCalls = (count: number) => Array.from({ length: count }, (_, index) => ({ type: "tool_use", id: `toolu_${index}`, name: WAIT_TOOL, input: {} }));

// ── AC-13.1 ─────────────────────────────────────────────────────────────────

test("after a rejected request, Pi's retry still carries the breakpoint at the last accepted cache write", { timeout: 60_000 }, async () => {
  const pi = await startPi();
  try {
    // 1: a burst of tool calls; 2: Pi sends their 40 results, and Anthropic answers 529; 3: Pi's retry.
    script = (_payload, attempt) => (attempt === 1 ? { status: 200, blocks: toolCalls(20) } : attempt === 2 ? { status: 529 } : { status: 200, blocks: [{ type: "text", text: "done" }] });
    let settled = false;
    const turn = pi.runtime.session.prompt("build everything").finally(() => (settled = true));
    while (!settled) {
      releaseWaits();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await turn;
    assert.equal(realRequests.length, 3, "one request, one rejected burst, one retry");
    const [first, rejected, retry] = realRequests as [Payload, Payload, Payload];
    const acceptedTail = markerPositions(first).at(-1)!;
    assert.ok(markerPositions(rejected).includes(acceptedTail), "the burst carried the spare breakpoint");
    assert.deepEqual(markerPositions(retry), markerPositions(rejected), "the retry lost the breakpoint at the last accepted write");
  } finally {
    await pi.runtime.dispose();
  }
});

// ── AC-13.2 ─────────────────────────────────────────────────────────────────

test("Pi's warm refreshes neither reset the keepalive's gap nor bring on a duplicate ping", { timeout: 60_000 }, async () => {
  const pi = await startPi();
  try {
    // A first turn tells the keepalive how big the cached prompt is; the second one waits on a tool.
    await pi.runtime.session.prompt("hello");
    script = (_payload, attempt) => (attempt === 2 ? { status: 200, blocks: toolCalls(1) } : { status: 200, blocks: [{ type: "text", text: "done" }] });
    const turn = pi.runtime.session.prompt("wait for the build");
    await until(() => waitStarted, "the wait tool to start");
    const keepalive = pi.keepalives.at(-1)!;
    // The keepalive pings once the cache has sat idle (on its own clock) while the tool runs.
    clock += PING_AFTER_IDLE_MS + 1_000;
    assert.equal(await keepalive.tick(), "pinged");
    assert.equal(keepalive.state.gapPings, 1);
    // Shortly before the next ping would be due, Pi's warmer refreshes the same prefix.
    clock += PING_AFTER_IDLE_MS - 5_000;
    const refreshes = warmRefreshes;
    await until(() => warmRefreshes > refreshes, "a Pi cache refresh");
    assert.equal(keepalive.state.gapPings, 1, "a Pi refresh reset the per-gap ping count");
    // The next ping is now due, but the refreshed entry still lives: no ping.
    clock += 6_000;
    const pingsBefore = pings;
    assert.equal(await keepalive.tick(), "skipped", "the keepalive pinged a prefix Pi had just refreshed");
    assert.equal(pings, pingsBefore);
    // Once the refreshed entry's lifetime has passed, the keepalive's own idle clock still runs from its
    // last ping, not from Pi's refresh.
    clock += PI_CACHE_TTL_SECONDS * 1000 + 1_000;
    assert.equal(await keepalive.tick(), "pinged", "a Pi refresh re-anchored the keepalive's idle clock");
    assert.equal(keepalive.state.gapPings, 2);
    releaseWaits();
    await turn;
  } finally {
    await pi.runtime.dispose();
  }
});

// ── AC-13.3 ─────────────────────────────────────────────────────────────────

test("a ping in flight when the session is replaced has its spend recorded in its own session", { timeout: 60_000 }, async () => {
  const pi = await startPi();
  try {
    // A first turn tells the keepalive how big the cached prompt is; the second one waits on a tool.
    await pi.runtime.session.prompt("hello");
    script = (_payload, attempt) => (attempt === 2 ? { status: 200, blocks: toolCalls(1) } : { status: 200, blocks: [{ type: "text", text: "done" }] });
    const turn = pi.runtime.session.prompt("wait for the build");
    await until(() => waitStarted, "the wait tool to start");
    const sessionFile = pi.runtime.session.sessionManager.getSessionFile()!;
    const keepalive = pi.keepalives.at(-1)!;
    holdPings = true;
    clock += PING_AFTER_IDLE_MS + 1_000;
    const ping = keepalive.tick();
    await until(() => releasePing !== undefined, "the ping to go out");
    releaseWaits();
    await turn;
    // The response lands while the old session shuts down.
    setTimeout(() => releasePing?.(), 100);
    const swapped = await pi.runtime.newSession();
    assert.equal(swapped.cancelled, false);
    await ping;
    const records = readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "custom" && entry.customType === COST_RECORD_TYPE);
    assert.equal(records.length, 1, "the billed ping left no cost record");
  } finally {
    await pi.runtime.dispose();
  }
});
