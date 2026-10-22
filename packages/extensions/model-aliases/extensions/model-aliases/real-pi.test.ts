// model-aliases inside a real Pi runtime: model data, routing, cache warming,
// thinking replay and compaction. Providers are local HTTP servers; the agent
// directory, HOME and config live in a temporary directory per test.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, type AnyModel, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  compact,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { buildAliasLookup, buildProviderRegistrations, buildTargetModelLookup, createAliasStreamSimple } from "./index.ts";
import type { ModelAliasesConfig } from "./config.ts";

// Keep Pi off the user's real agent directory: everything in this file resolves HOME and the agent dir to a
// throwaway home. Tests that need their own Pi home still set one and restore back to this.
const isolatedHome = mkdtempSync(join(tmpdir(), "model-aliases-real-pi-home-"));
process.env.HOME = isolatedHome;
process.env.PI_CODING_AGENT_DIR = join(isolatedHome, ".pi", "agent");

process.env.PI_OFFLINE ??= "1";

const EXTENSION_PATH = new URL("./index.ts", import.meta.url).pathname;
const TARGET = "claude-opus-5-5";

interface Hit {
  server: string;
  body: Record<string, any>;
}

function anthropicSse(inputTokens: number): string {
  return [
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: TARGET, content: [], stop_reason: null, usage: { input_tokens: inputTokens, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

async function anthropicServer(name: string, hits: Hit[], inputTokens = 10): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      hits.push({ server: name, body: raw ? JSON.parse(raw) : {} });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(anthropicSse(inputTokens));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}

/** A temporary Pi home: agent dir, HOME and model-aliases config, restored afterwards. */
async function withPiHome<T>(
  files: { aliases: ModelAliasesConfig["aliases"]; modelsJson?: unknown; settings?: unknown; extensions?: Record<string, string> },
  run: (home: { dir: string; agentDir: string; cwd: string; extensionPath(name: string): string }) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "model-aliases-real-pi-"));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "workspace");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(agentDir, "model-aliases.json"), JSON.stringify({ enabled: true, aliases: files.aliases }));
  if (files.modelsJson) writeFileSync(join(agentDir, "models.json"), JSON.stringify(files.modelsJson));
  if (files.settings) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(files.settings));
  for (const [name, source] of Object.entries(files.extensions ?? {})) writeFileSync(join(dir, name), source);
  const saved = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_AGENT_HOME: process.env.PI_AGENT_HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.HOME = join(dir, "home");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_AGENT_HOME = agentDir;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    return await run({ dir, agentDir, cwd, extensionPath: (name) => join(dir, name) });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function startSession(home: { agentDir: string; cwd: string }, extensionPaths: string[]) {
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
  const { session } = await createAgentSession({
    cwd: home.cwd,
    agentDir: home.agentDir,
    sessionManager: SessionManager.inMemory(home.cwd),
    settingsManager,
    modelRuntime: await ModelRuntime.create(),
    resourceLoader: loader,
    tools: [],
  });
  await session.bindExtensions({});
  return session;
}

