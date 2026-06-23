// Wake-on-demand: activate dormant (but registered) MCP tools for the rest of the session.
// Pure decision (resolveLoadTools) + a thin host application (performLoadTools).

/** Minimal surface of the Pi API needed to wake tools — kept tiny so it is trivially mockable. */
export interface ToolHost {
  getAllTools(): ReadonlyArray<{ name: string }>;
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
    parts.push(`Not directly loadable (call via mcp({ tool, args }) instead): ${unknown.join(", ")}.`);
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
