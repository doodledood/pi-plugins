import assert from "node:assert/strict";
import test from "node:test";
import cacheOptimization, { activate } from "../cache-optimization.ts";
import { CacheKeepalive, MIN_PROMPT_TOKENS, PING_AFTER_IDLE_MS } from "./keepalive.ts";
import type { SessionEntryLike } from "./cache.ts";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
  handlers: Map<string, Handler>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> | void }>;
  ctx: any;
}

function createRecordingTheme(): { theme: any; calls: Array<{ tone: string; text: string }> } {
  const calls: Array<{ tone: string; text: string }> = [];
  return {
    calls,
    theme: {
      fg(tone: string, text: string) {
        calls.push({ tone, text });
        return text;
      },
    },
  };
}

const fakeTui = { requestRender() {} };

function assistantEntry(timestamp: number, input: number, read: number, write: number): SessionEntryLike {
  return { type: "message", message: { role: "assistant", timestamp, usage: { input, cacheRead: read, cacheWrite: write } } };
}

function directAnthropicModelRegistry(): { providerRequestConfigs: Map<string, unknown>; modelRequestHeaders: Map<string, unknown>; authStorage: { runtimeOverrides: Map<string, unknown>; data: Record<string, unknown>; loadError: null } } {
  return { providerRequestConfigs: new Map(), modelRequestHeaders: new Map(), authStorage: { runtimeOverrides: new Map(), data: {}, loadError: null } };
}

function createHarness(branch: SessionEntryLike[]): Harness {
  const harness: Harness = { handlers: new Map(), commands: new Map(), ctx: undefined };
  const ctx = {
    sessionManager: { getBranch: () => branch },
    ui: {
      async custom(factory: any) {
        const recording = createRecordingTheme();
        harness.ctx.lastOverlay = factory(fakeTui, recording.theme, undefined, () => {});
        return undefined;
      },
    },
    lastOverlay: undefined as any,
  };
  harness.ctx = ctx;

  const pi = {
    on(event: string, handler: Handler) {
      harness.handlers.set(event, handler);
    },
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> | void }) {
      harness.commands.set(name, options);
    },
  };

  cacheOptimization(pi);
  harness.handlers.get("session_start")!({ reason: "startup" }, ctx);
  return harness;
}

/** Shut the harness down so the keepalive interval never outlives a test. */
function shutdown(harness: Harness): void {
  harness.handlers.get("session_shutdown")!({}, harness.ctx);
}

async function runCacheReport(harness: Harness): Promise<string> {
  const command = harness.commands.get("cache");
  assert.ok(command, "/cache command registered");
  await command.handler("", harness.ctx);
  const overlay = harness.ctx.lastOverlay;
  assert.ok(overlay, "overlay component created");
  assert.ok(Array.isArray(overlay.render(300)), "overlay renders lines");
  return overlay.lines.map((line: { text: string }) => line.text).join("\n");
}

test("/cache reports per-turn stats and entry-correlated break causes", async () => {
  const branch: SessionEntryLike[] = [
    assistantEntry(1_000, 2_000, 0, 18_000),
    { type: "compaction" },
    assistantEntry(2_000, 5_000, 100, 10_000),
    { type: "model_change", modelId: "other-model" },
    assistantEntry(3_000, 16_000, 200, 0),
    assistantEntry(3_000 + 6 * 60_000, 16_000, 300, 0),
  ];
  branch.push({ type: "branch_summary" });
  branch.push(assistantEntry(3_000 + 6 * 60_000 + 1_000, 16_000, 400, 0));

  const harness = createHarness(branch);
  const text = await runCacheReport(harness);
  shutdown(harness);

  assert.match(text, /Session cache rate: \d+%/);
  assert.match(text, /#1/);
  assert.match(text, /BREAK/);
  assert.match(text, /compaction rewrote the context/);
  assert.match(text, /model switched to other-model/);
  assert.match(text, /probable cache TTL expiry/);
  assert.match(text, /branch\/tree navigation rewrote the prefix/);
});

test("/cache attributes an unexplained break via prefix fingerprints when observed in-process", async () => {
  const branch: SessionEntryLike[] = [
    assistantEntry(1_000, 2_000, 0, 18_000),
    assistantEntry(2_000, 20_000, 100, 0),
  ];
  const harness = createHarness(branch);

  harness.handlers.get("before_provider_request")!({ payload: { system: "prompt-v1", messages: [{ role: "user", content: "hi" }] } }, harness.ctx);
  harness.handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 1_000 } }, harness.ctx);
  harness.handlers.get("before_provider_request")!({ payload: { system: "prompt-v2", messages: [{ role: "user", content: "hi" }] } }, harness.ctx);
  harness.handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 2_000 } }, harness.ctx);

  const text = await runCacheReport(harness);
  shutdown(harness);
  assert.match(text, /prefix changed: system prompt changed/);
  assert.match(text, /fingerprints cover 1\/2 turns/i);
});

