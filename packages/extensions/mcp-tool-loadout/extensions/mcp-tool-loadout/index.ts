// mcp-tool-loadout — usage-driven MCP tool loadout for Pi.
//
// Keeps the model aware of every MCP tool (always-visible name catalog) while keeping
// only a budgeted, usage-ranked subset of MCP tool *schemas* active in the prompt.
// The rest are cache-safely loaded as schemas in a tool result and called via the
// existing `mcp` proxy; direct activation is an explicit escape hatch.
//
// Design notes:
// - The active set is chosen once per session_start and held stable, because changing
//   it mid-session invalidates Pi's prompt cache. Default load_tools wakes never mutate
//   that set; direct activation is opt-in for cheap contexts or reliability-sensitive calls.
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
import { performCacheSafeLoadTools, performLoadTools } from "./actions.ts";
import { resolveProjectKey } from "./project.ts";
import type { LoadoutPi } from "./host.ts";

const STATUS_KEY = "mcp-loadout";

const loadToolsSchema = Type.Object({
  names: Type.Array(Type.String(), {
    description: "Exact dormant tool names from the MCP catalog.",
  }),
  direct: Type.Optional(
    Type.Boolean({
      description:
        "When true, hard-activate tools so they can be called directly. Default false keeps the prompt cache stable and returns schemas for mcp proxy calls.",
    }),
  ),
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
      "Cache-safely load dormant MCP tool schemas without changing the active tool set. " +
      "Pass exact tool names from the MCP tool catalog; the result shows schemas and mcp({ tool, args }) examples. " +
      "Set direct:true only when you deliberately want native direct calls and accept a prompt-cache rewrite.",
    promptSnippet: "Load dormant MCP tool schemas cache-safely for proxy calls",
    promptGuidelines: [
      "Use load_tools for dormant MCP tools when you need their schemas; by default it keeps the prompt cache stable and then you call the tool through mcp({ tool, args }).",
      "Set load_tools direct:true only when direct native tool calling is worth the prompt-cache rewrite at the current context size.",
    ],
    parameters: loadToolsSchema,
    async execute(_toolCallId: string, params: LoadToolsParams) {
      const requested = Array.isArray(params?.names) ? params.names : [];
      const outcome = params?.direct ? performLoadTools(pi, requested) : performCacheSafeLoadTools(pi, requested);
      return {
        content: [{ type: "text" as const, text: outcome.message }],
        details: { loadable: outcome.loadable, unknown: outcome.unknown, direct: params?.direct === true },
      };
    },
  });

  // ExtensionAPI is assignable to LoadoutPi.
  activate(pi);
}
