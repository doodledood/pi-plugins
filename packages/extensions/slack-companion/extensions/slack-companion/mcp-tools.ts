// The MCP tools the Slack helper may use: read from pi-mcp-adapter's metadata cache, which keeps
// each server's tools with the annotations their server declares, whether the adapter exposes
// them as direct tools, deferred `mcp__<server>__<tool>` tools, or only through its proxy.
import { readFileSync } from "node:fs";

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The name the helper sees: the tool's own, or `<server>__<tool>` when two servers share it. */
  exposedName: string;
}

export function mcpCachePathIn(agentDir: string): string {
  return `${agentDir}/mcp-cache.json`;
}

/** Tools whose server marks them read-only, plus the ones the owner listed as investigative. */
export function readOnlyMcpTools(cachePath: string, investigative: readonly string[], blocked: readonly string[]): McpToolInfo[] {
  let cache: any;
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return [];
  }
  const servers = cache && typeof cache === "object" ? cache.servers : undefined;
  if (!servers || typeof servers !== "object") return [];
  const chosen: Omit<McpToolInfo, "exposedName">[] = [];
  for (const [server, entry] of Object.entries<any>(servers)) {
    for (const tool of Array.isArray(entry?.tools) ? entry.tools : []) {
      if (typeof tool?.name !== "string") continue;
      if (blocked.includes(tool.name)) continue;
      const readOnly = tool.annotations?.readOnlyHint === true;
      if (!readOnly && !investigative.includes(tool.name) && !investigative.includes(`${server}/${tool.name}`)) continue;
      chosen.push({
        server,
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : { type: "object", properties: {} },
      });
    }
  }
  const count = new Map<string, number>();
  for (const tool of chosen) count.set(tool.name, (count.get(tool.name) ?? 0) + 1);
  return chosen.map((tool) => ({ ...tool, exposedName: (count.get(tool.name) ?? 0) > 1 ? `${tool.server}__${tool.name}` : tool.name }));
}
