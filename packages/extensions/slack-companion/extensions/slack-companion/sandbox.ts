// The Slack helper's shell: every command runs under @anthropic-ai/sandbox-runtime, writing
// only to a scratch folder, reading no secrets, seeing no credential-like environment variable,
// and reaching no network unless the owner listed a domain. If the sandbox cannot start, the
// helper gets no shell at all. Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md.
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { sanitizeEnv, SECRET_FILE_GLOBS, secretDirectories } from "./secrets.ts";

export type ShellSandbox =
  | { ok: true; operations: BashOperations; scratchDir: string; dispose(): Promise<void> }
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
  return [...secretDirectories(home, agentDir), ...roots.flatMap((root) => SECRET_FILE_GLOBS.map((name) => `${root}/**/${name}`))];
}

export interface SandboxRuntime {
  isSupportedPlatform(): boolean;
  initialize(config: unknown): Promise<void>;
  updateConfig?(config: unknown): void;
  wrapWithSandbox(command: string, binShell?: string, customConfig?: unknown, abortSignal?: AbortSignal): Promise<string>;
}

async function loadRuntime(): Promise<SandboxRuntime> {
  const module = await import("@anthropic-ai/sandbox-runtime");
  return module.SandboxManager as unknown as SandboxRuntime;
}

// sandbox-runtime keeps one process-wide policy: initialize once, then update it whenever the
// policy differs, since its network filter reads the global policy rather than per-call config.
let ready: { runtime: SandboxRuntime; policy: string } | undefined;

/** Start and return sandboxed bash operations, or why there is no shell. */
export async function startShellSandbox(options: SandboxOptions, runtime?: SandboxRuntime): Promise<ShellSandbox> {
  if (process.platform === "win32") return { ok: false, reason: "the helper's shell is not supported on Windows" };
  let scratchDir: string | undefined;
  try {
    const manager = runtime ?? (await loadRuntime());
    if (!manager.isSupportedPlatform()) return { ok: false, reason: "sandbox-runtime does not support this platform" };
    scratchDir = realpathSync(await mkdtemp(join(tmpdir(), "pi-slack-helper-")));
    const config = {
      network: { allowedDomains: [...options.allowedDomains], deniedDomains: [] },
      filesystem: { denyRead: denyReadEntries(options), allowWrite: [scratchDir], denyWrite: [] },
    };
    const policy = JSON.stringify({ network: config.network, denyRead: config.filesystem.denyRead });
    if (!ready || ready.runtime !== manager) {
      await manager.initialize(config);
      ready = { runtime: manager, policy };
    } else if (ready.policy !== policy) {
      if (!manager.updateConfig) throw new Error("sandbox-runtime cannot change its policy in this process");
      manager.updateConfig(config);
      ready.policy = policy;
    }
    const local = createLocalBashOperations();
    const scratch = scratchDir;
    const operations: BashOperations = {
      async exec(command, cwd, execOptions) {
        const wrapped = await manager.wrapWithSandbox(command, undefined, config, execOptions.signal);
        // SCRATCH names the one folder a command may write (sandbox-runtime sets its own TMPDIR).
        return local.exec(wrapped, cwd, { ...execOptions, env: { ...sanitizeEnv(execOptions.env ?? process.env), SCRATCH: scratch } });
      },
    };
    return { ok: true, operations, scratchDir: scratch, dispose: () => rm(scratch, { recursive: true, force: true }) };
  } catch (error) {
    if (scratchDir) await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    if (!runtime) ready = undefined;
    return { ok: false, reason: `sandbox-runtime could not start: ${(error as Error).message}` };
  }
}
