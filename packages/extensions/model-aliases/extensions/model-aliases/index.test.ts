import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  isContextOverflow,
  type AssistantMessage,
  type Context,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Hermetic by intent: the integration test registers its own provider and never
// needs a remote catalog, but ModelRuntime.create still fetches pi.dev provider
// catalogs unless pi is told it is offline — a slow leg there costs 15s per
// creation (pi's abort bound) and times the test out.
process.env.PI_OFFLINE ??= "1";

import {
  CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL,
  CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL,
  MODEL_ALIASES_API,
  MODEL_ALIASES_PACKAGE_NAME,
  buildAliasLookup,
  buildProviderRegistrations,
  buildTargetModelLookup,
  createAliasStreamSimple,
  estimateAliasRequestTokens,
  findUnpricedAliases,
  getAliasForModel,
  isPiSummarizationRequest,
  registerCheckerModelBootstrap,
  rewriteModelAliasPayload,
} from "./index.ts";
import type { ModelAliasesConfig } from "./config.ts";

const existingModels = [
  {
    provider: "openai",
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow: 272000,
    maxTokens: 128000,
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
  },
  {
    provider: "openai",
    id: "gpt-5.5-pro",
    name: "GPT-5.5 Pro",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow: 1050000,
    maxTokens: 128000,
    cost: { input: 15, output: 120, cacheRead: 1.5, cacheWrite: 0 },
  },
];

