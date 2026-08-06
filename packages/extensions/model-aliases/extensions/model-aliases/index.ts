import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime, VERSION, type EventBus } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { loadConfig, type ModelAliasConfig, type ModelAliasesConfig } from "./config.ts";

interface ExistingModel {
  id: string;
  name?: string;
  api?: string;
  provider: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface ProviderRegistration {
  provider: string;
  config: Record<string, unknown>;
}

type AliasLookup = Map<string, ModelAliasConfig>;
type TargetModelLookup = Map<string, ExistingModel>;
type AliasStreamDelegate = (
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
type PiAiCompatModule = {
  streamSimple?: AliasStreamDelegate;
  lazyStream?: (
    model: Model<any>,
    setup: () => Promise<AsyncIterable<AssistantMessageEvent>> | AsyncIterable<AssistantMessageEvent>,
  ) => AssistantMessageEventStream;
};

type ModelAliasesHost = {
  events?: Pick<EventBus, "emit" | "on">;
  on?: (event: "session_shutdown", handler: () => void) => void;
};

export const CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION = 1;
export const CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL = "goal-controller:checker-model-bootstrap:request";
export const CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL = "goal-controller:checker-model-bootstrap:register";
export const CHECKER_MODEL_BOOTSTRAP_KIND = "model-provider-bootstrap";
export const CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE = "none";
export const MODEL_ALIASES_PACKAGE_NAME = "@doodledood/pi-model-aliases";
export const MODEL_ALIASES_API = "model-aliases";

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4_800;
const PI_SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export function registerCheckerModelBootstrap(
  pi: ModelAliasesHost,
  extensionPath = fileURLToPath(new URL("./checker-bootstrap.ts", import.meta.url)),
): void {
  const events = pi.events;
  const normalizedPath = extensionPath.trim();
  if (!events || normalizedPath.length === 0) return;

  const unsubscribe = events.on(CHECKER_MODEL_BOOTSTRAP_REQUEST_CHANNEL, () => {
    events.emit(CHECKER_MODEL_BOOTSTRAP_REGISTER_CHANNEL, {
      protocolVersion: CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION,
      kind: CHECKER_MODEL_BOOTSTRAP_KIND,
      toolSurface: CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE,
      packageName: MODEL_ALIASES_PACKAGE_NAME,
      extensionPath: normalizedPath,
    });
  });
  let subscribed = true;
  pi.on?.("session_shutdown", () => {
    if (!subscribed) return;
    subscribed = false;
    unsubscribe();
  });
}

/** Pi 0.80.8 reworked the model/auth runtime (ModelRuntime); older APIs are gone. */
export function assertMinimumPiVersion(version: string, minimum = "0.80.8"): void {
  const parse = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parse(version), parse(minimum)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return;
    if ((a[i] ?? 0) < (b[i] ?? 0)) throw new Error(`model-aliases requires pi >= ${minimum} (running ${version}) — update pi or the pi-plugins package`);
  }
}

export default async function modelAliases(pi: any) {
  assertMinimumPiVersion(VERSION);
  registerCheckerModelBootstrap(pi);
  await activateModelAliases(pi);
}

export async function activateModelAliases(pi: any): Promise<void> {
  const config = loadConfig();
  if (!config.enabled) return;

  // Async factories are awaited by pi before session_start and before queued
  // pi.registerProvider() registrations are flushed, so this stays safe.
  const currentRegistry = new ModelRegistry(await ModelRuntime.create());
  const existingModels = currentRegistry.getAll() as ExistingModel[];
  const aliasLookup = buildAliasLookup(config);
  const targetLookup = buildTargetModelLookup(config, existingModels);
  const aliasStreamSimple = createAliasStreamSimple(aliasLookup, targetLookup);

  // An alias with neither its own price nor a resolvable target price would report
  // real token spend at $0. Pi still needs a cost object, so the zero stays — but it
  // is announced here rather than quietly distorting every cost surface.
  const unpriced = findUnpricedAliases(config, existingModels);
  if (unpriced.length > 0) {
    console.warn(
      `[model-aliases] No price resolved for ${unpriced.join(", ")} — usage on ${
        unpriced.length === 1 ? "this alias" : "these aliases"
      } will be counted at $0. Add a "cost" block to the alias, or point targetModel at a model pi already prices.`,
    );
  }

  for (const registration of buildProviderRegistrations(config, existingModels, aliasStreamSimple)) {
    try {
      pi.registerProvider(registration.provider, registration.config);
    } catch (error) {
      console.warn(
        `[model-aliases] Failed to register provider ${registration.provider}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Compatibility fallback for provider calls that still run Pi's payload hook.
  // The hidden MODEL_ALIASES_API stream below is the primary aliasing mechanism,
  // because Pi-owned calls such as compaction and branch summaries may not pass
  // before_provider_request/onPayload hooks.
  pi.on("before_provider_request", (event: any, ctx: any) => {
    const alias = getAliasForModel(aliasLookup, ctx.model);
    if (!alias) return undefined;
    return rewriteModelAliasPayload(event.payload, alias.targetModel);
  });
}

/**
 * Aliases whose per-token price cannot be resolved: no explicit `cost`, and no
 * target model in pi's registry to inherit one from. Returned as `provider/id`.
 */
export function findUnpricedAliases(config: ModelAliasesConfig, existingModels: ExistingModel[] = []): string[] {
  if (!config.enabled) return [];
  const targetModelByKey = new Map(existingModels.map((model) => [modelKey(model.provider, model.id), model]));
  const unpriced: string[] = [];
  for (const alias of config.aliases) {
    if (alias.cost) continue;
    const inherited = inheritedModelForAlias(alias, targetModelByKey);
    if (!inherited?.cost) unpriced.push(modelKey(alias.provider, alias.id));
  }
  return unpriced;
}

export function buildProviderRegistrations(
  config: ModelAliasesConfig,
  existingModels: ExistingModel[] = [],
  aliasStreamSimple: AliasStreamDelegate = createAliasStreamSimple(
    buildAliasLookup(config),
    buildTargetModelLookup(config, existingModels),
  ),
): ProviderRegistration[] {
  if (!config.enabled) return [];

  const grouped = new Map<string, ModelAliasConfig[]>();
  for (const alias of config.aliases) {
    const aliases = grouped.get(alias.provider) ?? [];
    aliases.push(alias);
    grouped.set(alias.provider, aliases);
  }

  const targetModelByKey = new Map(existingModels.map((model) => [modelKey(model.provider, model.id), model]));

  return [...grouped.entries()].map(([provider, aliases]) => {
    const providerExistingModels = existingModels.filter((model) => model.provider === provider);
    const modelById = new Map<string, Record<string, unknown>>();

    for (const model of providerExistingModels) {
      modelById.set(model.id, existingModelToProviderModel(model));
    }

    for (const alias of aliases) {
      const inherited = inheritedModelForAlias(alias, targetModelByKey);
      modelById.set(alias.id, aliasToProviderModel(alias, inherited));
    }

    const firstAlias = aliases[0]!;
    const firstExisting = providerExistingModels[0];
    const firstTarget = targetModelByKey.get(modelKey(firstAlias.targetProvider, firstAlias.targetModel));
    const firstModel = firstTarget ?? firstExisting;

    return {
      provider,
      config: pruneUndefined({
        name: providerDisplayName(firstAlias),
        baseUrl: firstAlias.baseUrl ?? firstModel?.baseUrl,
        apiKey: firstAlias.apiKey ?? defaultApiKeyForProvider(firstAlias.targetProvider),
        api: MODEL_ALIASES_API,
        streamSimple: aliasStreamSimple,
        headers: firstAlias.headers,
        authHeader: firstAlias.authHeader,
        models: [...modelById.values()],
      }),
    };
  });
}

export function buildAliasLookup(config: ModelAliasesConfig): AliasLookup {
  const lookup: AliasLookup = new Map();
  if (!config.enabled) return lookup;

  for (const alias of config.aliases) {
    lookup.set(modelKey(alias.provider, alias.id), alias);
  }

  return lookup;
}

export function buildTargetModelLookup(
  config: ModelAliasesConfig,
  existingModels: ExistingModel[] = [],
): TargetModelLookup {
  const lookup: TargetModelLookup = new Map();
  if (!config.enabled) return lookup;

  const targetModelByKey = new Map(existingModels.map((model) => [modelKey(model.provider, model.id), model]));
  for (const alias of config.aliases) {
    const inherited = inheritedModelForAlias(alias, targetModelByKey);
    lookup.set(modelKey(alias.provider, alias.id), aliasToTargetModel(alias, inherited));
  }

  return lookup;
}

export function getAliasForModel(lookup: AliasLookup, model: any): ModelAliasConfig | undefined {
  if (!model?.provider || !model?.id) return undefined;
  return lookup.get(modelKey(model.provider, model.id));
}

export function createAliasStreamSimple(
  aliasLookup: AliasLookup,
  targetLookup: TargetModelLookup,
  delegate: AliasStreamDelegate = defaultAliasStreamDelegate,
): AliasStreamDelegate {
  return (model, context, options) => {
    const alias = getAliasForModel(aliasLookup, model);
    const target = targetLookup.get(modelKey(model.provider, model.id));
    if (!alias || !target) {
      throw new Error(`No model alias target registered for ${model.provider}/${model.id}`);
    }

    const enforceVisibleWindow = shouldEnforceAliasContextWindow(model, target) && !isPiSummarizationRequest(context);
    const estimatedTokens = enforceVisibleWindow ? estimateAliasRequestTokens(context) : 0;
    const source = enforceVisibleWindow && estimatedTokens >= model.contextWindow
      ? createAliasContextOverflowStream(target as Model<any>, estimatedTokens, model.contextWindow)
      : delegate(target as Model<any>, context, options);
    return wrapAliasIdentityStream(source, model);
  };
}

/**
 * A dual-window alias is an operating-window contract, not just a footer label.
 * Pi checks automatic compaction after a complete agent run, but one run can span
 * many provider/tool turns. Stop the next request at the visible edge so Pi's
 * native context-overflow recovery compacts and resumes the tool loop.
 */
export function shouldEnforceAliasContextWindow(aliasModel: Model<any>, targetModel: ExistingModel): boolean {
  return aliasModel.contextWindow > 0 &&
    (targetModel.contextWindow ?? aliasModel.contextWindow) > aliasModel.contextWindow;
}

/**
 * Compaction and branch summaries must be able to read the context they are
 * replacing. They are one-off Pi-owned requests, not another normal agent turn,
 * and cannot recover from a second synthetic overflow inside summarization.
 */
export function isPiSummarizationRequest(context: Context): boolean {
  if (context.systemPrompt !== PI_SUMMARIZATION_SYSTEM_PROMPT || context.messages.length !== 1) return false;
  const message = context.messages[0];
  if (message?.role !== "user") return false;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.find((block) => block.type === "text")?.text;
  return typeof text === "string" && text.startsWith("<conversation>\n") && text.includes("\n</conversation>");
}

/** Estimate the request context with the same last-usage-plus-tail shape Pi uses. */
export function estimateAliasRequestTokens(context: Context): number {
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let usageInfo: { index: number; tokens: number } | undefined;

  for (let index = 0; index < context.messages.length; index += 1) {
    const message = context.messages[index]!;
    if (message.role === "assistant") {
      const tokens = contextTokensFromUsage(message.usage);
      if (
        message.timestamp >= latestPrefixTimestamp &&
        message.stopReason !== "aborted" &&
        message.stopReason !== "error" &&
        tokens > 0
      ) {
        usageInfo = { index, tokens };
      }
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
  }

  if (usageInfo) {
    const trailingMessages = context.messages.slice(usageInfo.index + 1);
    const addedToolNames = new Set(
      trailingMessages.flatMap((message) =>
        message.role === "toolResult" ? (message.addedToolNames ?? []) : [],
      ),
    );
    const addedTools = context.tools?.filter((tool) => addedToolNames.has(tool.name));
    return usageInfo.tokens +
      trailingMessages.reduce((total, message) => total + estimateMessageTokens(message), 0) +
      estimateJsonTokens(addedTools);
  }

  return estimateTextTokens(context.systemPrompt ?? "") +
    estimateJsonTokens(context.tools) +
    context.messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function createAliasContextOverflowStream(
  targetModel: Model<any>,
  estimatedTokens: number,
  contextWindow: number,
): AssistantMessageEventStream {
  if (estimatedTokens < contextWindow) {
    throw new Error("Alias context overflow stream requested below the configured context window");
  }

  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: targetModel.api,
    provider: targetModel.provider,
    model: targetModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: `context_length_exceeded: estimated request context ${estimatedTokens} tokens meets or exceeds the configured alias operating window of ${contextWindow} tokens`,
    timestamp: Date.now(),
  };
  queueMicrotask(() => stream.push({ type: "error", reason: "error", error }));
  return stream;
}

function contextTokensFromUsage(usage: AssistantMessage["usage"]): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function estimateMessageTokens(message: Context["messages"][number]): number {
  if (message.role === "user" || message.role === "toolResult") {
    return estimateContentTokens(message.content);
  }

  let chars = 0;
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else chars += block.name.length + safeJsonStringify(block.arguments).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function estimateContentTokens(content: Context["messages"][number]["content"]): number {
  if (typeof content === "string") return estimateTextTokens(content);
  let chars = 0;
  for (const block of content) {
    chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateJsonTokens(value: unknown): number {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return 0;
  return estimateTextTokens(safeJsonStringify(value));
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function defaultAliasStreamDelegate(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const compatModule = piAiCompat as PiAiCompatModule;
  if (typeof compatModule.streamSimple === "function") {
    return compatModule.streamSimple(model, context, options);
  }
  if (typeof compatModule.lazyStream === "function") {
    return compatModule.lazyStream(model, async () => {
      const streamSimple = await loadCompatStreamSimple();
      return streamSimple(model, context, options);
    });
  }
  throw new Error(
    "model-aliases could not resolve pi-ai streamSimple. Load this extension through Pi's extension loader or provide an explicit stream delegate.",
  );
}

async function loadCompatStreamSimple(): Promise<AliasStreamDelegate> {
  // Keep this fallback dynamic and constructed: Pi's extension loader aliases the
  // package root safely, while static package-subpath imports are the load-time
  // failure mode this extension avoids.
  const compatSpecifier = `${"@earendil-works/pi-ai"}/compat`;
  const compatModule = (await import(compatSpecifier)) as PiAiCompatModule;
  if (typeof compatModule.streamSimple !== "function") {
    throw new Error("model-aliases could not resolve pi-ai compat streamSimple.");
  }
  return compatModule.streamSimple;
}

export function rewriteModelAliasPayload(payload: unknown, targetModel: string): unknown | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

  return {
    ...(payload as Record<string, unknown>),
    model: targetModel,
  };
}

function inheritedModelForAlias(
  alias: ModelAliasConfig,
  targetModelByKey: Map<string, ExistingModel>,
): ExistingModel | undefined {
  return (
    targetModelByKey.get(modelKey(alias.targetProvider, alias.targetModel)) ??
    targetModelByKey.get(modelKey(alias.provider, alias.id))
  );
}

function aliasToProviderModel(alias: ModelAliasConfig, inherited: ExistingModel | undefined): Record<string, unknown> {
  return pruneUndefined({
    id: alias.id,
    name: alias.name ?? inherited?.name ?? alias.id,
    api: MODEL_ALIASES_API,
    baseUrl: alias.baseUrl ?? inherited?.baseUrl,
    reasoning: alias.reasoning ?? inherited?.reasoning ?? false,
    thinkingLevelMap: alias.thinkingLevelMap ?? inherited?.thinkingLevelMap,
    input: alias.input ?? inherited?.input ?? defaultInput(),
    contextWindow: alias.contextWindow ?? inherited?.contextWindow ?? 128_000,
    maxTokens: alias.maxTokens ?? inherited?.maxTokens ?? 16_384,
    cost: alias.cost ?? inherited?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: alias.compat ?? inherited?.compat,
    headers: alias.headers,
  });
}

function aliasToTargetModel(alias: ModelAliasConfig, inherited: ExistingModel | undefined): ExistingModel {
  return pruneUndefined({
    id: alias.targetModel,
    name: inherited?.name ?? alias.targetModel,
    api: alias.api ?? inherited?.api,
    provider: alias.targetProvider,
    baseUrl: alias.baseUrl ?? inherited?.baseUrl,
    reasoning: alias.reasoning ?? inherited?.reasoning ?? false,
    thinkingLevelMap: alias.thinkingLevelMap ?? inherited?.thinkingLevelMap,
    input: alias.input ?? inherited?.input ?? defaultInput(),
    contextWindow: alias.targetContextWindow ?? alias.contextWindow ?? inherited?.contextWindow ?? 128_000,
    maxTokens: alias.maxTokens ?? inherited?.maxTokens ?? 16_384,
    cost: alias.cost ?? inherited?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: alias.compat ?? inherited?.compat,
    headers: alias.headers ?? inherited?.headers,
  });
}

function existingModelToProviderModel(model: ExistingModel): Record<string, unknown> {
  return pruneUndefined({
    id: model.id,
    name: model.name ?? model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning ?? false,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input ?? defaultInput(),
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: model.compat,
    headers: model.headers,
  });
}

function wrapAliasIdentityStream(
  source: AssistantMessageEventStream,
  aliasModel: Model<any>,
): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        yield aliasMessageEvent(event, aliasModel);
      }
    },
    async result() {
      return aliasAssistantMessage(await source.result(), aliasModel);
    },
  } as unknown as AssistantMessageEventStream;
}

function aliasMessageEvent(event: AssistantMessageEvent, aliasModel: Model<any>): AssistantMessageEvent {
  if (event.type === "done") {
    return { ...event, message: aliasAssistantMessage(event.message, aliasModel) };
  }
  if (event.type === "error") {
    return { ...event, error: aliasAssistantMessage(event.error, aliasModel) };
  }
  return { ...event, partial: aliasAssistantMessage(event.partial, aliasModel) };
}

function aliasAssistantMessage(message: AssistantMessage, aliasModel: Model<any>): AssistantMessage {
  return {
    ...message,
    provider: aliasModel.provider,
    model: aliasModel.id,
  };
}

function providerDisplayName(firstAlias: ModelAliasConfig): string | undefined {
  if (firstAlias.providerName) return firstAlias.providerName;
  if (firstAlias.provider !== firstAlias.targetProvider) return firstAlias.provider;
  return undefined;
}

function defaultInput(): ("text" | "image")[] {
  return ["text"];
}

function defaultApiKeyForProvider(provider: string): string {
  const normalized = provider.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return `$${normalized || "MODEL_ALIAS"}_API_KEY`;
}

function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