test("/cache labels breaks without a retained fingerprint as entry-correlation only", async () => {
  const branch: SessionEntryLike[] = [
    assistantEntry(1_000, 2_000, 0, 18_000),
    assistantEntry(2_000, 20_000, 100, 0),
  ];
  const harness = createHarness(branch);
  const text = await runCacheReport(harness);
  shutdown(harness);
  assert.match(text, /no fingerprint retained for this turn — predates this process or pruned; entry-correlation only/);
});

test("/cache overlay supports wheel, page keys, and mouse-mode lifecycle", async () => {
  const branch: SessionEntryLike[] = [];
  for (let i = 0; i < 80; i++) branch.push(assistantEntry(i, 10, 10, 10));
  const harness = createHarness(branch);

  const writes: string[] = [];
  harness.ctx.ui.custom = async (factory: any) => {
    const recording = createRecordingTheme();
    const tui = { requestRender() {}, terminal: { write: (data: string) => writes.push(data), rows: 40 } };
    harness.ctx.lastOverlay = factory(tui, recording.theme, undefined, () => {});
    return undefined;
  };
  await harness.commands.get("cache")!.handler("", harness.ctx);
  const overlay = harness.ctx.lastOverlay;

  assert.ok(writes.some((w) => w.includes("\x1b[?1006h")), "SGR mouse reporting enabled on open");

  const windowOf = (rendered: string[]) => rendered.join("\n").match(/\((\d+)-\d+\/\d+\)/)?.[1];
  assert.equal(windowOf(overlay.render(100)), "1");

  overlay.handleInput("\x1b[<65;10;5M");
  assert.equal(windowOf(overlay.render(100)), "4");
  overlay.handleInput("\x1b[<64;10;5M");
  overlay.handleInput("\x1b[<64;10;5M");
  assert.equal(windowOf(overlay.render(100)), "1");

  overlay.handleInput("\x1b[6~");
  const afterPageDown = Number(windowOf(overlay.render(100)));
  assert.ok(afterPageDown > 10, `page down jumps a viewport (got ${afterPageDown})`);
  overlay.handleInput("\x1b[5~");
  assert.equal(windowOf(overlay.render(100)), "1");

  overlay.handleInput("\x1b[<0;10;5M");
  assert.equal(windowOf(overlay.render(100)), "1");

  overlay.handleInput("q");
  assert.ok(writes.some((w) => w.includes("\x1b[?1006l")), "SGR mouse reporting disabled on close");
  const disableCount = writes.filter((w) => w.includes("\x1b[?1006l")).length;
  overlay.dispose();
  assert.equal(writes.filter((w) => w.includes("\x1b[?1006l")).length, disableCount, "dispose after close does not double-disable");
  shutdown(harness);
});

test("fingerprint state stores hashes only and stays bounded to 500 pairs", async () => {
  const turns = 600;
  const branch: SessionEntryLike[] = [];
  for (let i = 0; i < turns; i++) branch.push(assistantEntry(i, 10, 10, 10));

  const harness = createHarness(branch);
  const before = harness.handlers.get("before_provider_request")!;
  const turnEnd = harness.handlers.get("turn_end")!;
  const secret = "TOP-SECRET-CONTENT";
  for (let i = 0; i < turns; i++) {
    before({ payload: { system: secret, messages: [{ role: "user", content: secret }] } }, harness.ctx);
    turnEnd({ message: { role: "assistant", timestamp: i } }, harness.ctx);
  }

  const text = await runCacheReport(harness);
  shutdown(harness);
  assert.match(text, /fingerprints cover 500\/600 turns/i);
  assert.doesNotMatch(text, /TOP-SECRET-CONTENT/);
});

