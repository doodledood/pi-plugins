// Tunables for the mcp-tool-loadout extension. Loaded from
// ~/.pi/agent/mcp-tool-loadout.json; missing/partial/malformed → safe defaults.
import { existsSync, readFileSync } from "node:fs";
import { configPath } from "./paths.ts";

export interface LoadoutConfig {
  /** Master switch. When false the extension makes no gating or catalog changes. */
  enabled: boolean;
  /** Approx token budget for the active MCP-tool schema slice. */
  budgetTokens: number;
  /** Recency half-life in days for the usage decay. */
  halfLifeDays: number;
  /**
   * Minimum MCP-tool usage events a project needs before its own history is trusted.
   * Below this, ranking falls back to pooled global (all-project) usage, then to `prior`.
   */
  minProjectEvents: number;
  /**
   * Cold-start prior. Keys may be a tool name (prefixed, e.g. "alpha_get_page")
   * or a server name (e.g. "alpha_mcp"); tool-specific wins over server-level.
   */
  prior: Record<string, number>;
  /** MCP tools that must always stay active regardless of score/budget. */
  alwaysActiveMcpTools: string[];
  /** Tool names to omit from the injected catalog. */
  excludeFromCatalog: string[];
}

/** Neutral generic cold-start prior. Put workflow-specific priors in user config. */
export const DEFAULT_PRIOR: Record<string, number> = {};

export const DEFAULTS: LoadoutConfig = {
  enabled: true,
  budgetTokens: 10_000,
  halfLifeDays: 14,
  minProjectEvents: 5,
  prior: DEFAULT_PRIOR,
  alwaysActiveMcpTools: [],
  excludeFromCatalog: [],
};

function freshDefaults(): LoadoutConfig {
  return { ...DEFAULTS, prior: { ...DEFAULT_PRIOR }, alwaysActiveMcpTools: [], excludeFromCatalog: [] };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function loadConfig(path: string = configPath()): LoadoutConfig {
  if (!existsSync(path)) return freshDefaults();
  let raw: Partial<LoadoutConfig>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Partial<LoadoutConfig>;
  } catch {
    return freshDefaults();
  }
  if (typeof raw !== "object" || raw === null) return freshDefaults();
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    budgetTokens:
      typeof raw.budgetTokens === "number" && Number.isFinite(raw.budgetTokens) && raw.budgetTokens >= 0
        ? raw.budgetTokens
        : DEFAULTS.budgetTokens,
    halfLifeDays:
      typeof raw.halfLifeDays === "number" && Number.isFinite(raw.halfLifeDays) && raw.halfLifeDays > 0
        ? raw.halfLifeDays
        : DEFAULTS.halfLifeDays,
    minProjectEvents:
      typeof raw.minProjectEvents === "number" && Number.isFinite(raw.minProjectEvents) && raw.minProjectEvents >= 0
        ? raw.minProjectEvents
        : DEFAULTS.minProjectEvents,
    prior:
      raw.prior && typeof raw.prior === "object"
        ? (Object.fromEntries(
            Object.entries(raw.prior).filter(([, v]) => typeof v === "number" && Number.isFinite(v)),
          ) as Record<string, number>)
        : { ...DEFAULT_PRIOR },
    alwaysActiveMcpTools: stringArray(raw.alwaysActiveMcpTools),
    excludeFromCatalog: stringArray(raw.excludeFromCatalog),
  };
}
