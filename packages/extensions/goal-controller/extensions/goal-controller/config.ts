import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoalControllerConfig } from "./types.ts";

const DEFAULT_CHECKER_TIMEOUT_MS = 300_000;
const DEFAULT_NO_TOOL_CONTINUATION_LIMIT = 3;
const REMOVED_CHECKER_CAPABILITY_FIELD = "toolMode";
const CHECKER_CONFIG_FIELDS = new Set(["mode", "model", "thinking", "timeoutMs"]);

export const CONFIG_PATH = join(
  process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent"),
  "goal-controller.config.json",
);

export const DEFAULT_CONFIG: GoalControllerConfig = {
  checker: {
    mode: "llm",
    model: "inherit",
    thinking: "inherit",
    timeoutMs: DEFAULT_CHECKER_TIMEOUT_MS,
  },
  continuation: {
    noToolContinuationLimit: DEFAULT_NO_TOOL_CONTINUATION_LIMIT,
  },
};

export interface LoadedConfig {
  config: GoalControllerConfig;
  warning?: string;
  path: string;
}

export function loadConfig(path = CONFIG_PATH): LoadedConfig {
  if (!existsSync(path)) return { config: DEFAULT_CONFIG, path };

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return { config: DEFAULT_CONFIG, path, warning: "goal-controller config is not a JSON object; using defaults" };
    const merged = mergeConfig(parsed);
    return {
      config: merged.config,
      path,
      warning: merged.warnings.length > 0 ? `goal-controller config ignored invalid value(s): ${merged.warnings.join(", ")}` : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: DEFAULT_CONFIG, path, warning: `goal-controller config could not be read (${message}); using defaults` };
  }
}

function mergeConfig(raw: Record<string, unknown>): { config: GoalControllerConfig; warnings: string[] } {
  const warnings: string[] = [];
  const checker = pathRecord(raw, "checker");
  const continuation = pathRecord(raw, "continuation");
  warnings.push(...unsupportedFields(checker, "checker", CHECKER_CONFIG_FIELDS));
  return {
    warnings,
    config: {
      defaultTokenBudget: optionalPositiveInteger(raw.defaultTokenBudget, DEFAULT_CONFIG.defaultTokenBudget, "defaultTokenBudget", warnings),
      defaultTurnBudget: optionalPositiveInteger(raw.defaultTurnBudget, DEFAULT_CONFIG.defaultTurnBudget, "defaultTurnBudget", warnings),
      defaultTimeBudgetSeconds: optionalPositiveInteger(raw.defaultTimeBudgetSeconds, DEFAULT_CONFIG.defaultTimeBudgetSeconds, "defaultTimeBudgetSeconds", warnings),
      checker: {
        mode: "llm",
        model: stringOrDefault(checker?.model, DEFAULT_CONFIG.checker.model, "checker.model", warnings),
        thinking: thinkingOrDefault(checker?.thinking, DEFAULT_CONFIG.checker.thinking, "checker.thinking", warnings),
        timeoutMs: positiveInteger(checker?.timeoutMs, DEFAULT_CONFIG.checker.timeoutMs, "checker.timeoutMs", warnings),
      },
      continuation: {
        noToolContinuationLimit: positiveInteger(
          continuation?.noToolContinuationLimit,
          DEFAULT_CONFIG.continuation.noToolContinuationLimit,
          "continuation.noToolContinuationLimit",
          warnings,
        ),
      },
    },
  };
}

function pathRecord(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = raw[key];
  return isRecord(value) ? value : undefined;
}

function unsupportedFields(raw: Record<string, unknown> | undefined, prefix: string, supportedFields: ReadonlySet<string>): string[] {
  if (!raw) return [];
  return Object.keys(raw)
    .filter((key) => !supportedFields.has(key))
    .map((key) => unsupportedFieldWarning(prefix, key));
}

function unsupportedFieldWarning(prefix: string, key: string): string {
  if (key === REMOVED_CHECKER_CAPABILITY_FIELD) {
    return `${prefix}.${key} is no longer supported; checker always uses the fixed audit-only profile`;
  }
  return `${prefix}.${key}`;
}

function optionalPositiveInteger(
  value: unknown,
  defaultValue: number | undefined,
  field: string,
  warnings: string[],
): number | undefined {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    warnings.push(field);
    return defaultValue;
  }
  return Math.floor(value);
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

function thinkingOrDefault(
  value: unknown,
  defaultValue: GoalControllerConfig["checker"]["thinking"],
  field: string,
  warnings: string[],
): GoalControllerConfig["checker"]["thinking"] {
  if (value === undefined || value === null) return defaultValue;
  if (value === "inherit" || value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return value;
  }
  warnings.push(field);
  return defaultValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