test("before_provider_request returns the keeper's replacement payload when it stamps", () => {
  const harness = createHarness([]);
  const before = harness.handlers.get("before_provider_request")!;
  const CC = { type: "ephemeral" };
  const payload = (n: number) => ({
    model: "claude-test",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [],
    messages: [{ role: "user", content: Array.from({ length: n }, (_, i) => ({ type: "text", text: `b${i}`, ...(i === n - 1 ? { cache_control: { ...CC } } : {}) })) }],
    max_tokens: 10,
  });

  assert.equal(before({ payload: payload(30) }, harness.ctx), undefined, "first request: no replacement");
  const replaced = before({ payload: payload(60) }, harness.ctx) as any;
  assert.ok(replaced, "burst past threshold returns a replacement payload");
  const markers = replaced.messages[0].content.filter((b: any) => b.cache_control).length;
  assert.equal(markers, 2, "keeper anchor + pi tail marker");
  shutdown(harness);
});

test("keepalive wiring: extension events actually arm and disarm the keepalive end to end", async (t) => {
  // Hermetic auth environment: the extension's session_start reads auth.json
  // and ANTHROPIC_OAUTH_TOKEN to derive the route guard — pin both so the test
  // outcome never depends on this machine's real credentials.
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const fixtureDir = mkdtempSync(joinPath(tmpdir(), "cache-opt-test-"));
  writeFileSync(joinPath(fixtureDir, "auth.json"), "{}\n");
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PI_CODING_AGENT_DIR = fixtureDir;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
  t.after(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedOauth !== undefined) process.env.ANTHROPIC_OAUTH_TOKEN = savedOauth;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const clock = { now: 1_700_000_000_000 };
  const requests: string[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true };
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });

  const harness: Harness = { handlers: new Map(), commands: new Map(), ctx: undefined };
  const ctx = {
    model: { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5" },
    modelRegistry: directAnthropicModelRegistry(),
    sessionManager: { getBranch: () => [] as SessionEntryLike[] },
    ui: { async custom() {} },
  };
  harness.ctx = ctx;
  const pi = {
    on(event: string, handler: Handler) {
      harness.handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      harness.commands.set(name, options);
    },
  };
  activate(pi, keepalive);
  harness.handlers.get("session_start")!({ reason: "startup" }, ctx);

  const CC = { type: "ephemeral" };
  const payload = {
    model: "claude-fable-5",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { ...CC } }] }],
    max_tokens: 10,
  };
  // The real handlers must feed the keepalive: request capture, turn usage, tool lifecycle.
  harness.handlers.get("before_provider_request")!({ payload }, ctx);
  harness.handlers.get("turn_end")!(
    { message: { role: "assistant", timestamp: 5, usage: { input: MIN_PROMPT_TOKENS, cacheRead: 0, cacheWrite: 0 } } },
    ctx,
  );
  // A zero-usage turn_end (aborted/errored stream) must not overwrite the
  // real prompt size and disarm the activation floor.
  harness.handlers.get("turn_end")!(
    { message: { role: "assistant", timestamp: 6, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } } },
    ctx,
  );
  harness.handlers.get("tool_execution_start")!({ toolCallId: "t1" }, ctx);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged", "armed through the extension's own event handlers (zero-usage abort ignored)");
  assert.equal(requests.length, 1);

  harness.handlers.get("tool_execution_end")!({ toolCallId: "t1" }, ctx);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "tool_execution_end disarms");

  // Non-anthropic payloads pass through untouched and disarm the capture.
  const openai = { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] };
  assert.equal(harness.handlers.get("before_provider_request")!({ payload: openai }, ctx), undefined);
  harness.handlers.get("tool_execution_start")!({ toolCallId: "t2" }, ctx);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "non-anthropic payload never pings");

  harness.handlers.get("session_shutdown")!({}, ctx);
});

