import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAliasLookup,
  buildProviderRegistrations,
  getAliasForModel,
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
