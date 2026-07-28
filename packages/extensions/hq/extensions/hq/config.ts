/**
 * Optional configuration, read from `<pi agent dir>/hq.json`.
 *
 * Everything that governs HQ's judgment lives in the doctrine file instead —
 * this is only for the few mechanical knobs a prose file has no business holding.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HqConfig {
  /** Small, fast model used only to label sessions on the board. */
  titleModel: string | undefined;
  /** Refuses further delegation past this many live managed workers. */
  maxConcurrentWorkers: number;
  /** Overrides the doctrine value only when doctrine does not set one. */
  stalenessMinutes: number | undefined;
}

export const DEFAULT_CONFIG: HqConfig = {
  titleModel: undefined,
  maxConcurrentWorkers: 10,
  stalenessMinutes: undefined,
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  return agentDir
    ? join(resolve(agentDir), "hq.json")
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
  const staleness = record.stalenessMinutes;
  return {
    titleModel: typeof record.titleModel === "string" ? record.titleModel : undefined,
    maxConcurrentWorkers:
      typeof workers === "number" && Number.isFinite(workers) && workers > 0
        ? Math.floor(workers)
        : DEFAULT_CONFIG.maxConcurrentWorkers,
    stalenessMinutes:
      typeof staleness === "number" && Number.isFinite(staleness) && staleness > 0
        ? staleness
        : undefined,
  };
}
