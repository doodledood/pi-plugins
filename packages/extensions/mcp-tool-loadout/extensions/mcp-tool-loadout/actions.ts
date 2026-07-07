// Wake-on-demand for dormant MCP tools.
// Default path is cache-safe: return schemas + proxy call shapes without changing the active tool set.
// Explicit hard activation remains available for cheap contexts or when direct function calling is worth a cache rewrite.

export interface ToolDescriptor {
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Minimal surface of the Pi API needed to wake tools — kept tiny so it is trivially mockable. */
export interface ToolHost {
  getAllTools(): ReadonlyArray<ToolDescriptor>;
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export interface LoadToolsOutcome {
  nextActive: string[];
  loadable: string[];
  unknown: string[];
  message: string;
}

/** Decide the next active set and the user-facing message. No side effects. */
export function resolveLoadTools(
  requested: readonly string[],
  known: ReadonlySet<string>,
  currentActive: readonly string[],
): LoadToolsOutcome {
  const req = requested.filter((n) => typeof n === "string" && n.length > 0);
  const loadable = req.filter((n) => known.has(n));
  const unknown = req.filter((n) => !known.has(n));
  const nextActive = [...new Set([...currentActive, ...loadable])];

  const parts: string[] = [];
  if (loadable.length > 0) parts.push(`Loaded: ${loadable.join(", ")}.`);
  if (unknown.length > 0) {
    parts.push(`No registered schema available (call via mcp({ tool, args }) if it is proxy-only): ${unknown.join(", ")}.`);
  }
  if (parts.length === 0) parts.push("No tool names provided.");

  return { nextActive, loadable, unknown, message: parts.join(" ") };
}

/** Apply resolveLoadTools against a host, activating loadable tools. */
export function performLoadTools(host: ToolHost, requested: readonly string[]): LoadToolsOutcome {
  const known = new Set(host.getAllTools().map((t) => t.name));
  const outcome = resolveLoadTools(requested, known, host.getActiveTools());
  if (outcome.loadable.length > 0) host.setActiveTools(outcome.nextActive);
  return outcome;
}

/** Cache-safe load: provide schemas and proxy call shapes without mutating the tool set. */
export function performCacheSafeLoadTools(host: ToolHost, requested: readonly string[]): LoadToolsOutcome {
  const toolsByName = new Map(host.getAllTools().map((tool) => [tool.name, tool]));
  const currentActive = host.getActiveTools();
  const known = new Set(toolsByName.keys());
  const outcome = resolveLoadTools(requested, known, currentActive);
  return {
    ...outcome,
    nextActive: currentActive,
    message: formatCacheSafeLoadMessage(outcome.loadable.map((name) => toolsByName.get(name)!).filter(Boolean), outcome.unknown),
  };
}

function formatCacheSafeLoadMessage(loadable: readonly ToolDescriptor[], unknown: readonly string[]): string {
  const parts: string[] = [];
  if (loadable.length > 0) {
    parts.push(
      "Cache-safe load: no tools were activated, so the prompt/tool schema set stays stable. " +
        "Use the existing mcp proxy with the schemas below.",
    );
    for (const tool of loadable) {
      parts.push(formatToolSchema(tool));
    }
  }
  if (unknown.length > 0) {
    parts.push(
      `No registered schema available for: ${unknown.join(", ")}. If the catalog marks one as ·proxy, call it through mcp({ tool, args }) directly.`,
    );
  }
  if (parts.length === 0) parts.push("No tool names provided.");
  return parts.join("\n\n");
}

function formatToolSchema(tool: ToolDescriptor): string {
  const schema = {
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters ?? {},
  };
  const argsExample = exampleArgs(tool.parameters);
  return [
    `### ${tool.name}`,
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "Call via proxy:",
    "```ts",
    `mcp({ tool: ${JSON.stringify(tool.name)}, args: ${JSON.stringify(JSON.stringify(argsExample))} })`,
    "```",
  ].join("\n");
}

function exampleArgs(parameters: unknown): Record<string, string> {
  if (!parameters || typeof parameters !== "object") return {};
  const props = (parameters as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(props as Record<string, unknown>).slice(0, 3)) out[key] = "...";
  return out;
}
