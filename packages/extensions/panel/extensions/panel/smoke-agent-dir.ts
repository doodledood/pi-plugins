import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Points every Pi lookup in a smoke run at a fresh agent directory inside `workDir`, so the run
 * loads none of the person's installed extensions and reads none of their saved credentials;
 * provider keys come from the environment. Call it before anything resolves the agent directory.
 */
export function isolateAgentDir(workDir: string): string {
  const dir = join(workDir, "agent");
  mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = dir;
  if (getAgentDir() !== dir) throw new Error(`smoke agent directory not isolated: Pi resolves ${getAgentDir()}, not ${dir}`);
  return dir;
}
