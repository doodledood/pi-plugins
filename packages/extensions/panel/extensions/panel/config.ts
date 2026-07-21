import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isThinkingLevel, type LoadedPanelConfig, type PanelConfig, type PanelistSpec } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 900_000; // 15 minutes per panelist
const MIN_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 3_600_000;

/**
 * Built-in fallback lineup, used when no config file exists or its lineup is
 * empty: both entries preselected.
 */
export const DEFAULT_PANELISTS: PanelistSpec[] = [
  { model: "anthropic/claude-fable-5", thinking: "xhigh" },
  { model: "openai/gpt-5.6-sol", thinking: "xhigh" },
];

export const DEFAULT_INSPECT_KEYBINDING = "ctrl+p";

export function configPath(agentDir?: string): string {
  const dir = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
  return join(dir, "panel.json");
}

export function defaultConfig(): PanelConfig {
  return {
    panelists: DEFAULT_PANELISTS.map((p) => ({ ...p })),
    preselected: DEFAULT_PANELISTS.map((_, i) => i),
    inspectKeybinding: DEFAULT_INSPECT_KEYBINDING,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Load the panel lineup config. Missing file, unreadable JSON, or an empty
 * lineup all degrade to the built-in default lineup (fully preselected) with a
 * warning where the config existed but was unusable.
 */
export function loadConfig(path = configPath()): LoadedPanelConfig {
  if (!existsSync(path)) return { config: defaultConfig(), path };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: defaultConfig(), path, warning: `panel config could not be read (${message}); using defaults` };
  }
  if (!isRecord(parsed)) {
    return { config: defaultConfig(), path, warning: "panel config is not a JSON object; using defaults" };
  }

  const warnings: string[] = [];
  const panelists = parsePanelists(parsed.panelists, warnings);
  if (panelists.length === 0) {
    return {
      config: defaultConfig(),
      path,
      warning:
        warnings.length > 0
          ? `panel config lineup invalid (${warnings.join(", ")}); using default lineup`
          : undefined,
    };
  }

  const preselected = parsePreselected(parsed.preselected, panelists.length, warnings);
  const inspectKeybinding = parseInspectKeybinding(parsed.inspectKeybinding, warnings);
  const timeoutMs = parseTimeout(parsed.timeoutMs, warnings);

  return {
    config: { panelists, preselected, inspectKeybinding, timeoutMs },
    path,
    warning: warnings.length > 0 ? `panel config ignored invalid value(s): ${warnings.join(", ")}` : undefined,
  };
}

function parsePanelists(raw: unknown, warnings: string[]): PanelistSpec[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    warnings.push("panelists must be an array");
    return [];
  }
  const specs: PanelistSpec[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.model !== "string" || !item.model.trim()) {
      warnings.push("panelist entries need a model string");
      continue;
    }
    const thinking = isThinkingLevel(item.thinking) ? item.thinking : "high";
    if (item.thinking !== undefined && !isThinkingLevel(item.thinking)) {
      warnings.push(`invalid thinking level for ${item.model}`);
    }
    specs.push({ model: item.model.trim(), thinking });
  }
  return specs;
}

function parsePreselected(raw: unknown, lineupSize: number, warnings: string[]): number[] {
  if (raw === undefined) return Array.from({ length: lineupSize }, (_, i) => i);
  if (!Array.isArray(raw) || raw.some((i) => typeof i !== "number" || i < 0 || i >= lineupSize)) {
    warnings.push("preselected must be an array of lineup indexes");
    return Array.from({ length: lineupSize }, (_, i) => i);
  }
  return [...new Set(raw as number[])];
}

// Conservative key-chord shape: optional modifiers + a single base key (letter,
// digit, or f-key). Anything else would silently register a dead key, so it
// falls back to the default with a warning instead.
const KEYBINDING_PATTERN = /^((ctrl|alt|shift|meta|cmd)\+)*(f\d{1,2}|[a-z0-9])$/;

function parseInspectKeybinding(raw: unknown, warnings: string[]): string {
  if (raw === undefined) return DEFAULT_INSPECT_KEYBINDING;
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (KEYBINDING_PATTERN.test(value)) return value;
  warnings.push(`inspectKeybinding ${JSON.stringify(raw)} is not a recognizable key chord`);
  return DEFAULT_INSPECT_KEYBINDING;
}

function parseTimeout(raw: unknown, warnings: string[]): number {
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warnings.push("timeoutMs must be a number");
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, raw));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
