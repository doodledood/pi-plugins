// Budget-constrained selection of the active MCP tool set, ranked by score.
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/**
 * Calibrated chars-per-token for tool-definition JSON.
 *
 * Tool schemas are dense JSON (braces, quotes, short field-name tokens) and the real
 * tokenizer counts them at ~2.5 chars/token — NOT the ~4 chars/token that holds for
 * prose. Calibrated against Anthropic /v1/messages/count_tokens over the full 103-tool
 * universe: 143,978 JSON chars -> 58,017 real tokens ~= 2.48 chars/token. The old ÷4
 * underestimated real tool cost by ~1.6x, so a 10k budget actually cost ~16k real
 * tokens. 2.5 makes `budgetTokens` read in approximately real tokens, so the loadout
 * budget and footer line up with `/context`.
 */
const CHARS_PER_TOKEN = 2.5;

/** Approximate prompt-token cost of a tool definition. See CHARS_PER_TOKEN. */
export function estimateTokens(tool: Pick<ToolInfo, "name" | "description" | "parameters">): number {
  const serialized = JSON.stringify({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  });
  return Math.ceil(serialized.length / CHARS_PER_TOKEN);
}

/** Resolve the cold-start prior for a tool: tool-specific key wins over server-level key. */
export function priorFor(toolName: string, server: string, prior: Record<string, number>): number {
  const byTool = prior[toolName];
  if (typeof byTool === "number") return byTool;
  const byServer = server ? prior[server] : undefined;
  if (typeof byServer === "number") return byServer;
  return 0;
}

export interface Candidate {
  name: string;
  tokens: number;
  score: number;
}

export interface Selection {
  active: string[];
  dormant: string[];
}

/**
 * Keep the highest-scoring candidates whose cumulative tokens fit the budget, always
 * including `alwaysActive`. Deterministic: ties break by name ascending. budget=0 yields
 * only the always-active set.
 */
export function selectActiveMcp(
  candidates: readonly Candidate[],
  budgetTokens: number,
  alwaysActive: readonly string[] = [],
): Selection {
  const always = new Set(alwaysActive);
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const active = new Set<string>();
  let used = 0;

  // Always-active first (counts toward the budget but is never dropped).
  for (const c of sorted) {
    if (always.has(c.name)) {
      active.add(c.name);
      used += c.tokens;
    }
  }
  // Fill remaining budget by descending score.
  for (const c of sorted) {
    if (active.has(c.name)) continue;
    if (used + c.tokens <= budgetTokens) {
      active.add(c.name);
      used += c.tokens;
    }
  }

  const activeList = [...active].sort((a, b) => a.localeCompare(b));
  const dormant = candidates
    .map((c) => c.name)
    .filter((n) => !active.has(n))
    .sort((a, b) => a.localeCompare(b));
  return { active: activeList, dormant };
}
