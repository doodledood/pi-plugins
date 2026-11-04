// pi-mcp-adapter's metadata cache, read in one place: it keeps each server's tools with the
// annotations their server declares. The package uses it to check the configured Slack tool
// names, and to choose the MCP tools the Slack helper may use
// (docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md).
import { readFileSync } from "node:fs";

export interface CachedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export type McpCache = ReadonlyMap<string, readonly CachedTool[]>;

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

/**
 * The adapter's cache by server, or undefined when there is none yet (the adapter writes it after
 * its first discovery). A cache that exists but cannot be read is an error, never "no tools".
 */
export function readMcpCache(cachePath: string): McpCache | undefined {
  let raw: string;
  try {
    raw = readFileSync(cachePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  const servers = parsed && typeof parsed === "object" ? (parsed as { servers?: unknown }).servers : undefined;
  if (!servers || typeof servers !== "object") throw new Error(`${cachePath} has no "servers" object; pi-mcp-adapter's cache format changed`);
  const cache = new Map<string, CachedTool[]>();
  for (const [server, entry] of Object.entries(servers as Record<string, unknown>)) {
    // An entry whose discovery failed (for example a login that expired) has no catalog: the
    // server is not listed yet, rather than a server with no tools.
    if (entry && typeof entry === "object" && (entry as { discoveryFailed?: unknown }).discoveryFailed === true) continue;
    const tools = entry && typeof entry === "object" && Array.isArray((entry as { tools?: unknown }).tools) ? (entry as { tools: unknown[] }).tools : [];
    cache.set(server, tools.flatMap((tool): CachedTool[] => {
      if (!tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string") return [];
      const t = tool as { name: string; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
      return [{
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : { type: "object", properties: {} },
        readOnly: t.annotations?.readOnlyHint === true,
      }];
    }));
  }
  return cache;
}

function sanitizePrefix(server: string): string {
  return Array.from(server, (c) => (/^[A-Za-z0-9_-]$/.test(c) ? c : `_${c.codePointAt(0)!.toString(16)}_`)).join("");
}

/**
 * Every name pi-mcp-adapter can give this tool in a session: each tool-prefix mode, and the deferred
 * `mcp__<server>__<tool>` name. Mirrors the adapter's joinToolName; names it shortens with a hash
 * (over 64 characters) are not matched.
 */
export function exposedNamesFor(server: string, tool: string): string[] {
  const sanitized = tool.replace(/\./g, "_");
  const join = (prefix: string) => (prefix && sanitized.startsWith(`${prefix}_`) && sanitized.length > prefix.length + 1 ? sanitized : prefix ? `${prefix}_${sanitized}` : sanitized);
  const short = sanitizePrefix(server.replace(/-?mcp$/i, "")) || "mcp";
  const namespace = server.replace(/-/g, "_");
  return [...new Set([
    join(""),
    join(sanitizePrefix(server)),
    join(short),
    join(`mcp__${sanitizePrefix(server)}`),
    `mcp__${namespace}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_"),
  ])];
}

/** What the helper can reach over MCP: every tool it may call, and the few shown to it as tools of their own. */
export interface HelperMcpReach {
  /** Every tool the helper may call: marked read-only by its server, or listed by the owner as investigative. */
  catalog: McpToolInfo[];
  /** The part of the catalog the helper gets as tools of their own: main's active ones, and the listed ones. */
  direct: McpToolInfo[];
}

/**
 * The helper's MCP reach (the owner's call: all read-only reach). Every tool its server marks
 * read-only, plus the ones the owner listed as investigative (`tool` or `server/tool`), can be
 * called; the ones main has active right now, and the listed ones, are tools of their own, and
 * the rest are found and called through two package tools, so the helper's prompt stays small.
 * A tool named in `blocked` (the Slack send tool) is never reachable, whatever its marks or listing.
 */
export function helperMcpTools(cache: McpCache | undefined, activeMain: ReadonlySet<string>, investigative: readonly string[], blocked: readonly string[]): HelperMcpReach {
  if (!cache) return { catalog: [], direct: [] };
  const chosen: Array<Omit<McpToolInfo, "exposedName"> & { shown: boolean }> = [];
  for (const [server, tools] of cache) {
    for (const tool of tools) {
      if (blocked.includes(tool.name)) continue;
      const listed = investigative.includes(tool.name) || investigative.includes(`${server}/${tool.name}`);
      if (!listed && !tool.readOnly) continue;
      const active = exposedNamesFor(server, tool.name).some((name) => activeMain.has(name));
      chosen.push({ server, name: tool.name, description: tool.description, inputSchema: tool.inputSchema, shown: listed || active });
    }
  }
  const count = new Map<string, number>();
  for (const tool of chosen) count.set(tool.name, (count.get(tool.name) ?? 0) + 1);
  const catalog = chosen.map(({ shown: _shown, ...tool }) => ({ ...tool, exposedName: (count.get(tool.name) ?? 0) > 1 ? `${tool.server}__${tool.name}` : tool.name }));
  return { catalog, direct: catalog.filter((_tool, i) => chosen[i]!.shown) };
}

/**
 * The configured Slack tool names that the cache shows are wrong, judged only against a server that
 * would serve them: the configured `server`, else any server that lists at least one of them. When
 * no such server is cached yet (the adapter is still discovering), nothing is judged here; the
 * first read then reports a wrong name itself.
 */
export function missingSlackTools(cache: McpCache | undefined, names: readonly string[], server: string | undefined): string[] {
  if (!cache) return [];
  const candidates = server
    ? (cache.has(server) ? [cache.get(server)!] : [])
    : [...cache.values()].filter((tools) => tools.some((t) => names.includes(t.name)));
  if (!candidates.length) return [];
  const known = new Set(candidates.flat().map((t) => t.name));
  return names.filter((name) => !known.has(name));
}