test("Pi extension loader loads model-aliases and registers the hidden alias API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-aliases-loader-"));
  const previousPiAgentHome = process.env.PI_AGENT_HOME;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    process.env.PI_AGENT_HOME = dir;
    writeFileSync(
      join(dir, "model-aliases.json"),
      JSON.stringify({
        enabled: true,
        aliases: [
          {
            provider: "openai",
            id: "gpt-5.5-1m",
            targetProvider: "openai",
            targetModel: "gpt-5.5",
            apiKey: "$OPENAI_API_KEY",
            contextWindow: 1050000,
            maxTokens: 128000,
          },
        ],
      }),
    );
    mkdirSync(join(dir, ".pi"));

    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      additionalExtensionPaths: [new URL("./index.ts", import.meta.url).pathname],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();

    assert.deepEqual(loaded.errors, []);
    assert.equal(
      loaded.extensions.some((extension) => extension.path.replaceAll("\\", "/").endsWith("extensions/model-aliases/index.ts")),
      true,
    );

    ({ session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      sessionManager: SessionManager.inMemory(dir),
      resourceLoader: loader,
      tools: [],
    }));

    const alias = session.modelRuntime.getModel("openai", "gpt-5.5-1m");
    const target = session.modelRuntime.getModel("openai", "gpt-5.5");

    assert.ok(alias);
    assert.equal(alias.api, MODEL_ALIASES_API);
    assert.equal(alias.contextWindow, 1050000);
    assert.equal(alias.maxTokens, 128000);
    assert.ok(target);
    assert.equal(target.api, "openai-responses");
  } finally {
    session?.dispose();
    if (previousPiAgentHome === undefined) {
      delete process.env.PI_AGENT_HOME;
    } else {
      process.env.PI_AGENT_HOME = previousPiAgentHome;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dual-window alias uses Pi's native compact-and-retry before another oversized provider request", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-aliases-compaction-"));
  const workspace = join(dir, "workspace");
  const agentDir = join(dir, "agent");
  const targetApi = "model-aliases-compaction-test";
  const timeline: string[] = [];
  const targetRequests: Array<{ kind: "regular" | "summary"; serializedTokens: number }> = [];
  let regularCalls = 0;
  let summaryCalls = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ compaction: { enabled: true, reserveTokens: 2_000, keepRecentTokens: 200 } }),
    );

    const settingsManager = SettingsManager.create(workspace, agentDir);
    assert.equal(settingsManager.getCompactionEnabled(), true);
    assert.equal(settingsManager.getCompactionKeepRecentTokens(), 200);
    settingsManager.setProjectTrusted(true);
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const credentials = new InMemoryCredentialStore();
    await credentials.modify("alias-test", async () => ({ type: "api_key", key: "deterministic-test-key" }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null });
    const targetStreamSimple = (selectedModel: Model<any>, context: Context) => {
      const isSummary = isPiSummarizationRequest(context);
      targetRequests.push({ kind: isSummary ? "summary" : "regular", serializedTokens: serializedContextTokens(context) });
      if (isSummary) {
        summaryCalls += 1;
        timeline.push("summary-request");
        return assistantTextStream(selectedModel, "Compacted test history with the probe result preserved.", 500);
      }

      regularCalls += 1;
      timeline.push(`regular-request-${regularCalls}`);
      if (regularCalls === 1) {
        return assistantToolCallStream(
          selectedModel,
          { type: "toolCall", id: "probe-call", name: "probe", arguments: {} },
          21_000,
          "summary-only padding ".repeat(6_000),
        );
      }
      return assistantTextStream(selectedModel, "resumed after compaction", 700);
    };
    const integrationConfig: ModelAliasesConfig = {
      enabled: true,
      aliases: [
        {
          provider: "alias-test",
          id: "visible-20k",
          targetProvider: "alias-target",
          targetModel: "target-100k",
          api: targetApi,
          baseUrl: "http://127.0.0.1/never-called",
          contextWindow: 20_000,
          targetContextWindow: 100_000,
          maxTokens: 4_096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    };
    const targetModels = [
      {
        provider: "alias-target",
        id: "target-100k",
        api: targetApi,
        baseUrl: "http://127.0.0.1/never-called",
        contextWindow: 100_000,
        maxTokens: 4_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    const aliasStream = createAliasStreamSimple(
      buildAliasLookup(integrationConfig),
      buildTargetModelLookup(integrationConfig, targetModels),
      targetStreamSimple,
    );
    const registration = buildProviderRegistrations(integrationConfig, targetModels, aliasStream)[0]!;
    runtime.registerProvider(registration.provider, registration.config);

    ({ session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      sessionManager: SessionManager.inMemory(workspace),
      settingsManager,
      modelRuntime: runtime,
      resourceLoader: loader,
      tools: ["probe"],
      customTools: [
        {
          name: "probe",
          label: "Probe",
          description: "Return a deterministic result for compaction testing",
          parameters: Type.Object({}),
          async execute() {
            return { content: [{ type: "text" as const, text: "probe completed ".repeat(100) }], details: {} };
          },
        },
      ],
    }));

    const alias = session.modelRuntime.getModel("alias-test", "visible-20k");
    assert.ok(alias);
    await session.setModel(alias);
    session.subscribe((event) => {
      if (event.type === "compaction_end" && !event.aborted) {
        timeline.push(event.errorMessage ? `compaction-error:${event.errorMessage}` : "compaction-end");
      }
    });

    await session.prompt(`Run the probe and then report completion.\n${"context padding ".repeat(300)}`);

    const compactions = session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.equal(regularCalls, 2, "one request before the edge and one native retry after compaction");
    assert.ok(summaryCalls >= 1, "Pi generated the compaction summary through the alias route");
    assert.deepEqual(timeline.filter((item) => item.startsWith("regular") || item === "compaction-end"), [
      "regular-request-1",
      "compaction-end",
      "regular-request-2",
    ]);
    const regularTargetRequests = targetRequests.filter((request) => request.kind === "regular");
    const summaryTargetRequests = targetRequests.filter((request) => request.kind === "summary");
    assert.ok(regularTargetRequests.every((request) => request.serializedTokens < 20_000));
    assert.ok(summaryTargetRequests.some((request) => request.serializedTokens >= 20_000));
    assert.ok(summaryTargetRequests.every((request) => request.serializedTokens < 100_000));
    assert.equal(session.getLastAssistantText(), "resumed after compaction");

    const overflowEntries = session.sessionManager.getEntries().filter(
      (entry) => entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.stopReason === "error" &&
        isContextOverflow(entry.message, 20_000),
    );
    assert.equal(overflowEntries.length, 1, "the synthetic overflow is persisted for audit but removed from retry context");
  } finally {
    session?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registerCheckerModelBootstrap emits this extension entrypoint when requested", () => {
  const events = createEventBus();
  const registrations: unknown[] = [];
  events.on(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, (data) => registrations.push(data));

  registerCheckerModelBootstrap({ events });
  events.emit(CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL, { protocolVersion: 1 });

  assert.equal(registrations.length, 1);
  const registration = registrations[0];
  assert.equal(typeof registration, "object");
  assert.notEqual(registration, null);
  const payload = registration as { kind?: unknown; toolSurface?: unknown; packageName?: unknown; extensionPath?: unknown };
  assert.equal(payload.kind, "model-provider-bootstrap");
  assert.equal(payload.toolSurface, "none");
  assert.equal(payload.packageName, MODEL_ALIASES_PACKAGE_NAME);
  assert.equal(typeof payload.extensionPath, "string");
  assert.equal(isAbsolute(payload.extensionPath as string), true);
  assert.equal((payload.extensionPath as string).replaceAll("\\", "/").endsWith("extensions/model-aliases/checker-bootstrap.ts"), true);
});

test("registerCheckerModelBootstrap unsubscribes its request listener on session shutdown", () => {
  const events = createEventBus();
  const registrations: unknown[] = [];
  let shutdown: (() => void) | undefined;
  events.on(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, (data) => registrations.push(data));

  registerCheckerModelBootstrap({
    events,
    on(event, handler) {
      assert.equal(event, "session_shutdown");
      shutdown = handler;
    },
  });
  events.emit(CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL, { protocolVersion: 1 });
  shutdown?.();
  events.emit(CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL, { protocolVersion: 1 });

  assert.equal(registrations.length, 1);
});

test("buildProviderRegistrations registers same-provider aliases with a hidden alias API", () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.5-1m",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        name: "GPT-5.5 1M",
        apiKey: "$OPENAI_API_KEY",
        contextWindow: 1050000,
      },
    ],
  };

  const registrations = buildProviderRegistrations(config, existingModels);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.provider, "openai");
  assert.equal(typeof registrations[0]?.config.streamSimple, "function");
  assert.deepEqual(withoutStreamSimple(registrations[0]!.config), {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "$OPENAI_API_KEY",
    api: MODEL_ALIASES_API,
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
        input: ["text", "image"],
        contextWindow: 272000,
        maxTokens: 128000,
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      },
      {
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1050000,
        maxTokens: 128000,
        cost: { input: 15, output: 120, cacheRead: 1.5, cacheWrite: 0 },
      },
      {
        id: "gpt-5.5-1m",
        name: "GPT-5.5 1M",
        api: MODEL_ALIASES_API,
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
        input: ["text", "image"],
        contextWindow: 1050000,
        maxTokens: 128000,
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      },
    ],
  });
});

