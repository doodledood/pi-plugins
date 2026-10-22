import { fileURLToPath } from "node:url";
import { ModelRuntime, VERSION, type EventBus, type ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, isModelType } from "@earendil-works/pi-ai";
import * as piAiCompat from "@earendil-works/pi-ai";
import type {
  AnyModel,
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context as PiContext,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { loadConfig, type ModelAliasConfig, type ModelAliasesConfig } from "./config.ts";

// Pi 0.86+ carries prompts and tool changes in the transcript. Keep the legacy
// fields optional so the same extension still works on its minimum Pi 0.80.8.
interface SystemTranscriptMessage {
  role: "system";
  content: string | { type: "text"; text: string }[];
  sections?: Record<string, string | null>;
  toolsAdded?: PiContext["tools"];
  toolsRemoved?: { name: string }[];
  timestamp: number;
}
type Context = Omit<PiContext, "messages"> & {
  messages: (PiContext["messages"][number] | SystemTranscriptMessage)[];
};

// Models are Pi's own types end to end: re-registration copies every field Pi
// gives a model, so a field a later Pi adds is carried through, not dropped.
type ExistingModel = AnyModel;
type TargetModel = Model<Api>;

interface ProviderRegistration {
  provider: string;
  config: Record<string, unknown> & { models: ProviderModelConfig[] };
}

type AliasLookup = Map<string, ModelAliasConfig>;
type TargetModelLookup = Map<string, TargetModel>;
/** Finds a chat model in Pi's live registry, which carries other extensions' provider overrides. */
type LiveModelLookup = (provider: string, id: string) => Pick<TargetModel, "baseUrl"> | undefined;
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
  // Every model type is kept: a provider re-registration replaces the provider's
  // whole list, classifiers and image models included.
  const existingModels = (await ModelRuntime.create()).getAllModels();
  const aliasLookup = buildAliasLookup(config);
  const targetLookup = buildTargetModelLookup(config, existingModels);
  // The snapshot above sees no other extension's registerProvider calls, so
  // routing is read from Pi's live registry at request time.
  let liveModels: LiveModelLookup | undefined;
  pi.on("session_start", (_event: unknown, ctx: { modelRegistry?: { find(provider: string, id: string): TargetModel | undefined } }) => {
    const registry = ctx.modelRegistry;
    liveModels = registry ? (provider, id) => registry.find(provider, id) : undefined;
  });
  const aliasStreamSimple = createAliasStreamSimple(aliasLookup, targetLookup, undefined, (provider, id) => liveModels?.(provider, id));

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
export function findUnpricedAliases(config: ModelAliasesConfig, existingModels: readonly ExistingModel[] = []): string[] {
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
  existingModels: readonly ExistingModel[] = [],
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
    // Keyed by type and id: a classifier may share an id with a chat model.
    const modelByKey = new Map<string, ProviderModelConfig>();

    for (const model of providerExistingModels) {
      modelByKey.set(`${model.type ?? "chat"}/${model.id}`, existingModelToProviderModel(model));
    }

    for (const alias of aliases) {
      const inherited = inheritedModelForAlias(alias, targetModelByKey);
      modelByKey.set(`chat/${alias.id}`, aliasToProviderModel(alias, inherited));
    }

    const firstAlias = aliases[0]!;
    const firstTarget = inheritedModelForAlias(firstAlias, targetModelByKey);

    return {
      provider,
      config: pruneUndefined({
        name: providerDisplayName(firstAlias),
        // No provider-level baseUrl over Pi's own: the provider's models keep the
        // base URL Pi composes, so another extension's override of it still
        // applies. A provider Pi does not know yet needs one to register at all.
        baseUrl: providerExistingModels.length === 0 ? firstAlias.baseUrl ?? firstTarget?.baseUrl : undefined,
        apiKey: firstAlias.apiKey ?? defaultApiKeyForProvider(firstAlias.targetProvider),
        api: MODEL_ALIASES_API,
        streamSimple: aliasStreamSimple,
        headers: firstAlias.headers,
        authHeader: firstAlias.authHeader,
        models: [...modelByKey.values()],
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
  existingModels: readonly ExistingModel[] = [],
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
  liveModels: LiveModelLookup = () => undefined,
): AliasStreamDelegate {
  return (model, context, options) => {
    const alias = getAliasForModel(aliasLookup, model);
    const target = targetLookup.get(modelKey(model.provider, model.id));
    if (!alias || !target) {
      throw new Error(`No model alias target registered for ${model.provider}/${model.id}`);
    }

    const enforceVisibleWindow = shouldEnforceAliasContextWindow(model, target) && !isPiSummarizationRequest(context);
    const estimatedTokens = enforceVisibleWindow ? estimateAliasRequestTokens(context) : 0;
    if (enforceVisibleWindow && estimatedTokens >= model.contextWindow) {
      return wrapAliasIdentityStream(createAliasContextOverflowStream(target, estimatedTokens, model.contextWindow), model);
    }
    // An alias's own baseUrl wins; otherwise the target's route as Pi resolves
    // it now, including another extension's override of that provider.
    const baseUrl = alias.baseUrl ?? liveModels(target.provider, target.id)?.baseUrl ?? target.baseUrl;
    const routedTarget = baseUrl === target.baseUrl ? target : { ...target, baseUrl };
    return wrapAliasIdentityStream(delegate(routedTarget, toTargetIdentity(context, model, target), options), model);
  };
}

/**
 * The inverse of aliasAssistantMessage. Pi records an alias's replies under the
 * alias id, and providers replay thinking and reasoning only for turns they
 * recognize as the same model's, so earlier turns go back as the target's own.
 */
function toTargetIdentity(context: Context, aliasModel: Model<any>, target: TargetModel): Context {
  if (aliasModel.provider === target.provider && aliasModel.id === target.id) return context;
  let changed = false;
  const messages = context.messages.map((message) => {
    if (message.role !== "assistant" || message.provider !== aliasModel.provider || message.model !== aliasModel.id) return message;
    changed = true;
    return { ...message, provider: target.provider, model: target.id };
  });
  return changed ? { ...context, messages } : context;
}

/**
 * A dual-window alias is an operating-window contract, not just a footer label.
 * Pi checks automatic compaction after a complete agent run, but one run can span
 * many provider/tool turns. Stop the next request at the visible edge so Pi's
 * native context-overflow recovery compacts and resumes the tool loop.
 */
export function shouldEnforceAliasContextWindow(aliasModel: Model<any>, targetModel: TargetModel): boolean {
  return aliasModel.contextWindow > 0 && targetModel.contextWindow > aliasModel.contextWindow;
}

/**
 * Compaction and branch summaries must be able to read the context they are
 * replacing. They are one-off Pi-owned requests, not another normal agent turn,
 * and cannot recover from a second synthetic overflow inside summarization.
 */
export function isPiSummarizationRequest(context: Context): boolean {
  const [first] = context.messages;
  const transcriptSystem = first?.role === "system" ? first : undefined;
  const systemPrompt = transcriptSystem
    ? typeof transcriptSystem.content === "string"
      ? transcriptSystem.content
      : transcriptSystem.content.map((block) => block.text).join("\n")
    : context.systemPrompt;
  // Only the exact Pi-owned summary request bypasses the operating boundary.
  // Extra system updates/sections must not turn an ordinary turn into a bypass.
  if (transcriptSystem && Object.values(transcriptSystem.sections ?? {}).some(Boolean)) return false;
  const messages = transcriptSystem ? context.messages.slice(1) : context.messages;
  if (systemPrompt !== PI_SUMMARIZATION_SYSTEM_PROMPT || messages.length !== 1) return false;
  const message = messages[0];
  if (message?.role !== "user") return false;
  const text = typeof message.content === "string"
    ? message.content
    : message.content.find((block) => block.type === "text")?.text;
  if (typeof text !== "string") return false;
  // History and branch summaries use the XML form; Pi 1.4's turn-prefix summary uses headings.
  return (text.startsWith("<conversation>\n") && text.includes("\n</conversation>")) ||
    (text.startsWith("# Conversation\n") && text.includes("\n\n# Instructions\n"));
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
    return usageInfo.tokens +
      trailingMessages.reduce((total, message) => total + estimateMessageTokens(message), 0);
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
  if (message.role === "system") {
    return estimateContentTokens(message.content) +
      estimateJsonTokens(message.sections) +
      estimateJsonTokens(message.toolsAdded) +
      estimateJsonTokens(message.toolsRemoved);
  }
  if (message.role === "user" || message.role === "toolResult") {
    return estimateContentTokens(message.content);
  }

  let chars = 0;
  for (const block of message.content) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "thinking") chars += block.thinking.length;
    else if (block.type === "toolCall") chars += block.name.length + safeJsonStringify(block.arguments).length;
    else throw new Error(`Unsupported assistant content block: ${(block as { type: string }).type}`);
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
): TargetModel | undefined {
  const chat = (model: ExistingModel | undefined): TargetModel | undefined =>
    model && isModelType(model, "chat") ? model : undefined;
  return (
    chat(targetModelByKey.get(modelKey(alias.targetProvider, alias.targetModel))) ??
    chat(targetModelByKey.get(modelKey(alias.provider, alias.id)))
  );
}

/** The fields an alias inherits from its target, minus identity and routing. */
function inheritableFields(inherited: TargetModel | undefined): Partial<TargetModel> {
  if (!inherited) return {};
  const { provider: _provider, baseUrl: _baseUrl, headers: _headers, id: _id, ...fields } = inherited;
  return fields;
}

function aliasToProviderModel(alias: ModelAliasConfig, inherited: TargetModel | undefined): ProviderModelConfig {
  return pruneUndefined({
    ...inheritableFields(inherited),
    id: alias.id,
    name: alias.name ?? inherited?.name ?? alias.id,
    api: MODEL_ALIASES_API,
    // Only an explicit alias baseUrl is pinned; otherwise the model follows the
    // provider's live route. The request itself goes to the target's route.
    baseUrl: alias.baseUrl,
    reasoning: alias.reasoning ?? inherited?.reasoning ?? false,
    thinkingLevelMap: alias.thinkingLevelMap ?? inherited?.thinkingLevelMap,
    input: alias.input ?? inherited?.input ?? defaultInput(),
    contextWindow: alias.contextWindow ?? inherited?.contextWindow ?? 128_000,
    maxTokens: alias.maxTokens ?? inherited?.maxTokens ?? 16_384,
    cost: alias.cost ?? inherited?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: alias.compat ?? inherited?.compat,
    headers: alias.headers,
  }) as ProviderModelConfig;
}

function aliasToTargetModel(alias: ModelAliasConfig, inherited: TargetModel | undefined): TargetModel {
  return pruneUndefined({
    ...inheritableFields(inherited),
    id: alias.targetModel,
    name: inherited?.name ?? alias.targetModel,
    api: (alias.api ?? inherited?.api) as Api,
    provider: alias.targetProvider,
    baseUrl: (alias.baseUrl ?? inherited?.baseUrl) as string,
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

/**
 * Re-registering a provider replaces its model list, so each model goes back
 * with every field Pi gave it. The provider id comes from the registration, and
 * the base URL from Pi's provider layer, so another extension's routing override
 * of the provider still applies.
 */
function existingModelToProviderModel(model: ExistingModel): ProviderModelConfig {
  const { provider: _provider, baseUrl: _baseUrl, ...definition } = model;
  return definition as ProviderModelConfig;
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

function pruneUndefined<T extends object>(value: T): T {
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key];
  }
  return value;
}