async function waitFor(predicate: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const routingAliases = (explicitUrl: string): ModelAliasesConfig["aliases"] => [
  { provider: "anthropic", id: TARGET, targetProvider: "anthropic", targetModel: TARGET, contextWindow: 300_000, targetContextWindow: 1_000_000 },
  { provider: "anthropic", id: "opus-renamed", targetProvider: "anthropic", targetModel: TARGET },
  { provider: "alias-xp", id: "opus-xp", targetProvider: "anthropic", targetModel: TARGET, apiKey: "$ANTHROPIC_API_KEY" },
  { provider: "anthropic", id: "opus-explicit", targetProvider: "anthropic", targetModel: TARGET, baseUrl: explicitUrl },
];

for (const order of ["routing extension first", "model-aliases first"] as const) {
  test(`another extension's provider route is honored for base, aliased, renamed and cross-provider models (${order})`, { timeout: 20_000 }, async () => {
    const hits: Hit[] = [];
    const direct = await anthropicServer("pi-default", hits);
    const relay = await anthropicServer("routing-extension", hits);
    const explicit = await anthropicServer("alias-explicit", hits);
    try {
      await withPiHome({
        aliases: routingAliases(explicit.url),
        modelsJson: { providers: { anthropic: { baseUrl: direct.url } } },
        extensions: { "route.ts": `export default function (pi) { pi.registerProvider("anthropic", { baseUrl: ${JSON.stringify(relay.url)} }); }\n` },
      }, async (home) => {
        const route = home.extensionPath("route.ts");
        const session = await startSession(home, order === "routing extension first" ? [route, EXTENSION_PATH] : [EXTENSION_PATH, route]);
        try {
          const base = session.modelRuntime.getAllModels("anthropic").find((model) => model.id !== TARGET && model.id !== "opus-renamed" && model.id !== "opus-explicit");
          assert.ok(base, "a built-in anthropic model the config does not alias");
          const cases: Array<[provider: string, id: string, server: string, sentModel: string]> = [
            ["anthropic", base.id, "routing-extension", base.id],
            ["anthropic", TARGET, "routing-extension", TARGET],
            ["anthropic", "opus-renamed", "routing-extension", TARGET],
            ["alias-xp", "opus-xp", "routing-extension", TARGET],
            ["anthropic", "opus-explicit", "alias-explicit", TARGET],
          ];
          for (const [provider, id, server, sentModel] of cases) {
            const model = session.modelRuntime.getModel(provider, id);
            assert.ok(model, `${provider}/${id} is registered`);
            hits.length = 0;
            await session.setModel(model);
            await session.prompt(`hello from ${id}`);
            assert.deepEqual(hits.map((hit) => [hit.server, hit.body.model]), [[server, sentModel]], `${provider}/${id}`);
          }
        } finally {
          session.dispose();
        }
      });
    } finally {
      direct.server.close();
      relay.server.close();
      explicit.server.close();
    }
  });
}

test("Pi's cache warmer schedules and refreshes an aliased Anthropic model through the alias route", { timeout: 20_000 }, async () => {
  const hits: Hit[] = [];
  const provider = await anthropicServer("provider", hits, 200_000);
  try {
    await withPiHome({
      aliases: [{ provider: "anthropic", id: "opus-renamed", targetProvider: "anthropic", targetModel: TARGET }],
      // A short cache lifetime so the refresh happens within the test (Pi refreshes 10 s before expiry).
      modelsJson: { providers: { anthropic: { baseUrl: provider.url, modelOverrides: { [TARGET]: { promptCache: { short: 12, long: 3600 } } } } } },
      settings: { cacheWarming: "idle" },
      extensions: { "always-warm.ts": `export default function (pi) { pi.on("cache_warming_decision", () => ({ action: "warm" })); }\n` },
    }, async (home) => {
      const session = await startSession(home, [EXTENSION_PATH, home.extensionPath("always-warm.ts")]);
      try {
        await session.setModel(session.modelRuntime.getModel("anthropic", "opus-renamed")!);
        await session.prompt("hello");
        const status = session.cacheWarmingStatus;
        assert.equal(status?.state, "scheduled", JSON.stringify(status));
        assert.equal(status?.decision?.economicsAvailable, true);
        await waitFor(() => hits.length >= 2, 8_000);
        assert.equal(hits[1]!.body.max_tokens, 1, "the second request is the one-token warm refresh");
        assert.equal(hits[1]!.body.model, TARGET, "the refresh went through the alias route to the target model");
      } finally {
        session.dispose();
      }
    });
  } finally {
    provider.server.close();
  }
});

test("every model Pi holds for a re-registered provider, non-chat models included, is still there", { timeout: 20_000 }, async () => {
  await withPiHome({
    aliases: [{ provider: "openai", id: "gpt-renamed", targetProvider: "openai", targetModel: "gpt-5.5" }],
  }, async (home) => {
    const before = (await ModelRuntime.create()).getAllModels("openai").map((model) => `${model.type ?? "chat"}/${model.id}`);
    assert.ok(before.some((key) => !key.startsWith("chat/")), "the catalog carries a non-chat openai model");
    const session = await startSession(home, [EXTENSION_PATH]);
    try {
      const after = new Set(session.modelRuntime.getAllModels("openai").map((model) => `${model.type ?? "chat"}/${model.id}`));
      assert.deepEqual(before.filter((key) => !after.has(key)), []);
      assert.ok(after.has("chat/gpt-renamed"));
    } finally {
      session.dispose();
    }
  });
});

test("re-registered catalog models and aliases keep every field of Pi's model", { timeout: 20_000 }, async () => {
  await withPiHome({ aliases: [] }, async () => {
    const catalog = await ModelRuntime.create({ modelsPath: null });
    const providers = ["anthropic", "openai"];
    const existing = providers.flatMap((provider) => catalog.getAllModels(provider));
    const config: ModelAliasesConfig = {
      enabled: true,
      aliases: [
        { provider: "anthropic", id: "opus-renamed", targetProvider: "anthropic", targetModel: TARGET, contextWindow: 300_000 },
        { provider: "openai", id: "gpt-renamed", targetProvider: "openai", targetModel: "gpt-5.5" },
      ],
    };
    const registered = await ModelRuntime.create({ modelsPath: null });
    for (const registration of buildProviderRegistrations(config, existing)) {
      registered.registerProvider(registration.provider, registration.config as any);
    }
    const plain = (model: AnyModel | undefined) => JSON.parse(JSON.stringify(model ?? null));
    const find = (provider: string, type: string, id: string) =>
      registered.getAllModels(provider).find((model) => (model.type ?? "chat") === type && model.id === id);

    for (const model of existing) {
      assert.deepEqual(plain(find(model.provider, model.type ?? "chat", model.id)), plain(model), `${model.provider}/${model.id}`);
    }

    for (const alias of config.aliases) {
      const target = existing.find((model) => model.provider === alias.targetProvider && model.id === alias.targetModel)!;
      const registeredAlias = plain(find(alias.provider, "chat", alias.id));
      const expected = { ...plain(target), id: alias.id, api: "model-aliases", ...(alias.contextWindow ? { contextWindow: alias.contextWindow } : {}) };
      assert.deepEqual(registeredAlias, expected, `${alias.provider}/${alias.id}`);
    }
  });
});

async function captureThinkingReplay(aliasId: string): Promise<string[]> {
  let body = "";
  const server = createServer((req, res) => {
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const catalog = await ModelRuntime.create({ modelsPath: null });
    const target = { ...catalog.getModel("anthropic", TARGET)!, baseUrl };
    const config: ModelAliasesConfig = { enabled: true, aliases: [{ provider: "anthropic", id: aliasId, targetProvider: "anthropic", targetModel: TARGET }] };
    const aliasModel = { ...target, id: aliasId, api: "model-aliases" } as Model<any>;
    const lookup = buildAliasLookup(config);
    const targets = buildTargetModelLookup(config, [target]);

    // Turn 1 exactly as Pi records it: the alias wrapper stamps the alias identity.
    const recordTurn = createAliasStreamSimple(lookup, targets, (model) => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [
          { type: "thinking", thinking: "I should read the file first", thinkingSignature: "sig-abc" },
          { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.ts" } },
        ],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse", timestamp: Date.now(),
      };
      queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
      return stream;
    });
    const turn1 = await recordTurn(aliasModel, { messages: [] } as any).result();
    assert.equal(turn1.model, aliasId);

    const context: any = { systemPrompt: "sys", messages: [
      { role: "user", content: "read a.ts", timestamp: 1 },
      turn1,
      { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: Date.now() },
    ] };
    await createAliasStreamSimple(lookup, targets)(aliasModel, context, { apiKey: "sk-ant-test", reasoning: "high" } as any).result();
    const replayed = JSON.parse(body).messages.find((message: { role: string }) => message.role === "assistant");
    return replayed.content.map((block: { type: string }) => block.type);
  } finally {
    server.close();
  }
}

test("a renamed alias replays its earlier thinking exactly as a same-id alias does", async () => {
  const sameId = await captureThinkingReplay(TARGET);
  assert.ok(sameId.includes("thinking"), `control: ${sameId}`);
  assert.deepEqual(await captureThinkingReplay("opus-renamed"), sameId);
});

test("Pi's turn-prefix and history summaries on a dual-window alias are not stopped at the visible edge", async () => {
  const config: ModelAliasesConfig = { enabled: true, aliases: [{ provider: "alias-test", id: "visible-20k", targetProvider: "alias-target", targetModel: "target-100k", api: "alias-test-api", baseUrl: "http://127.0.0.1/never", contextWindow: 20_000, targetContextWindow: 100_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] };
  const target = { provider: "alias-target", id: "target-100k", name: "target", api: "alias-test-api", baseUrl: "http://127.0.0.1/never", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as Model<any>;
  const delegated: string[] = [];
  const aliasStream = createAliasStreamSimple(buildAliasLookup(config), buildTargetModelLookup(config, [target]), (model, context) => {
    delegated.push(JSON.stringify(context.messages.at(-1)).slice(0, 40));
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "summary" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
    return stream;
  });
  const aliasModel = { ...target, provider: "alias-test", id: "visible-20k", api: "model-aliases", contextWindow: 20_000 } as Model<any>;
  // ~31k estimated tokens: past the 20k visible window, inside the 100k target window.
  const prefix = [{ role: "user", content: [{ type: "text", text: "earlier work in this same turn ".repeat(4_000) }], timestamp: 1 }];
  const fileOps = () => ({ read: new Set(), written: new Set(), edited: new Set() });
  await compact({ firstKeptEntryId: "k", messagesToSummarize: prefix, turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 30_000, previousSummary: undefined, fileOps: fileOps(), settings: {} } as any,
    aliasModel, "key", undefined, undefined, undefined, undefined, aliasStream as any);
  await compact({ firstKeptEntryId: "k", messagesToSummarize: [], turnPrefixMessages: prefix, isSplitTurn: true, tokensBefore: 30_000, previousSummary: "earlier summary", fileOps: fileOps(), settings: {} } as any,
    aliasModel, "key", undefined, undefined, undefined, undefined, aliasStream as any);
  assert.equal(delegated.length, 2, "both summaries reached the target model");
});