test("configured dual-window alias wins when provider/id clashes and preserves sibling models", () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.5",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        name: "GPT-5.5 Local Override",
        contextWindow: 372000,
        targetContextWindow: 1050000,
      },
    ],
  };

  const registrations = buildProviderRegistrations(config, existingModels);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.provider, "openai");
  assert.equal((registrations[0]?.config.models as unknown[]).length, 2);
  assert.equal(typeof registrations[0]?.config.streamSimple, "function");
  assert.deepEqual(withoutStreamSimple(registrations[0]!.config), {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "$OPENAI_API_KEY",
    api: MODEL_ALIASES_API,
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5 Local Override",
        api: MODEL_ALIASES_API,
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
        input: ["text", "image"],
        contextWindow: 372000,
        maxTokens: 128000,
        cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      },
      {
        id: "gpt-5.5-pro",
        name: "GPT-5.5 Pro",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1050000,
        maxTokens: 128000,
        cost: { input: 15, output: 120, cacheRead: 1.5, cacheWrite: 0 },
      },
    ],
  });
});

test("target context window falls back to the visible alias window", () => {
  const targets = buildTargetModelLookup(
    {
      enabled: true,
      aliases: [
        {
          provider: "openai",
          id: "gpt-5.5-compact",
          targetProvider: "openai",
          targetModel: "gpt-5.5",
          contextWindow: 64000,
        },
      ],
    },
    existingModels,
  );

  assert.equal(targets.get("openai/gpt-5.5-compact")?.contextWindow, 64000);
});

test("buildAliasLookup and getAliasForModel find configured aliases only", () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.5-1m",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
      },
    ],
  };
  const lookup = buildAliasLookup(config);

  assert.equal(getAliasForModel(lookup, { provider: "openai", id: "gpt-5.5-1m" })?.targetModel, "gpt-5.5");
  assert.equal(getAliasForModel(lookup, { provider: "openai", id: "gpt-5.5" }), undefined);
});

test("default alias stream delegate lazily resolves compat outside Pi's extension loader", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "probe",
        id: "alias",
        targetProvider: "probe",
        targetModel: "target",
      },
    ],
  };
  const streamSimple = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, [{ provider: "probe", id: "target", api: "no-such-api" }]),
  );

  const stream = streamSimple({ provider: "probe", id: "alias", api: MODEL_ALIASES_API } as any, { messages: [] } as any);
  const result = await stream.result();

  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "No API provider registered for api: no-such-api");
});

