import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { test } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";

import {
  CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL,
  CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL,
  MODEL_ALIASES_PACKAGE_NAME,
  buildAliasLookup,
  buildProviderRegistrations,
  getAliasForModel,
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

test("buildProviderRegistrations registers synthetic aliases by inheriting from the target model", () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai-1m",
        providerName: "OpenAI 1M Context",
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
  assert.equal(registrations[0]?.provider, "openai-1m");
  assert.deepEqual(registrations[0]?.config, {
    name: "OpenAI 1M Context",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "$OPENAI_API_KEY",
    api: "openai-responses",
    models: [
      {
        id: "gpt-5.5-1m",
        name: "GPT-5.5 1M",
        api: "openai-responses",
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

test("configured alias wins when provider/id clashes with an existing model and preserves sibling models", () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.5",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        name: "GPT-5.5 Local Override",
        contextWindow: 1050000,
      },
    ],
  };

  const registrations = buildProviderRegistrations(config, existingModels);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0]?.provider, "openai");
  assert.equal((registrations[0]?.config.models as unknown[]).length, 2);
  assert.deepEqual(registrations[0]?.config, {
    name: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "$OPENAI_API_KEY",
    api: "openai-responses",
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5 Local Override",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh" },
        input: ["text", "image"],
        contextWindow: 1050000,
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

test("buildAliasLookup and getAliasForModel find configured aliases only", () => {
  const config: ModelAliasesConfig = {
    enabled: true,
    aliases: [
      {
        provider: "openai-1m",
        id: "gpt-5.5-1m",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
      },
    ],
  };
  const lookup = buildAliasLookup(config);

  assert.equal(getAliasForModel(lookup, { provider: "openai-1m", id: "gpt-5.5-1m" })?.targetModel, "gpt-5.5");
  assert.equal(getAliasForModel(lookup, { provider: "openai", id: "gpt-5.5" }), undefined);
});

test("rewriteModelAliasPayload preserves payload fields and swaps model", () => {
  const payload = rewriteModelAliasPayload({ model: "gpt-5.5-1m", input: "hello", store: false }, "gpt-5.5");

  assert.deepEqual(payload, { model: "gpt-5.5", input: "hello", store: false });
  assert.equal(rewriteModelAliasPayload(null, "gpt-5.5"), undefined);
  assert.equal(rewriteModelAliasPayload([], "gpt-5.5"), undefined);
});