test("keepalive wiring: Anthropic provider/model request overrides disable pings", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const fixtureDir = mkdtempSync(joinPath(tmpdir(), "cache-opt-overrides-"));
  writeFileSync(joinPath(fixtureDir, "auth.json"), "{}\n");
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixtureDir;
  t.after(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  for (const modelRegistry of [
    { ...directAnthropicModelRegistry(), providerRequestConfigs: new Map([["anthropic", { apiKey: "$OTHER_KEY" }]]) },
    { ...directAnthropicModelRegistry(), modelRequestHeaders: new Map([["anthropic:claude-fable-5", { Authorization: "Bearer other" }]]) },
    { ...directAnthropicModelRegistry(), authStorage: { runtimeOverrides: new Map([["anthropic", "sk-other"]]), data: {}, loadError: null } },
    { ...directAnthropicModelRegistry(), authStorage: { runtimeOverrides: new Map(), data: { anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY" } }, loadError: null } },
    { ...directAnthropicModelRegistry(), authStorage: { runtimeOverrides: new Map(), data: {}, loadError: new Error("bad auth") } },
    {},
    { providerRequestConfigs: {}, modelRequestHeaders: new Map(), authStorage: { runtimeOverrides: new Map(), data: {}, loadError: null } },
  ]) {
    const clock = { now: 1_700_000_000_000 };
    const requests: string[] = [];
    const keepalive = new CacheKeepalive({
      now: () => clock.now,
      fetch: async (url) => {
        requests.push(url);
        return { ok: true };
      },
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    const handlers = new Map<string, Handler>();
    const ctx = { model: { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5" }, modelRegistry, sessionManager: { getBranch: () => [] }, ui: { async custom() {} } };
    activate({ on: (e: string, h: Handler) => handlers.set(e, h), registerCommand() {} }, keepalive);
    handlers.get("session_start")!({ reason: "startup" }, ctx);
    const payload = {
      model: "claude-fable-5",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
      max_tokens: 10,
    };
    handlers.get("before_provider_request")!({ payload }, ctx);
    handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 5, usage: { input: MIN_PROMPT_TOKENS, cacheRead: 0, cacheWrite: 0 } } }, ctx);
    handlers.get("tool_execution_start")!({ toolCallId: "t1" }, ctx);
    clock.now += PING_AFTER_IDLE_MS + 1;
    assert.equal(await keepalive.tick(), "skipped", "auth-affecting request overrides make the env-key ping identity ambiguous");
    assert.equal(requests.length, 0);
    handlers.get("session_shutdown")!({}, ctx);
  }
});

test("keepalive wiring: generic run_in_background tool_execution_start args arm idle background work", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const fixtureDir = mkdtempSync(joinPath(tmpdir(), "cache-opt-bg-"));
  writeFileSync(joinPath(fixtureDir, "auth.json"), "{}\n");
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PI_CODING_AGENT_DIR = fixtureDir;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
  t.after(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedOauth !== undefined) process.env.ANTHROPIC_OAUTH_TOKEN = savedOauth;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const clock = { now: 1_700_000_000_000 };
  const requests: string[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true };
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  const handlers = new Map<string, Handler>();
  const ctx = { model: { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5" }, modelRegistry: directAnthropicModelRegistry(), sessionManager: { getBranch: () => [] }, ui: { async custom() {} } };
  activate({ on: (e: string, h: Handler) => handlers.set(e, h), registerCommand() {} }, keepalive);
  handlers.get("session_start")!({ reason: "startup" }, ctx);

  const CC = { type: "ephemeral" };
  const payload = {
    model: "claude-fable-5",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { ...CC } }] }],
    max_tokens: 10,
  };
  handlers.get("before_provider_request")!({ payload }, ctx);
  handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 5, usage: { input: MIN_PROMPT_TOKENS, cacheRead: 0, cacheWrite: 0 } } }, ctx);

  handlers.get("tool_execution_start")!({ toolCallId: "fake-1", toolName: "launch_widget", args: { run_in_background: true } }, ctx);
  handlers.get("tool_execution_end")!({ toolCallId: "fake-1", toolName: "launch_widget" }, ctx);
  handlers.get("agent_end")!({}, ctx);

  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged", "generic fake tool background work arms with no foreground tool in flight");
  assert.equal(requests.length, 1);

  handlers.get("before_provider_request")!({ payload }, ctx);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "wake bookkeeping consumed the pending background work");

  handlers.get("tool_execution_start")!({ toolCallId: "fake-2", toolName: "launch_widget", args: { run_in_background: true } }, ctx);
  handlers.get("tool_execution_end")!({ toolCallId: "fake-2", toolName: "launch_widget" }, ctx);
  handlers.get("agent_end")!({}, ctx);
  handlers.get("session_tree")!({ newLeafId: "other" }, ctx);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "branch/tree navigation clears pending background work");

  handlers.get("session_shutdown")!({}, ctx);
});