test("hidden alias stream delegates with the target context window without payload hooks", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.5-1m",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        contextWindow: 372000,
        targetContextWindow: 1050000,
      },
    ],
  };
  const aliasLookup = buildAliasLookup(config);
  const targetLookup = buildTargetModelLookup(config, existingModels);
  const calls: Array<{ provider: string; id: string; api?: string; contextWindow?: number; optionKeys: string[] }> = [];
  const streamSimple = createAliasStreamSimple(aliasLookup, targetLookup, (model, _context, options) => {
    calls.push({
      provider: model.provider,
      id: model.id,
      api: model.api,
      contextWindow: model.contextWindow,
      optionKeys: Object.keys(options ?? {}).sort(),
    });
    return fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id });
  });

  const stream = streamSimple(
    { provider: "openai", id: "gpt-5.5-1m", api: MODEL_ALIASES_API } as any,
    { messages: [] } as any,
    { maxTokens: 2048, apiKey: "test-key" },
  );
  const result = await stream.result();

  assert.deepEqual(calls, [
    {
      provider: "openai",
      id: "gpt-5.5",
      api: "openai-responses",
      contextWindow: 1050000,
      optionKeys: ["apiKey", "maxTokens"],
    },
  ]);
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-5.5-1m");
  assert.equal(result.api, "openai-responses");
});

test("dual-window alias stops the next request at its visible context edge", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        contextWindow: 372000,
        targetContextWindow: 1050000,
      },
    ],
  };
  let delegated = 0;
  const streamSimple = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, existingModels),
    (model) => {
      delegated += 1;
      return fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id });
    },
  );
  const context = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "tool call completed" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.6-sol",
        usage: usageWithTotal(371997),
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "eight chars" }],
        isError: false,
        timestamp: 2,
      },
    ],
  };

  assert.equal(estimateAliasRequestTokens(context as any), 372000);
  const result = await streamSimple(
    { provider: "openai", id: "gpt-5.6-sol", api: MODEL_ALIASES_API, contextWindow: 372000 } as any,
    context as any,
  ).result();

  assert.equal(delegated, 0, "the oversized request never reaches the 1.05M target");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-5.6-sol");
  assert.equal(result.stopReason, "error");
  assert.equal(isContextOverflow(result, 372000), true, "Pi recognizes the synthetic error and runs native compact-and-retry");
  assert.match(result.errorMessage ?? "", /estimated request context 372000.*operating window of 372000/);
});

test("dual-window alias enforces the visible edge before any assistant usage exists", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "tiny-visible-window",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        contextWindow: 10,
        targetContextWindow: 100,
      },
    ],
  };
  let delegated = 0;
  const streamSimple = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, existingModels),
    (model) => {
      delegated += 1;
      return fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id });
    },
  );
  const context = {
    systemPrompt: "12345678", // 2 tokens
    tools: [{ name: "x" }], // 4 serialized tokens
    messages: [{ role: "user", content: [{ type: "text", text: "1234567890123456" }], timestamp: 1 }], // 4 tokens
  };

  assert.equal(estimateAliasRequestTokens(context as any), 10);
  const result = await streamSimple(
    { provider: "openai", id: "tiny-visible-window", api: MODEL_ALIASES_API, contextWindow: 10 } as any,
    context as any,
  ).result();

  assert.equal(delegated, 0);
  assert.equal(isContextOverflow(result, 10), true);
});

test("request estimation ignores retained assistant usage older than a compaction summary", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "tiny-visible-window",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        contextWindow: 4,
        targetContextWindow: 100,
      },
    ],
  };
  let delegated = 0;
  const streamSimple = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, existingModels),
    (model) => {
      delegated += 1;
      return fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id });
    },
  );
  const context = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "compact summary!" }],
        timestamp: 100,
      },
      {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "tiny-visible-window",
        usage: usageWithTotal(100),
        stopReason: "toolUse",
        timestamp: 50,
      },
    ],
  };

  assert.equal(estimateAliasRequestTokens(context as any), 4);
  const result = await streamSimple(
    { provider: "openai", id: "tiny-visible-window", api: MODEL_ALIASES_API, contextWindow: 4 } as any,
    context as any,
  ).result();

  assert.equal(delegated, 0);
  assert.equal(isContextOverflow(result, 4), true);
});

