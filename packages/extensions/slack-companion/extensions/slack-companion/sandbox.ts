// The Slack helper's shell: every command runs under @anthropic-ai/sandbox-runtime, writing
// only to a scratch folder, reading no secrets, seeing no credential-like environment variable,
// and reaching no network unless the owner listed a domain. If the sandbox cannot start, the
// helper gets no shell at all; on Linux it gets none yet. Holds
// docs/adr/20261104-sandbox-the-slack-helpers-shell.md.
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
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
  /** For tests: the platform (default: this machine's). */
  platform?: NodeJS.Platform;
}

/**
 * Why the helper has no shell on Linux. There bubblewrap denies only paths, so sandbox-runtime
 * would walk the disk under every secret-name pattern before each command; no bounded way to deny
 * every secret file there has been shown to work. See
 * docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md.
 */
export const NO_SHELL_ON_LINUX = "on Linux the helper has no shell yet: its sandbox cannot deny every secret file there without searching the disk before each command";

/**
 * The read denials, for Seatbelt (macOS), which matches a root-anchored, any-depth name pattern:
 * the secret folders, the agent folder's files, and every secret file name at any depth.
 */
export function denyReadEntries(options: SandboxOptions): string[] {
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? join(home, ".pi", "agent");
  const roots = [...new Set(["", home, options.cwd, agentDir])];
  return [...secretDirectories(home, agentDir), ...roots.flatMap((root) => SECRET_FILE_GLOBS.map((name) => `${root}/**/${name}`))];
}

/** The part of sandbox-runtime's SandboxManager the package uses; tests pass a recording one. */
export interface SandboxRuntime {
  isSupportedPlatform(): boolean;
  initialize(config: SandboxRuntimeConfig): Promise<void>;
  updateConfig(config: SandboxRuntimeConfig): void;
  wrapWithSandbox(command: string, binShell?: string, customConfig?: Partial<SandboxRuntimeConfig>, abortSignal?: AbortSignal): Promise<string>;
}

async function loadRuntime(): Promise<SandboxRuntime> {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  return SandboxManager satisfies SandboxRuntime;
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
    if ((options.platform ?? process.platform) === "linux") return { ok: false, reason: NO_SHELL_ON_LINUX };
    scratchDir = realpathSync(await mkdtemp(join(tmpdir(), "pi-slack-helper-")));
    const config: SandboxRuntimeConfig = {
      network: { allowedDomains: [...options.allowedDomains], deniedDomains: [] },
      filesystem: { denyRead: denyReadEntries(options), allowWrite: [scratchDir], denyWrite: [] },
    };
    const policy = JSON.stringify({ network: config.network, denyRead: config.filesystem.denyRead });
    if (!ready || ready.runtime !== manager) {
      await manager.initialize(config);
      // initialize returns early when an earlier load of this package (before a /reload) already
      // initialized the process-wide runtime; updateConfig makes this policy the one in force.
      manager.updateConfig(config);
      ready = { runtime: manager, policy };
    } else if (ready.policy !== policy) {
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