test("keepalive wiring: generic run_in_background tool_call input arms idle background work", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const fixtureDir = mkdtempSync(joinPath(tmpdir(), "cache-opt-bg-input-"));
  writeFileSync(joinPath(fixtureDir, "auth.json"), "{}\n");
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PI_CODING_AGENT_DIR = fixtureDir;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
  t.after(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedOauth !== undefined) process.env.ANTHROPIC_OAUTH_TOKEN = savedOauth;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const clock = { now: 1_700_000_000_000 };
  const requests: string[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true };
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  const handlers = new Map<string, Handler>();
  const ctx = { model: { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5" }, modelRegistry: directAnthropicModelRegistry(), sessionManager: { getBranch: () => [] }, ui: { async custom() {} } };
  activate({ on: (e: string, h: Handler) => handlers.set(e, h), registerCommand() {} }, keepalive);
  handlers.get("session_start")!({ reason: "startup" }, ctx);

  const CC = { type: "ephemeral" };
  const payload = {
    model: "claude-fable-5",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { ...CC } }] }],
    max_tokens: 10,
  };
  handlers.get("before_provider_request")!({ payload }, ctx);
  handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 5, usage: { input: MIN_PROMPT_TOKENS, cacheRead: 0, cacheWrite: 0 } } }, ctx);

  handlers.get("tool_execution_start")!({ toolCallId: "fake-input", toolName: "launch_widget", args: {} }, ctx);
  handlers.get("tool_call")!({ toolCallId: "fake-input", toolName: "launch_widget", input: { runInBackground: true } }, ctx);
  handlers.get("tool_execution_end")!({ toolCallId: "fake-input", toolName: "launch_widget" }, ctx);
  handlers.get("agent_end")!({}, ctx);

  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged", "tool_call input path arms with no flagged tool_execution_start args");
  assert.equal(requests.length, 1);

  handlers.get("session_shutdown")!({}, ctx);
});

test("keepalive wiring: ANTHROPIC_OAUTH_TOKEN in the environment disables pings end to end", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const fixtureDir = mkdtempSync(joinPath(tmpdir(), "cache-opt-oauth-"));
  writeFileSync(joinPath(fixtureDir, "auth.json"), "{}\n");
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PI_CODING_AGENT_DIR = fixtureDir;
  process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat-test";
  t.after(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedOauth === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
    else process.env.ANTHROPIC_OAUTH_TOKEN = savedOauth;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const clock = { now: 1_700_000_000_000 };
  const requests: string[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true };
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  const handlers = new Map<string, Handler>();
  const ctx = { model: { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5" }, modelRegistry: directAnthropicModelRegistry(), sessionManager: { getBranch: () => [] }, ui: { async custom() {} } };
  activate({ on: (e: string, h: Handler) => handlers.set(e, h), registerCommand() {} }, keepalive);
  handlers.get("session_start")!({ reason: "startup" }, ctx);

  const CC = { type: "ephemeral" };
  const payload = {
    model: "claude-fable-5",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { ...CC } }] }],
    max_tokens: 10,
  };
  handlers.get("before_provider_request")!({ payload }, ctx);
  handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 5, usage: { input: MIN_PROMPT_TOKENS, cacheRead: 0, cacheWrite: 0 } } }, ctx);
  handlers.get("tool_execution_start")!({ toolCallId: "t1" }, ctx);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "OAuth env token means the session may authenticate as a different identity — never ping");
  assert.equal(requests.length, 0);
  handlers.get("session_shutdown")!({}, ctx);
});

