// Build the always-visible MCP tool-name catalog injected into the system prompt.
// Names-only (with active/dormant/proxy markers) so it stays compact and deterministic,
// and stays inside the cached prefix. Active tools also appear with full schemas in the
// normal tool list, so the catalog deliberately does not repeat their descriptions.

export interface CatalogTool {
  name: string;
  /** Originating server (for grouping); "" → grouped under "mcp". */
  server: string;
  /** When true the tool is reachable only via the `mcp` proxy (not directly loadable). */
  proxyOnly?: boolean;
}

const HEADER = "## MCP tool catalog (all available MCP tools — names always visible)";
const HOWTO =
  "Unmarked tools are active and callable directly (full schema in the tool list). " +
  '·dormant tools are cache-safe: call `load_tools({ names:["tool_name"] })` to get schemas, then call via `mcp({ tool, args })`; ' +
  'use `load_tools({ names:["tool_name"], direct:true })` only when direct native calls are worth a prompt-cache rewrite. ' +
  "·proxy tools are not directly loadable — call via `mcp({ tool, args })`.";

/**
 * Render a deterministic, names-only markdown catalog grouped by server. `activeNames`
 * marks which tools are active; everything else is ·dormant (or ·proxy for proxy-only).
 */
export function buildCatalog(tools: readonly CatalogTool[], activeNames: ReadonlySet<string>): string {
  const byServer = new Map<string, CatalogTool[]>();
  for (const t of tools) {
    const key = t.server || "mcp";
    const list = byServer.get(key);
    if (list) list.push(t);
    else byServer.set(key, [t]);
  }

  const lines: string[] = [HEADER, HOWTO];
  for (const server of [...byServer.keys()].sort((a, b) => a.localeCompare(b))) {
    lines.push("", `### ${server}`);
    const group = [...byServer.get(server)!].sort((a, b) => a.name.localeCompare(b.name));
    for (const t of group) {
      const mark = t.proxyOnly ? " ·proxy" : activeNames.has(t.name) ? "" : " ·dormant";
      lines.push(`- \`${t.name}\`${mark}`);
    }
  }
  return lines.join("\n");
}
