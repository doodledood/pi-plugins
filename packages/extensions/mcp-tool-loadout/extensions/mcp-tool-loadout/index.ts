// mcp-tool-loadout — usage-driven MCP tool loadout for Pi.
//
// Keeps the model aware of every MCP tool (always-visible name catalog) while keeping
// only a budgeted, usage-ranked subset of MCP tool *schemas* active in the prompt.
// The rest are woken on demand via load_tools (or called one-off via the `mcp` proxy).
//
// Design notes:
// - The active set is chosen once per session_start and held stable, because changing
//   it mid-session invalidates Pi's prompt cache. Wakes via load_tools are intentional,
//   bounded cache misses.
// - Only pi-mcp-adapter tools are ever gated; built-ins and other tools always stay active.
// - All event work is wrapped to fail safe: on any error the extension no-ops and leaves
//   tools active rather than degrading the agent.
// - `activate(pi)` holds the testable event wiring behind the minimal LoadoutPi seam; the
//   default export adds the load_tools tool (which needs the full ExtensionAPI) and delegates.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { loadConfig, type LoadoutConfig } from "./config.ts";
import { loadMcpUniverse } from "./mcp-detect.ts";
import { StatsStore, attributeToolNames } from "./stats.ts";
import { planActivation } from "./compute.ts";
import { performLoadTools } from "./actions.ts";
import { resolveProjectKey } from "./project.ts";
import type { LoadoutPi } from "./host.ts";

const STATUS_KEY = "mcp-loadout";

const loadToolsSchema = Type.Object({
  names: Type.Array(Type.String(), {
    description: "Exact tool names to load into context for the rest of the session.",
  }),
});
type LoadToolsParams = Static<typeof loadToolsSchema>;

/** Event wiring. Exported and seam-typed so it can be driven by a mock in tests. */
export function activate(pi: LoadoutPi): void {
  let cfg: LoadoutConfig | null = null;
  let store: StatsStore | null = null;
  let sessionCatalog: string | null = null;
  let currentProject = "";
  let dirty = false;

  pi.on("session_start", async (_event, ctx) => {
    sessionCatalog = null;
    dirty = false;
    currentProject = resolveProjectKey(ctx.cwd);
    try {
      cfg = loadConfig();
      if (!cfg.enabled) {
        ctx.ui.setStatus(STATUS_KEY, "loadout: off");
        return;
      }
      store = StatsStore.load();
      const universe = loadMcpUniverse();
      const allTools = pi.getAllTools();
      const result = planActivation(
        allTools,
        universe,
        cfg,
        store.eventsFor(currentProject),
        store.allEvents(),
      );
      pi.setActiveTools(result.activeToolNames);
      sessionCatalog = result.catalog;
      ctx.ui.setStatus(
        STATUS_KEY,
        `loadout: ${result.activeMcpCount} active / ${result.dormantMcpCount} dormant MCP`,
      );
    } catch (error) {
      // Fail safe: leave the default tool set untouched.
      console.error("mcp-tool-loadout: session_start failed, leaving tools unchanged", error);
      sessionCatalog = null;
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!cfg?.enabled || !sessionCatalog) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${sessionCatalog}` };
  });

  pi.on("tool_call", async (event) => {
    try {
      if (!cfg?.enabled || !store) return;
      const names = attributeToolNames(event.toolName, event.input);
      if (names.length > 0) {
        store.record(currentProject, names);
        dirty = true;
      }
    } catch (error) {
      console.error("mcp-tool-loadout: tool_call record failed", error);
    }
  });

  const flush = (): void => {
    try {
      if (dirty && store) {
        store.save();
        dirty = false;
      }
    } catch (error) {
      console.error("mcp-tool-loadout: stats save failed", error);
    }
  };

  pi.on("turn_end", async () => flush());
  pi.on("session_shutdown", async () => flush());
}

export default function mcpToolLoadout(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "load_tools",
    label: "Load Tools",
    description:
      "Activate dormant MCP tools for the rest of this session so they can be called " +
      "directly. Pass exact tool names from the MCP tool catalog. After loading, call the " +
      "tool on a subsequent turn. For a single one-off call you can instead use " +
      "mcp({ tool, args }) without loading.",
    promptSnippet: "Activate dormant MCP tools by name so they can be called directly",
    promptGuidelines: [
      "Use load_tools when you need an MCP tool shown as ·dormant in the catalog and expect to call it.",
    ],
    parameters: loadToolsSchema,
    async execute(_toolCallId: string, params: LoadToolsParams) {
      const requested = Array.isArray(params?.names) ? params.names : [];
      const outcome = performLoadTools(pi, requested);
      return {
        content: [{ type: "text" as const, text: outcome.message }],
        details: { loadable: outcome.loadable, unknown: outcome.unknown },
      };
    },
  });

  // ExtensionAPI is assignable to LoadoutPi.
  activate(pi);
}
