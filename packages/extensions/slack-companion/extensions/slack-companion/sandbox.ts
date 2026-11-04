// The Slack helper's shell: every command runs under @anthropic-ai/sandbox-runtime, writing
// only to a scratch folder, reading no secrets, and reaching no network unless the owner
// listed a domain. If the sandbox cannot start, the helper gets no shell at all.
// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md.
import { mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { secretDirectories } from "./secrets.ts";

export type ShellSandbox =
  | { ok: true; operations: BashOperations; scratchDir: string }
  | { ok: false; reason: string };

export interface SandboxOptions {
  cwd: string;
  allowedDomains: readonly string[];
  agentDir?: string;
  home?: string;
}

/** The read denials, as absolute paths and anchored patterns (bare patterns do not match on macOS). */
export function denyReadEntries(options: SandboxOptions): string[] {
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? join(home, ".pi", "agent");
  const roots = [...new Set([home, options.cwd])];
  return [
    ...secretDirectories(home, agentDir),
    join(agentDir, "auth.json"),
    join(home, ".netrc"),
    join(home, ".npmrc"),
    join(home, ".pgpass"),
    ...roots.flatMap((root) => [`${root}/**/.env`, `${root}/**/.env.*`]),
  ];
}

interface SandboxRuntime {
  isSupportedPlatform(): boolean;
  initialize(config: unknown): Promise<void>;
  wrapWithSandbox(command: string, binShell?: string, customConfig?: unknown, abortSignal?: AbortSignal): Promise<string>;
}

async function loadRuntime(): Promise<SandboxRuntime> {
  const module = await import("@anthropic-ai/sandbox-runtime");
  return module.SandboxManager as unknown as SandboxRuntime;
}

let initialized: Promise<SandboxRuntime> | undefined;

/** Start (once per process) and return sandboxed bash operations, or why there is no shell. */
export async function startShellSandbox(options: SandboxOptions, runtime?: SandboxRuntime): Promise<ShellSandbox> {
  try {
    const manager = runtime ?? (await loadRuntime());
    if (!manager.isSupportedPlatform()) return { ok: false, reason: "sandbox-runtime does not support this platform" };
    const scratchDir = realpathSync(await mkdtemp(join(tmpdir(), "pi-slack-helper-")));
    const config = {
      network: { allowedDomains: [...options.allowedDomains], deniedDomains: [] },
      filesystem: { denyRead: denyReadEntries(options), allowWrite: [scratchDir], denyWrite: [] },
    };
    if (!runtime) {
      initialized ??= manager.initialize(config).then(() => manager);
      await initialized;
    } else {
      await manager.initialize(config);
    }
    const local = createLocalBashOperations();
    const operations: BashOperations = {
      async exec(command, cwd, execOptions) {
        const wrapped = await manager.wrapWithSandbox(command, undefined, config, execOptions.signal);
        return local.exec(wrapped, cwd, execOptions);
      },
    };
    return { ok: true, operations, scratchDir };
  } catch (error) {
    initialized = undefined;
    return { ok: false, reason: `sandbox-runtime could not start: ${(error as Error).message}` };
  }
}
