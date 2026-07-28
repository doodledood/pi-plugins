/**
 * Install and uninstall the parts of HQ that live outside the package: the state
 * root, the doctrine files, and one reference line in the agent instructions so
 * every session knows where doctrine lives.
 *
 * Both directions are idempotent, and both take explicit targets so a trial run
 * can be pointed at a sandbox instead of the real setup:
 *
 *   tsx extensions/hq/install.ts --state-root /tmp/hq --agent-instructions /tmp/AGENTS.md
 *   tsx extensions/hq/install.ts --uninstall --agent-instructions /tmp/AGENTS.md
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { seedDoctrine } from "./doctrine.ts";
import { atomicWriteText, ensureLayout, materializeIfAbsent, pathExists } from "./io.ts";
import { expandHome, hqPaths, resolveStateRoot } from "./paths.ts";
import { HQ_EXAMPLE_CONFIG } from "./templates.ts";
import { configPath } from "./config.ts";

export const REFERENCE_MARKER = "<!-- pi-hq:doctrine -->";

export function referenceLine(doctrinePath: string): string {
  return `${REFERENCE_MARKER}\n- HQ doctrine (the standing rules HQ decides by, and its own settings) lives at \`${doctrinePath}\`. Read it when a decision needs the user's standing preferences; edit it to change them.`;
}

export function defaultAgentInstructionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  return agentDir
    ? join(expandHome(agentDir), "AGENTS.md")
    : join(homedir(), ".pi", "agent", "AGENTS.md");
}

/** Adds the reference line once; a second run changes nothing. */
export async function ensureReference(
  instructionsPath: string,
  doctrinePath: string,
): Promise<"added" | "already-present"> {
  const line = referenceLine(doctrinePath);
  const existing = (await pathExists(instructionsPath))
    ? await readFile(instructionsPath, "utf8")
    : "";
  if (existing.includes(REFERENCE_MARKER)) return "already-present";
  const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  await atomicWriteText(instructionsPath, `${existing}${separator}${line}\n`);
  return "added";
}

export async function removeReference(instructionsPath: string): Promise<"removed" | "absent"> {
  if (!(await pathExists(instructionsPath))) return "absent";
  const existing = await readFile(instructionsPath, "utf8");
  if (!existing.includes(REFERENCE_MARKER)) return "absent";
  const lines = existing.split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes(REFERENCE_MARKER)) {
      // Drop the marker and the bullet that follows it.
      if ((lines[index + 1] ?? "").trimStart().startsWith("- HQ doctrine")) index += 1;
      continue;
    }
    kept.push(lines[index] ?? "");
  }
  await atomicWriteText(instructionsPath, kept.join("\n").replace(/\n{3,}$/, "\n"));
  return "removed";
}

export interface InstallOptions {
  stateRoot: string;
  agentInstructions: string;
  configTarget: string;
}

export async function install(options: InstallOptions): Promise<string[]> {
  const notes: string[] = [];
  await ensureLayout(options.stateRoot);
  notes.push(`state root: ${options.stateRoot}`);

  const doctrine = await seedDoctrine(options.stateRoot);
  notes.push(
    doctrine.created
      ? `seeded doctrine: ${hqPaths(options.stateRoot).doctrineGlobal}`
      : `doctrine already present (left untouched): ${hqPaths(options.stateRoot).doctrineGlobal}`,
  );

  const config = await materializeIfAbsent(options.configTarget, HQ_EXAMPLE_CONFIG);
  notes.push(config ? `wrote config: ${options.configTarget}` : `config already present: ${options.configTarget}`);

  const reference = await ensureReference(
    options.agentInstructions,
    hqPaths(options.stateRoot).doctrineGlobal,
  );
  notes.push(`agent instructions (${options.agentInstructions}): ${reference}`);
  return notes;
}

export async function uninstall(options: Pick<InstallOptions, "agentInstructions">): Promise<string[]> {
  const reference = await removeReference(options.agentInstructions);
  return [
    `agent instructions (${options.agentInstructions}): ${reference}`,
    "state left in place: HQ's queue, doctrine, and logs are yours to read or delete",
  ];
}

function flag(name: string, argv: readonly string[]): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stateRoot = flag("state-root", argv) ?? resolveStateRoot();
  const agentInstructions = flag("agent-instructions", argv) ?? defaultAgentInstructionsPath();
  const configTarget = flag("config", argv) ?? configPath();

  const notes = argv.includes("--uninstall")
    ? await uninstall({ agentInstructions })
    : await install({ stateRoot, agentInstructions, configTarget });

  process.stdout.write(`${notes.map((note) => `  ${note}`).join("\n")}\n`);
}

// Only run as a script, so the functions above stay importable by tests.
if (process.argv[1] && process.argv[1].endsWith("install.ts")) {
  await main();
}
