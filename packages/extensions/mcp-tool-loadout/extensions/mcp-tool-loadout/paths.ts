// Lazy path resolution so tests can override PI_CODING_AGENT_DIR at call time.
import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configPath(): string {
  return join(agentDir(), "mcp-tool-loadout.json");
}

export function cachePath(): string {
  return join(agentDir(), "mcp-cache.json");
}

export function statsPath(): string {
  return join(agentDir(), "mcp-tool-loadout-stats.json");
}
