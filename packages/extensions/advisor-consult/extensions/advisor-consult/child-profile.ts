// Shared constants and helpers describing the advisor subprocess tool surface.
// Imported by both the parent-side runner (to build `--exclude-tools`) and the
// child-side bootstrap extension (to broaden the active tool set).

/**
 * Tools the invisible advisor must NEVER have, regardless of user config:
 * - `advisor_consult` — prevents unbounded recursive self-consultation.
 * - `ask_user_question` — the advisor is invisible to the user and must never
 *   surface a question on the user's screen.
 */
export const HARD_DENIED_TOOLS = ["advisor_consult", "ask_user_question"] as const;

/**
 * Orchestration tools denied by default but configurable via `excludedTools`.
 * The advisor should reason and inspect, not start goals, spawn subagents, or
 * steer other agents on the user's behalf.
 */
export const DEFAULT_ORCHESTRATION_DENYLIST = ["goal", "subagent", "get_subagent_result", "steer_subagent"] as const;

/**
 * Merge the always-on hard denylist with the caller-configured denylist into a
 * de-duplicated, non-empty list. The hard entries can never be removed.
 */
export function resolveExcludedTools(configured: readonly string[]): string[] {
  const merged = new Set<string>(HARD_DENIED_TOOLS);
  for (const name of configured) {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed) merged.add(trimmed);
  }
  return [...merged];
}

/** Marker substrings identifying tools registered by the pi-mcp-adapter. */
const MCP_ADAPTER_MARKERS = ["pi-mcp-adapter", "mcp-adapter"];

/** Infra tools that stay active so dormant MCP schemas remain reachable. */
export const MCP_INFRA_TOOLS = new Set<string>(["mcp", "load_tools"]);

interface ToolSourceInfo {
  source?: string;
  path?: string;
}

/**
 * True when a registered tool comes from the pi-mcp-adapter. Mirrors
 * mcp-tool-loadout's detection so the advisor bootstrap can leave MCP-tool
 * budgeting to that extension instead of force-activating every MCP schema.
 */
export function isMcpTool(sourceInfo: ToolSourceInfo | undefined): boolean {
  if (!sourceInfo) return false;
  const hay = `${sourceInfo.source ?? ""} ${sourceInfo.path ?? ""}`.toLowerCase();
  return MCP_ADAPTER_MARKERS.some((marker) => hay.includes(marker));
}
