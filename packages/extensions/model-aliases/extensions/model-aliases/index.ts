import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

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
}

interface ProviderRegistration {
  provider: string;
  config: Record<string, unknown>;
}

type AliasLookup = Map<string, ModelAliasConfig>;

export default function modelAliases(pi: any) {
  const config = loadConfig();
  if (!config.enabled) return;

  const currentRegistry = ModelRegistry.create(AuthStorage.create());
  const existingModels = currentRegistry.getAll() as ExistingModel[];
  const aliasLookup = buildAliasLookup(config);

  for (const registration of buildProviderRegistrations(config, existingModels)) {
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

  pi.on("before_provider_request", (event: any, ctx: any) => {
    const alias = getAliasForModel(aliasLookup, ctx.model);
    if (!alias) return undefined;
    return rewriteModelAliasPayload(event.payload, alias.targetModel);
  });
}

export function buildProviderRegistrations(
  config: ModelAliasesConfig,
  existingModels: ExistingModel[] = [],
): ProviderRegistration[] {
  if (!config.enabled) return [];

  const grouped = new Map<string, ModelAliasConfig[]>();
  for (const alias of config.aliases) {
    const aliases = grouped.get(alias.provider) ?? [];
    aliases.push(alias);
    grouped.set(alias.provider, aliases);
  }

  return [...grouped.entries()].map(([provider, aliases]) => {
    const providerExistingModels = existingModels.filter((model) => model.provider === provider);
    const targetModelByKey = new Map(existingModels.map((model) => [modelKey(model.provider, model.id), model]));
    const modelById = new Map<string, Record<string, unknown>>();

    for (const model of providerExistingModels) {
      modelById.set(model.id, existingModelToProviderModel(model));
    }

    for (const alias of aliases) {
      const inherited =
        targetModelByKey.get(modelKey(alias.targetProvider, alias.targetModel)) ??
        targetModelByKey.get(modelKey(alias.provider, alias.id));
      modelById.set(alias.id, aliasToProviderModel(alias, inherited));
    }

    const firstAlias = aliases[0]!;
    const firstExisting = providerExistingModels[0];
    const firstTarget = targetModelByKey.get(modelKey(firstAlias.targetProvider, firstAlias.targetModel));
    const firstModel = firstTarget ?? firstExisting;

    return {
      provider,
      config: pruneUndefined({
        name: firstAlias.providerName ?? provider,
        baseUrl: firstAlias.baseUrl ?? firstModel?.baseUrl,
        apiKey: firstAlias.apiKey ?? defaultApiKeyForProvider(firstAlias.targetProvider),
        api: firstAlias.api ?? firstModel?.api,
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

export function getAliasForModel(lookup: AliasLookup, model: any): ModelAliasConfig | undefined {
  if (!model?.provider || !model?.id) return undefined;
  return lookup.get(modelKey(model.provider, model.id));
}

export function rewriteModelAliasPayload(payload: unknown, targetModel: string): unknown | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

  return {
    ...(payload as Record<string, unknown>),
    model: targetModel,
  };
}

function aliasToProviderModel(alias: ModelAliasConfig, inherited: ExistingModel | undefined): Record<string, unknown> {
  return pruneUndefined({
    id: alias.id,
    name: alias.name ?? inherited?.name ?? alias.id,
    api: alias.api ?? inherited?.api,
    baseUrl: alias.baseUrl ?? inherited?.baseUrl,
    reasoning: alias.reasoning ?? inherited?.reasoning ?? false,
    thinkingLevelMap: alias.thinkingLevelMap ?? inherited?.thinkingLevelMap,
    input: alias.input ?? inherited?.input ?? ["text"],
    contextWindow: alias.contextWindow ?? inherited?.contextWindow ?? 128_000,
    maxTokens: alias.maxTokens ?? inherited?.maxTokens ?? 16_384,
    cost: alias.cost ?? inherited?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: alias.compat ?? inherited?.compat,
    headers: alias.headers,
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
    input: model.input ?? ["text"],
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: model.compat,
  });
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
