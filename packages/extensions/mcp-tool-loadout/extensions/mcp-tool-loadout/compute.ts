// Pure orchestration: given the current tool list, the MCP universe, config, and
// recency scores, decide the active tool set and render the catalog. No I/O, no Pi API.
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { LoadoutConfig } from "./config.ts";
import { INFRA_TOOLS, isMcpTool, inferServer, type McpToolMeta } from "./mcp-detect.ts";
import { estimateTokens, priorFor, selectActiveMcp, type Candidate } from "./select.ts";
import { buildCatalog, type CatalogTool } from "./catalog.ts";
import { recencyScores, type UsageEvent } from "./stats.ts";

export interface LoadoutInput {
  allTools: readonly ToolInfo[];
  universe: readonly McpToolMeta[];
  cfg: LoadoutConfig;
  recency: ReadonlyMap<string, number>;
}

export interface LoadoutResult {
  /** The exact set to pass to pi.setActiveTools(). */
  activeToolNames: string[];
  /** Markdown catalog to inject into the system prompt. */
  catalog: string;
  activeMcpCount: number;
  dormantMcpCount: number;
}

function unique(names: Iterable<string>): string[] {
  return [...new Set(names)];
}

export function computeLoadout({ allTools, universe, cfg, recency }: LoadoutInput): LoadoutResult {
  const serverNames = unique(universe.map((u) => u.server));
  const excluded = new Set(cfg.excludeFromCatalog);

  // Partition registered tools.
  const mcpTools = allTools.filter((t) => isMcpTool(t) && !INFRA_TOOLS.has(t.name));
  const nonMcpNames = allTools.filter((t) => !isMcpTool(t)).map((t) => t.name);
  const infraPresent = allTools.filter((t) => INFRA_TOOLS.has(t.name)).map((t) => t.name);

  // Score + select the registered MCP tools.
  const candidates: Candidate[] = mcpTools.map((t) => {
    const server = inferServer(t.name, serverNames);
    const score = (recency.get(t.name) ?? 0) + priorFor(t.name, server, cfg.prior);
    return { name: t.name, tokens: estimateTokens(t), score };
  });
  const { active } = selectActiveMcp(candidates, cfg.budgetTokens, cfg.alwaysActiveMcpTools);
  const activeMcp = new Set(active);

  const activeToolNames = unique([...nonMcpNames, ...active, ...infraPresent]);

  // Catalog: registered MCP tools (prefixed names) + proxy-only servers (from cache).
  const registeredServers = new Set(mcpTools.map((t) => inferServer(t.name, serverNames)).filter(Boolean));
  const catalogTools: CatalogTool[] = [];
  for (const t of mcpTools) {
    if (excluded.has(t.name)) continue;
    catalogTools.push({ name: t.name, server: inferServer(t.name, serverNames), proxyOnly: false });
  }
  for (const meta of universe) {
    if (registeredServers.has(meta.server)) continue; // covered by registered entries
    if (excluded.has(meta.name)) continue;
    catalogTools.push({ name: meta.name, server: meta.server, proxyOnly: true });
  }

  const catalog = buildCatalog(catalogTools, activeMcp);
  const dormantMcpCount = mcpTools.length - activeMcp.size;
  return { activeToolNames, catalog, activeMcpCount: activeMcp.size, dormantMcpCount };
}

/**
 * Bundle the stats→score→compute step the session_start handler runs (no I/O).
 * Tiered usage signal: trust this project's own history once it has enough MCP-tool
 * usage; below that threshold, rank by pooled global (all-project) usage; with no usage
 * anywhere, computeLoadout falls back to the configured prior.
 */
export function planActivation(
  allTools: readonly ToolInfo[],
  universe: readonly McpToolMeta[],
  cfg: LoadoutConfig,
  projectEvents: readonly UsageEvent[],
  globalEvents: readonly UsageEvent[],
  now: number = Date.now(),
): LoadoutResult {
  const mcpNames = new Set(
    allTools.filter((t) => isMcpTool(t) && !INFRA_TOOLS.has(t.name)).map((t) => t.name),
  );
  let relevantProjectEvents = 0;
  for (const e of projectEvents) if (mcpNames.has(e.name)) relevantProjectEvents++;
  const events = relevantProjectEvents >= cfg.minProjectEvents ? projectEvents : globalEvents;
  const recency = recencyScores(events, cfg.halfLifeDays, now);
  return computeLoadout({ allTools, universe, cfg, recency });
}