test("keepalive wiring: OAuth-looking ANTHROPIC_API_KEY disables pings end to end", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const fixtureDir = mkdtempSync(joinPath(tmpdir(), "cache-opt-oat-key-"));
  writeFileSync(joinPath(fixtureDir, "auth.json"), "{}\n");
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PI_CODING_AGENT_DIR = fixtureDir;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-ant-oat-test";
  t.after(() => {
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedOauth === undefined) delete process.env.ANTHROPIC_OAUTH_TOKEN;
    else process.env.ANTHROPIC_OAUTH_TOKEN = savedOauth;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const clock = { now: 1_700_000_000_000 };
  const requests: string[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true };
    },
    env: { ANTHROPIC_API_KEY: "sk-ant-oat-test" },
  });
  const handlers = new Map<string, Handler>();
  const ctx = { model: { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5" }, modelRegistry: directAnthropicModelRegistry(), sessionManager: { getBranch: () => [] }, ui: { async custom() {} } };
  activate({ on: (e: string, h: Handler) => handlers.set(e, h), registerCommand() {} }, keepalive);
  handlers.get("session_start")!({ reason: "startup" }, ctx);

  const CC = { type: "ephemeral" };
  const payload = {
    model: "claude-fable-5",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { ...CC } }] }],
    max_tokens: 10,
  };
  handlers.get("before_provider_request")!({ payload }, ctx);
  handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 5, usage: { input: MIN_PROMPT_TOKENS, cacheRead: 0, cacheWrite: 0 } } }, ctx);
  handlers.get("tool_execution_start")!({ toolCallId: "t1" }, ctx);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "OAuth tokens in ANTHROPIC_API_KEY are not plain API-key auth");
  assert.equal(requests.length, 0);
  handlers.get("session_shutdown")!({}, ctx);
});

test("keepalive wiring: a CLI --api-key runtime override disables pings", async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const fixtureDir = mkdtempSync(joinPath(tmpdir(), "cache-opt-argv-"));
  writeFileSync(joinPath(fixtureDir, "auth.json"), "{}\n");
  const savedDir = process.env.PI_CODING_AGENT_DIR;
  const savedOauth = process.env.ANTHROPIC_OAUTH_TOKEN;
  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.PI_CODING_AGENT_DIR = fixtureDir;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.ANTHROPIC_API_KEY = "sk-ant-api03-test";
  process.argv.push("--api-key", "sk-runtime-override");
  t.after(() => {
    process.argv.splice(process.argv.indexOf("--api-key"), 2);
    if (savedDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedDir;
    if (savedOauth !== undefined) process.env.ANTHROPIC_OAUTH_TOKEN = savedOauth;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const clock = { now: 1_700_000_000_000 };
  const requests: string[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async (url) => {
      requests.push(url);
      return { ok: true };
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  const handlers = new Map<string, Handler>();
  const ctx = { model: { provider: "anthropic", api: "anthropic-messages", id: "claude-fable-5" }, modelRegistry: directAnthropicModelRegistry(), sessionManager: { getBranch: () => [] }, ui: { async custom() {} } };
  activate({ on: (e: string, h: Handler) => handlers.set(e, h), registerCommand() {} }, keepalive);
  handlers.get("session_start")!({ reason: "startup" }, ctx);

  const CC = { type: "ephemeral" };
  const payload = {
    model: "claude-fable-5",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { ...CC } }] }],
    max_tokens: 10,
  };
  handlers.get("before_provider_request")!({ payload }, ctx);
  handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 5, usage: { input: MIN_PROMPT_TOKENS, cacheRead: 0, cacheWrite: 0 } } }, ctx);
  handlers.get("tool_execution_start")!({ toolCallId: "t1" }, ctx);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "runtime key override means the ping identity cannot be confirmed — never ping");
  assert.equal(requests.length, 0);
  handlers.get("session_shutdown")!({}, ctx);
});

test("/cache report surfaces keepalive spend for auditability", async () => {
  const branch: SessionEntryLike[] = [assistantEntry(1_000, 2_000, 2_000, 0)];
  const harness = createHarness(branch);
  const text = await runCacheReport(harness);
  assert.match(text, /TTL keepalive: no pings today/);
  shutdown(harness);
});
