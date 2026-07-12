import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry, type EventBus } from "@earendil-works/pi-coding-agent";
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
  headers?: Record<string, string | null>;
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

export default function modelAliases(pi: any) {
  registerCheckerModelBootstrap(pi);
  activateModelAliases(pi);
}

export function activateModelAliases(pi: any): void {
  const config = loadConfig();
  if (!config.enabled) return;

  const currentRegistry = ModelRegistry.create(AuthStorage.create());
  const existingModels = currentRegistry.getAll() as ExistingModel[];
  const aliasLookup = buildAliasLookup(config);
  const targetLookup = buildTargetModelLookup(config, existingModels);
  const aliasStreamSimple = createAliasStreamSimple(aliasLookup, targetLookup);

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

    const source = delegate(target as Model<any>, context, options);
    return wrapAliasIdentityStream(source, model);
  };
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
