// Advisor subprocess tool-loadout bootstrap.
//
// Loaded ONLY inside the advisor `pi` subprocess via an explicit `-e` argument
// (never listed in package.json `pi.extensions`, so normal sessions never load
// it). Its single job: after the child's extensions register, broaden the active
// tool set so the advisor can actually reach the file/search/list built-ins and
// every extension tool — not just Pi's default `read,bash,edit,write`.
//
// It deliberately does NOT touch MCP tools: their schema budgeting is owned by
// mcp-tool-loadout (when installed), and force-activating every MCP schema would
// blow the prompt-cache budget. Hazardous tools (advisor_consult, ask_user_question,
// the orchestration tools) are already removed from the registry by the parent's
// `--exclude-tools`, so they never appear in `getAllTools()` here.
//
// Fails safe: on any error it leaves the tool set unchanged rather than degrading
// the advisor.
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { isMcpTool, MCP_INFRA_TOOLS } from "./child-profile.ts";

/** Minimal seam over the Pi API so the broadening logic is unit-testable. */
export interface BootstrapPi {
  on(event: "session_start", handler: (event: unknown, ctx: unknown) => void | Promise<void>): void;
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

/**
 * Compute the broadened active tool set: keep whatever is already active, add
 * every non-MCP tool (built-ins + extension/custom tools), and keep MCP infra
 * (`mcp`, `load_tools`) reachable. MCP tools themselves are left as-is.
 */
export function broadenedActiveTools(allTools: readonly ToolInfo[], currentActive: readonly string[]): string[] {
  const active = new Set<string>(currentActive);
  for (const tool of allTools) {
    if (MCP_INFRA_TOOLS.has(tool.name)) {
      active.add(tool.name);
      continue;
    }
    if (isMcpTool(tool.sourceInfo)) continue;
    active.add(tool.name);
  }
  return [...active];
}

export function activate(pi: BootstrapPi): void {
  pi.on("session_start", () => {
    try {
      pi.setActiveTools(broadenedActiveTools(pi.getAllTools(), pi.getActiveTools()));
    } catch (error) {
      console.error("advisor-consult child bootstrap: failed to broaden tools, leaving set unchanged", error);
    }
  });
}

export default function advisorConsultChildBootstrap(pi: ExtensionAPI): void {
  // ExtensionAPI satisfies BootstrapPi.
  activate(pi as unknown as BootstrapPi);
}
