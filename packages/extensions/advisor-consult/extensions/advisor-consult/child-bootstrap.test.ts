import test from "node:test";
import assert from "node:assert/strict";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { activate, broadenedActiveTools, type BootstrapPi } from "./child-bootstrap.ts";

function tool(name: string, source: string, path = ""): ToolInfo {
  return { name, description: "", parameters: {}, sourceInfo: { source, path } } as unknown as ToolInfo;
}

const ALL_TOOLS: ToolInfo[] = [
  tool("read", "builtin"),
  tool("bash", "builtin"),
  tool("grep", "builtin"),
  tool("find", "builtin"),
  tool("ls", "builtin"),
  tool("web_search", "extension", "/pkg/pi-web-access/index.ts"),
  tool("mcp", "extension", "/pkg/pi-mcp-adapter/index.ts"),
  tool("load_tools", "extension", "/pkg/mcp-tool-loadout/index.ts"),
  tool("snowflake_run_query", "pi-mcp-adapter", "/pkg/pi-mcp-adapter/tool.ts"),
];

test("broadenedActiveTools activates all non-MCP tools including search/list built-ins", () => {
  const next = new Set(broadenedActiveTools(ALL_TOOLS, ["read", "bash", "edit", "write"]));
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "web_search"]) {
    assert.ok(next.has(name), `expected ${name} active`);
  }
});

test("broadenedActiveTools keeps MCP infra reachable but does not force MCP schemas active", () => {
  const next = new Set(broadenedActiveTools(ALL_TOOLS, []));
  assert.ok(next.has("mcp"), "mcp proxy must stay reachable");
  assert.ok(next.has("load_tools"), "load_tools must stay reachable");
  assert.equal(next.has("snowflake_run_query"), false, "MCP tool schemas must not be force-activated");
});

test("broadenedActiveTools preserves an already-active MCP tool (loadout's budget)", () => {
  const next = new Set(broadenedActiveTools(ALL_TOOLS, ["snowflake_run_query"]));
  assert.ok(next.has("snowflake_run_query"), "an already-budgeted MCP tool stays active");
});

test("activate broadens tools on session_start and fails safe", () => {
  let active: string[] = ["read", "bash", "edit", "write"];
  let handler: (() => void) | undefined;
  const pi: BootstrapPi = {
    on: (_event, h) => {
      handler = h as () => void;
    },
    getAllTools: () => ALL_TOOLS,
    getActiveTools: () => active,
    setActiveTools: (names) => {
      active = names;
    },
  };
  activate(pi);
  assert.ok(handler, "session_start handler registered");
  handler?.();
  assert.ok(active.includes("grep") && active.includes("web_search"));

  // Fail-safe: a throwing setActiveTools must not propagate.
  const throwingPi: BootstrapPi = {
    on: (_e, h) => {
      handler = h as () => void;
    },
    getAllTools: () => ALL_TOOLS,
    getActiveTools: () => [],
    setActiveTools: () => {
      throw new Error("boom");
    },
  };
  activate(throwingPi);
  assert.doesNotThrow(() => handler?.());
});
