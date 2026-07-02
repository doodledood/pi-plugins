import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelInputType = "text" | "image";
export type ThinkingLevelName = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelAliasCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelAliasConfig {
  /** Synthetic provider id shown in Pi, e.g. `openai-1m`. */
  provider: string;
  /** Optional synthetic provider display name. */
  providerName?: string;
  /** Selector-visible model id, e.g. `gpt-5.5-1m`. */
  id: string;
  /** Upstream provider to inherit model metadata from. Defaults to `provider`. */
  targetProvider: string;
  /** Upstream model id sent in the provider payload, e.g. `gpt-5.5`. Defaults to `id`. */
  targetModel: string;

  name?: string;
  api?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string | null>;
  authHeader?: boolean;

  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevelName, string | null>>;
  input?: ModelInputType[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelAliasCost;
  compat?: Record<string, unknown>;
}

export interface ModelAliasesConfig {
  enabled: boolean;
  aliases: ModelAliasConfig[];
}

interface RawObject {
  [key: string]: unknown;
}

const SETTINGS_KEY = "model-aliases";
const DEFAULT_COST: ModelAliasCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function defaultSettingsPaths(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? ".";
  const paths = [join(home, ".pi", "agent", "settings.json")];

  if (env.PI_AGENT_HOME) {
    paths.push(join(env.PI_AGENT_HOME, "settings.json"));
  }

  paths.push(join(cwd, ".pi", "settings.json"));

  return [...new Set(paths)];
}

export function loadConfig(paths = defaultSettingsPaths()): ModelAliasesConfig {
  let merged: RawObject | undefined;

  for (const path of paths) {
    const settings = readJsonObject(path);
    const section = settings?.[SETTINGS_KEY];
    if (isPlainObject(section)) {
      merged = { ...(merged ?? {}), ...section };
    }
  }

  return normalizeConfig(merged);
}

export function normalizeConfig(raw: unknown): ModelAliasesConfig {
  if (!isPlainObject(raw)) return { enabled: false, aliases: [] };

  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map(normalizeAlias).filter(isDefined) : [];

  return {
    enabled: raw.enabled !== false && aliases.length > 0,
    aliases,
  };
}

export function normalizeAlias(raw: unknown): ModelAliasConfig | undefined {
  if (!isPlainObject(raw)) return undefined;

  const provider = stringValue(raw.provider);
  const id = stringValue(raw.id);
  if (!provider || !id) return undefined;
  const targetProvider = stringValue(raw.targetProvider ?? raw.actualProvider) ?? provider;
  const targetModel = stringValue(raw.targetModel ?? raw.actualModelId ?? raw.model) ?? id;

  return {
    provider,
    providerName: stringValue(raw.providerName),
    id,
    targetProvider,
    targetModel,
    name: stringValue(raw.name),
    api: stringValue(raw.api),
    baseUrl: stringValue(raw.baseUrl),
    apiKey: stringValue(raw.apiKey),
    headers: stringRecordValue(raw.headers),
    authHeader: booleanValue(raw.authHeader),
    reasoning: booleanValue(raw.reasoning),
    thinkingLevelMap: thinkingLevelMapValue(raw.thinkingLevelMap),
    input: inputValue(raw.input),
    contextWindow: positiveIntegerValue(raw.contextWindow),
    maxTokens: positiveIntegerValue(raw.maxTokens),
    cost: costValue(raw.cost),
    compat: plainObjectValue(raw.compat),
  };
}

function readJsonObject(path: string): RawObject | undefined {
  if (!existsSync(path)) return undefined;

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is RawObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stringRecordValue(value: unknown): Record<string, string | null> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, string | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || item === null) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function plainObjectValue(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function inputValue(value: unknown): ModelInputType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const input = value.filter((item): item is ModelInputType => item === "text" || item === "image");
  return input.length > 0 ? [...new Set(input)] : undefined;
}

function costValue(value: unknown): ModelAliasCost | undefined {
  if (!isPlainObject(value)) return undefined;
  const input = numberValue(value.input);
  const output = numberValue(value.output);
  const cacheRead = numberValue(value.cacheRead);
  const cacheWrite = numberValue(value.cacheWrite);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function thinkingLevelMapValue(value: unknown): Partial<Record<ThinkingLevelName, string | null>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Partial<Record<ThinkingLevelName, string | null>> = {};
  for (const key of ["off", "minimal", "low", "medium", "high", "xhigh"] as const) {
    const item = value[key];
    if (typeof item === "string" || item === null) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
