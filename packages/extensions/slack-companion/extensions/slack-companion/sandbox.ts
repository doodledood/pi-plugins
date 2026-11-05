// The Slack helper's shell: every command runs under @anthropic-ai/sandbox-runtime, writing
// only to a scratch folder, reading no secrets, seeing no credential-like environment variable,
// and reaching no network unless the owner listed a domain. If the sandbox cannot start, the
// helper gets no shell at all. Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md.
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { isSecretFileName, sanitizeEnv, SECRET_FILE_GLOBS, secretDirectories } from "./secrets.ts";

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
  /** Linux: the secret-named files found by findSecretFiles, as literal paths (see denyReadEntries). */
  linuxSecretFiles?: readonly string[];
  /** For tests: the clock the Linux walk's deadline is measured on. */
  now?: () => number;
}

/** Folders not walked for secret names: version control, installed packages, caches and toolchains. */
const UNWALKED = new Set([".git", "node_modules", ".cache", ".npm", ".nvm", ".cargo", ".rustup", ".pyenv", ".gradle", ".m2", ".vscode-server", ".local/share/Trash"]);
/** How deep the Linux walk goes in the home folder outside the project and the agent folder. */
export const HOME_WALK_DEPTH = 4;
/** How long the Linux walk may take per helper run, and how many files it may name, before the shell is refused. */
export const SECRET_WALK_MS = 3000;
export const MAX_SECRET_FILES = 2000;

/**
 * Secret-named files under `roots` (each to its depth, unlimited when none), found by a
 * breadth-first walk that stops at `deadline`. Incomplete when it ran out of time: the caller then
 * refuses the shell rather than miss one.
 */
export function findSecretFiles(roots: ReadonlyArray<{ dir: string; depth?: number }>, deadline: number, now: () => number = Date.now): { files: string[]; complete: boolean } {
  const files = new Set<string>();
  // Unlimited roots first, so a folder inside both is walked to its full depth.
  const queue = [...roots].sort((a, b) => (a.depth ?? Infinity) - (b.depth ?? Infinity)).reverse().map((r) => ({ dir: r.dir, left: r.depth ?? Infinity, base: r.dir }));
  const visited = new Set<string>();
  while (queue.length) {
    if (now() > deadline) return { files: [...files], complete: false };
    const { dir, left, base } = queue.shift()!;
    if (visited.has(dir)) continue;
    visited.add(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable to Pi is unreadable to the shell too
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (isSecretFileName(entry.name)) files.add(path);
      const fromBase = path.slice(base.length + 1);
      if (left > 1 && entry.isDirectory() && !entry.isSymbolicLink() && !UNWALKED.has(entry.name) && !UNWALKED.has(fromBase)) queue.push({ dir: path, left: left - 1, base });
    }
  }
  return { files: [...files], complete: true };
}

/**
 * The read denials. macOS (Seatbelt) matches a root-anchored, any-depth name pattern, so secret
 * names are denied at any depth from the filesystem root. Linux (bubblewrap) would expand each
 * pattern by walking the disk again for every command, so there the package passes literal paths
 * instead (marked literal, so a name holding "[" or "*" is never read as a pattern): the secret
 * folders, the agent folder's files, and the secret-named files that findSecretFiles found once
 * per helper run in the project and the agent folder (whole) and the home folder (to
 * HOME_WALK_DEPTH).
 */
export function denyReadEntries(options: SandboxOptions): Array<string | { path: string; literal: true }> {
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? join(home, ".pi", "agent");
  const named = [
    ...secretDirectories(home, agentDir),
    ...["auth.json", "mcp.json", "mcp-adapter.json", "mcp-auth.json"].map((name) => join(agentDir, name)),
  ];
  if ((options.platform ?? process.platform) === "linux") return [...named, ...(options.linuxSecretFiles ?? [])].map((path) => ({ path, literal: true as const }));
  const roots = [...new Set(["", home, options.cwd, agentDir])];
  return [...named, ...roots.flatMap((root) => SECRET_FILE_GLOBS.map((name) => `${root}/**/${name}`))];
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
    let linuxSecretFiles: string[] | undefined;
    if ((options.platform ?? process.platform) === "linux") {
      const home = options.home ?? homedir();
      const agentDir = options.agentDir ?? join(home, ".pi", "agent");
      const now = options.now ?? Date.now;
      const walk = findSecretFiles([{ dir: options.cwd }, { dir: agentDir }, { dir: home, depth: HOME_WALK_DEPTH }], now() + SECRET_WALK_MS, now);
      if (!walk.complete) return { ok: false, reason: "the folders to check for secret files are too large to check quickly, so the helper has no shell" };
      linuxSecretFiles = walk.files;
      if (linuxSecretFiles.length > MAX_SECRET_FILES) return { ok: false, reason: `the project holds more than ${MAX_SECRET_FILES} secret-named files, so the helper has no shell` };
    }
    scratchDir = realpathSync(await mkdtemp(join(tmpdir(), "pi-slack-helper-")));
    const config: SandboxRuntimeConfig = {
      network: { allowedDomains: [...options.allowedDomains], deniedDomains: [] },
      filesystem: { denyRead: denyReadEntries({ ...options, ...(linuxSecretFiles ? { linuxSecretFiles } : {}) }), allowWrite: [scratchDir], denyWrite: [] },
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
