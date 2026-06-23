// Test helpers: typed ToolInfo fixtures and temp-file scaffolding. Not a test file.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type TSchema } from "typebox";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

export function params(propCount = 0): TSchema {
  const props: Record<string, TSchema> = {};
  for (let i = 0; i < propCount; i++) props[`p${i}`] = Type.String({ description: "x".repeat(20) });
  return Type.Object(props);
}

export function mcpTool(name: string, description = "", propCount = 0): ToolInfo {
  return {
    name,
    description,
    parameters: params(propCount),
    sourceInfo: { path: "/pkg/pi-mcp-adapter/index.ts", source: "pi-mcp-adapter", scope: "user", origin: "package" },
  };
}

export function builtinTool(name: string, description = ""): ToolInfo {
  return {
    name,
    description,
    parameters: params(0),
    sourceInfo: { path: "/core", source: "builtin", scope: "user", origin: "top-level" },
  };
}

export function ourTool(name: string, description = ""): ToolInfo {
  return {
    name,
    description,
    parameters: params(0),
    sourceInfo: { path: "/ext/mcp-tool-loadout/index.ts", source: "mcp-tool-loadout", scope: "user", origin: "top-level" },
  };
}

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "loadout-"));
}

export function writeJson(path: string, obj: unknown): void {
  writeFileSync(path, JSON.stringify(obj), "utf8");
}

export function writeRaw(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
}