test("request estimation ignores errored and aborted assistant usage", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "tiny-visible-window",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        contextWindow: 10,
        targetContextWindow: 100,
      },
    ],
  };
  let delegated = 0;
  const streamSimple = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, existingModels),
    (model) => {
      delegated += 1;
      return fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id });
    },
  );

  for (const stopReason of ["error", "aborted"] as const) {
    const context = {
      messages: [
        {
          role: "assistant",
          content: [],
          api: "openai-responses",
          provider: "openai",
          model: "tiny-visible-window",
          usage: usageWithTotal(6),
          stopReason: "toolUse",
          timestamp: 1,
        },
        {
          role: "assistant",
          content: [],
          api: "openai-responses",
          provider: "openai",
          model: "tiny-visible-window",
          usage: usageWithTotal(100),
          stopReason,
          timestamp: 2,
        },
        {
          role: "user",
          content: [{ type: "text", text: "1234567890123456" }],
          timestamp: 3,
        },
      ],
    };

    assert.equal(estimateAliasRequestTokens(context as any), 10, stopReason);
    const result = await streamSimple(
      { provider: "openai", id: "tiny-visible-window", api: MODEL_ALIASES_API, contextWindow: 10 } as any,
      context as any,
    ).result();
    assert.equal(isContextOverflow(result, 10), true, stopReason);
  }
  assert.equal(delegated, 0);
});

test("dual-window alias counts newly loaded tool definitions at the visible edge", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "tiny-visible-window",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        contextWindow: 10,
        targetContextWindow: 100,
      },
    ],
  };
  let delegated = 0;
  const streamSimple = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, existingModels),
    (model) => {
      delegated += 1;
      return fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id });
    },
  );
  const context = {
    tools: [{ name: "x" }],
    messages: [
      {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "tiny-visible-window",
        usage: usageWithTotal(6),
        stopReason: "toolUse",
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "load_tools",
        content: [],
        addedToolNames: ["x"],
        isError: false,
        timestamp: 2,
      },
    ],
  };

  assert.equal(estimateAliasRequestTokens(context as any), 10);
  const result = await streamSimple(
    { provider: "openai", id: "tiny-visible-window", api: MODEL_ALIASES_API, contextWindow: 10 } as any,
    context as any,
  ).result();

  assert.equal(delegated, 0);
  assert.equal(isContextOverflow(result, 10), true);
});

test("dual-window alias delegates normally while the estimated request stays below its visible edge", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        contextWindow: 372000,
        targetContextWindow: 1050000,
      },
    ],
  };
  let delegated = 0;
  const streamSimple = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, existingModels),
    (model) => {
      delegated += 1;
      return fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id });
    },
  );

  const result = await streamSimple(
    { provider: "openai", id: "gpt-5.6-sol", api: MODEL_ALIASES_API, contextWindow: 372000 } as any,
    {
      messages: [
        {
          role: "assistant",
          content: [],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.6-sol",
          usage: usageWithTotal(371999),
          stopReason: "toolUse",
          timestamp: 1,
        },
      ],
    } as any,
  ).result();

  assert.equal(delegated, 1);
  assert.equal(result.stopReason, "stop");
});

test("same-window aliases keep provider-owned context enforcement", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.5-1m",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        contextWindow: 1050000,
        targetContextWindow: 1050000,
      },
    ],
  };
  let delegated = 0;
  const streamSimple = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, existingModels),
    (model) => {
      delegated += 1;
      return fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id });
    },
  );

  await streamSimple(
    { provider: "openai", id: "gpt-5.5-1m", api: MODEL_ALIASES_API, contextWindow: 1050000 } as any,
    {
      messages: [
        {
          role: "assistant",
          content: [],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.5-1m",
          usage: usageWithTotal(1050000),
          stopReason: "toolUse",
          timestamp: 1,
        },
      ],
    } as any,
  ).result();

  assert.equal(delegated, 1, "aliases without a larger target window retain their existing provider path");
});

