// Paths resolve per call through Pi's own agent-directory resolver, so they follow the directory Pi uses.
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function configPath(): string {
  return join(getAgentDir(), "mcp-tool-loadout.json");
}

export function cachePath(): string {
  return join(getAgentDir(), "mcp-cache.json");
}

/** Append-only usage log (JSON Lines). */
export function usageLogPath(): string {
  return join(getAgentDir(), "mcp-tool-loadout-usage.jsonl");
}

/** The whole-file stats store used before the usage log; imported into the log once. */
export function legacyStatsPath(): string {
  return join(getAgentDir(), "mcp-tool-loadout-stats.json");
}
