// Detect which Pi tools come from the pi-mcp-adapter, and load the full MCP tool
// universe (names + descriptions, per server) from the adapter's metadata cache.
import { existsSync, readFileSync } from "node:fs";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { cachePath } from "./paths.ts";

/** Infrastructure tools that must never be gated off (the proxy + our wake tool). */
export const INFRA_TOOLS = new Set<string>(["mcp", "load_tools"]);

const ADAPTER_MARKERS = ["pi-mcp-adapter", "mcp-adapter"];

/** True when the tool was registered by the pi-mcp-adapter (i.e. it is an MCP tool). */
export function isMcpTool(tool: Pick<ToolInfo, "sourceInfo">): boolean {
  const src = tool.sourceInfo;
  if (!src) return false;
  const hay = `${src.source ?? ""} ${src.path ?? ""}`.toLowerCase();
  return ADAPTER_MARKERS.some((m) => hay.includes(m));
}

export interface McpToolMeta {
  server: string;
  /** Original (unprefixed) MCP tool name as stored in the cache. */
  name: string;
  description: string;
}

/** Load the full MCP tool universe from the adapter metadata cache (graceful on missing/empty). */
export function loadMcpUniverse(path: string = cachePath()): McpToolMeta[] {
  if (!existsSync(path)) return [];
  let cache: unknown;
  try {
    cache = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const servers =
    typeof cache === "object" && cache !== null && "servers" in cache
      ? (cache as { servers?: Record<string, unknown> }).servers
      : undefined;
  if (!servers || typeof servers !== "object") return [];
  const out: McpToolMeta[] = [];
  for (const [server, svRaw] of Object.entries(servers)) {
    const tools =
      typeof svRaw === "object" && svRaw !== null && Array.isArray((svRaw as { tools?: unknown }).tools)
        ? ((svRaw as { tools: unknown[] }).tools)
        : [];
    for (const t of tools) {
      if (typeof t === "object" && t !== null && typeof (t as { name?: unknown }).name === "string") {
        const tt = t as { name: string; description?: unknown };
        out.push({
          server,
          name: tt.name,
          description: typeof tt.description === "string" ? tt.description : "",
        });
      }
    }
  }
  return out;
}

/** Sanitize a server name into the prefix the adapter uses for direct tool names. */
export function serverPrefix(server: string): string {
  return server.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Infer the originating server for a registered (prefixed) MCP tool name by
 * longest-matching server prefix. Returns "" when no server matches.
 */
export function inferServer(toolName: string, serverNames: readonly string[]): string {
  let best = "";
  let bestLen = -1;
  for (const server of serverNames) {
    const prefix = `${serverPrefix(server)}_`;
    if (toolName.startsWith(prefix) && prefix.length > bestLen) {
      best = server;
      bestLen = prefix.length;
    }
  }
  return best;
}
