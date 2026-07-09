import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_ORCHESTRATION_DENYLIST } from "./child-profile.ts";
import type { AdvisorConsultConfig, LoadedConfig, ThinkingLevel } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const MIN_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_TIMEOUT_MS = 1_800_000; // 30 minutes

const SUPPORTED_FIELDS = new Set([
  "defaultModel",
  "defaultThinking",
  "defaultTimeoutMs",
  "minTimeoutMs",
  "maxTimeoutMs",
  "excludedTools",
]);

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export const CONFIG_PATH = join(
  process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"),
  "advisor-consult.json",
);

export const DEFAULT_CONFIG: AdvisorConsultConfig = {
  defaultModel: "anthropic/claude-fable-5",
  defaultThinking: "xhigh",
  defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  minTimeoutMs: MIN_TIMEOUT_MS,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  excludedTools: [...DEFAULT_ORCHESTRATION_DENYLIST],
};

export function defaultConfig(): AdvisorConsultConfig {
  return { ...DEFAULT_CONFIG, excludedTools: [...DEFAULT_CONFIG.excludedTools] };
}

export function loadConfig(path = CONFIG_PATH): LoadedConfig {
  if (!existsSync(path)) return { config: defaultConfig(), path };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return { config: defaultConfig(), path, warning: "advisor-consult config is not a JSON object; using defaults" };
    }
    const merged = mergeConfig(parsed);
    return {
      config: merged.config,
      path,
      warning:
        merged.warnings.length > 0
          ? `advisor-consult config ignored invalid value(s): ${merged.warnings.join(", ")}`
          : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: defaultConfig(), path, warning: `advisor-consult config could not be read (${message}); using defaults` };
  }
}

function mergeConfig(raw: Record<string, unknown>): { config: AdvisorConsultConfig; warnings: string[] } {
  const warnings: string[] = [];
  warnings.push(...unsupportedFields(raw));

  const defaultModel = stringOrDefault(raw.defaultModel, DEFAULT_CONFIG.defaultModel, "defaultModel", warnings);
  const defaultThinking = thinkingOrDefault(raw.defaultThinking, DEFAULT_CONFIG.defaultThinking, "defaultThinking", warnings);
  const excludedTools = stringArrayOrDefault(raw.excludedTools, DEFAULT_CONFIG.excludedTools, "excludedTools", warnings);

  let minTimeoutMs = positiveInteger(raw.minTimeoutMs, DEFAULT_CONFIG.minTimeoutMs, "minTimeoutMs", warnings);
  let maxTimeoutMs = positiveInteger(raw.maxTimeoutMs, DEFAULT_CONFIG.maxTimeoutMs, "maxTimeoutMs", warnings);
  if (minTimeoutMs > maxTimeoutMs) {
    warnings.push("minTimeoutMs/maxTimeoutMs (min exceeds max)");
    minTimeoutMs = DEFAULT_CONFIG.minTimeoutMs;
    maxTimeoutMs = DEFAULT_CONFIG.maxTimeoutMs;
  }

  const rawDefaultTimeout = positiveInteger(raw.defaultTimeoutMs, DEFAULT_CONFIG.defaultTimeoutMs, "defaultTimeoutMs", warnings);
  const defaultTimeoutMs = clamp(rawDefaultTimeout, minTimeoutMs, maxTimeoutMs);
  if (defaultTimeoutMs !== rawDefaultTimeout) warnings.push("defaultTimeoutMs (clamped into [minTimeoutMs, maxTimeoutMs])");

  return {
    warnings,
    config: { defaultModel, defaultThinking, defaultTimeoutMs, minTimeoutMs, maxTimeoutMs, excludedTools },
  };
}

/** Clamp a requested per-call timeout into the configured bounds. */
export function clampTimeout(requestedMs: number, config: AdvisorConsultConfig): number {
  return clamp(Math.floor(requestedMs), config.minTimeoutMs, config.maxTimeoutMs);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function unsupportedFields(raw: Record<string, unknown>): string[] {
  return Object.keys(raw)
    .filter((key) => !SUPPORTED_FIELDS.has(key))
    .map((key) => `${key} (unsupported)`);
}

function positiveInteger(value: unknown, defaultValue: number, field: string, warnings: string[]): number {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    warnings.push(field);
    return defaultValue;
  }
  return Math.floor(value);
}

function stringOrDefault(value: unknown, defaultValue: string, field: string, warnings: string[]): string {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  warnings.push(field);
  return defaultValue;
}

function thinkingOrDefault(value: unknown, defaultValue: ThinkingLevel, field: string, warnings: string[]): ThinkingLevel {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "string" && THINKING_LEVELS.has(value)) return value as ThinkingLevel;
  warnings.push(field);
  return defaultValue;
}

function stringArrayOrDefault(value: unknown, defaultValue: string[], field: string, warnings: string[]): string[] {
  if (value === undefined || value === null) return [...defaultValue];
  if (!Array.isArray(value)) {
    warnings.push(field);
    return [...defaultValue];
  }
  const strings: string[] = [];
  let invalid = false;
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) strings.push(item.trim());
    else invalid = true;
  }
  if (invalid) warnings.push(field);
  return strings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