test("hidden alias stream rewrites streamed events back to alias identity", async () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.5-1m",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
      },
    ],
  };
  const streamSimple = createAliasStreamSimple(buildAliasLookup(config), buildTargetModelLookup(config, existingModels), (model) =>
    fakeAssistantStream({ api: model.api, provider: model.provider, model: model.id }),
  );

  const stream = streamSimple({ provider: "openai", id: "gpt-5.5-1m", api: MODEL_ALIASES_API } as any, { messages: [] } as any);
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }

  assert.equal(events[0]?.type, "start");
  if (events[0]?.type === "start") {
    assert.equal(events[0].partial.provider, "openai");
    assert.equal(events[0].partial.model, "gpt-5.5-1m");
  }
  assert.equal(events[1]?.type, "done");
  if (events[1]?.type === "done") {
    assert.equal(events[1].message.provider, "openai");
    assert.equal(events[1].message.model, "gpt-5.5-1m");
  }
});

test("rewriteModelAliasPayload preserves payload fields and swaps model", () => {
  const payload = rewriteModelAliasPayload({ model: "gpt-5.5-1m", input: "hello", store: false }, "gpt-5.5");

  assert.deepEqual(payload, { model: "gpt-5.5", input: "hello", store: false });
  assert.equal(rewriteModelAliasPayload(null, "gpt-5.5"), undefined);
  assert.equal(rewriteModelAliasPayload([], "gpt-5.5"), undefined);
});

function withoutStreamSimple(config: Record<string, unknown>): Record<string, unknown> {
  const { streamSimple, ...rest } = config;
  assert.equal(typeof streamSimple, "function");
  return rest;
}

function assistantTextStream(model: Model<any>, text: string, totalTokens: number) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(model, "stop", totalTokens);
  message.content = [{ type: "text", text }];
  queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
  return stream;
}

function assistantToolCallStream(model: Model<any>, toolCall: ToolCall, totalTokens: number, leadingText?: string) {
  const stream = createAssistantMessageEventStream();
  const message = assistantMessage(model, "toolUse", totalTokens);
  message.content = [...(leadingText ? [{ type: "text" as const, text: leadingText }] : []), toolCall];
  queueMicrotask(() => stream.push({ type: "done", reason: "toolUse", message }));
  return stream;
}

function assistantMessage(model: Model<any>, stopReason: AssistantMessage["stopReason"], totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usageWithTotal(totalTokens),
    stopReason,
    timestamp: Date.now(),
  };
}

function serializedContextTokens(context: Context): number {
  return Math.ceil(JSON.stringify({
    systemPrompt: context.systemPrompt,
    messages: context.messages,
    tools: context.tools,
  }).length / 4);
}

function usageWithTotal(totalTokens: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function fakeAssistantStream(identity: { api?: string; provider: string; model: string }) {
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    api: identity.api ?? "fake-api",
    provider: identity.provider,
    model: identity.model,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start" as const, partial: message };
      yield { type: "done" as const, reason: "stop" as const, message };
    },
    async result() {
      return message;
    },
  } as any;
}

test("findUnpricedAliases names aliases whose per-token price cannot be resolved", () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      // Inherits real pricing from a target pi already knows.
      { provider: "openai", id: "priced-by-target", targetProvider: "openai", targetModel: "gpt-5.5" },
      // Explicit price of its own.
      {
        provider: "openai",
        id: "priced-explicitly",
        targetProvider: "openai",
        targetModel: "not-in-registry",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
      // Neither: real spend would be counted at $0.
      { provider: "openai", id: "unpriced", targetProvider: "openai", targetModel: "also-not-in-registry" },
    ],
  };

  assert.deepEqual(findUnpricedAliases(config, existingModels), ["openai/unpriced"]);
});

test("findUnpricedAliases reports nothing when aliasing is disabled", () => {
  const config: ModelAliasesConfig = {
    enabled: false,
    aliases: [{ provider: "openai", id: "unpriced", targetProvider: "openai", targetModel: "missing" }],
  };
  assert.deepEqual(findUnpricedAliases(config, existingModels), []);
});

test("the live alias configuration shape inherits pricing rather than falling back to zero", () => {
  // Guards the trap this change was made for: aliases like gpt-5.6-sol/luna carry no
  // cost block, so they are only priced correctly while their target resolves.
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      { provider: "openai", id: "gpt-5.6-sol", targetProvider: "openai", targetModel: "gpt-5.5", apiKey: "$OPENAI_API_KEY" },
    ],
  };
  assert.deepEqual(findUnpricedAliases(config, existingModels), []);
  const registration = buildProviderRegistrations(config, existingModels)[0]!;
  const alias = (registration.config.models as Array<Record<string, unknown>>).find((m) => m.id === "gpt-5.6-sol");
  assert.deepEqual(alias?.cost, { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
});
