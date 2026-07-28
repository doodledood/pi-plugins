/**
 * Optional configuration, read from `<pi agent dir>/hq.json`.
 *
 * Everything that governs HQ's judgment lives in the doctrine file instead —
 * this is only for the few mechanical knobs a prose file has no business holding.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHome } from "./paths.ts";

export interface HqConfig {
  /** Small, fast model used only to label sessions on the board. */
  titleModel: string | undefined;
  /** Refuses further delegation past this many live managed workers. */
  maxConcurrentWorkers: number;
}

export const DEFAULT_CONFIG: HqConfig = {
  titleModel: undefined,
  maxConcurrentWorkers: 10,
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  return agentDir
    ? join(expandHome(agentDir), "hq.json")
    : join(homedir(), ".pi", "agent", "hq.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HqConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath(env), "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
  const record = raw as Record<string, unknown>;
  const workers = record.maxConcurrentWorkers;
  return {
    titleModel: typeof record.titleModel === "string" ? record.titleModel : undefined,
    maxConcurrentWorkers:
      typeof workers === "number" && Number.isFinite(workers) && workers > 0
        ? Math.floor(workers)
        : DEFAULT_CONFIG.maxConcurrentWorkers,
  };
}
