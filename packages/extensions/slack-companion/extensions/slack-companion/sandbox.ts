// The Slack helper's shell: every command runs under @anthropic-ai/sandbox-runtime, writing
// only to a scratch folder, reading no secrets, seeing no credential-like environment variable,
// and reaching no network unless the owner listed a domain. If the sandbox cannot start, the
// helper gets no shell at all; on Linux it gets none yet. Holds
// docs/adr/20261104-sandbox-the-slack-helpers-shell.md.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { canonicalPath, openedFolders, sanitizeEnv, SECRET_FILE_GLOBS, secretDirectories } from "./secrets.ts";

export type ShellSandbox =
  | { ok: true; operations: BashOperations; scratchDir: string; dispose(): Promise<void> }
  | { ok: false; reason: string };

export interface SandboxOptions {
  cwd: string;
  allowedDomains: readonly string[];
  agentDir?: string;
  home?: string;
  /** Folders in the home the shell may read besides the project (the owner's readableFolders). */
  readable?: readonly string[];
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
 * Where tools a shell command runs keep themselves in the home folder: version managers, user
 * binaries and git's settings. The home is closed to the shell; these are opened back.
 */
export const HOME_TOOLCHAINS: readonly string[] = [
  ".gitconfig", ".config/git", ".nvm", ".volta", ".fnm", ".bun", ".deno", ".cargo/bin", ".rustup",
  ".local/bin", ".pyenv", ".rbenv", ".asdf", ".local/share/mise", ".sdkman", "go/bin",
];

/**
 * What the shell may read inside the closed folders: the opened folders (the project, the owner's
 * readable folders and the repository's own, see secrets.openedFolders), Pi's `bin` (first on the
 * shell's PATH; its `fd` and `rg` live there), the toolchains, and Apple's developer-tools cache in
 * the temp folder. Secret folders and names inside them stay denied: Seatbelt keeps a deny that is
 * more specific than the allow around it.
 */
export function allowReadEntries(options: SandboxOptions): string[] {
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? join(home, ".pi", "agent");
  // Apple's developer tools keep a cache in the system's temp folder (whatever TMPDIR says); git
  // prints errors without it.
  const system = darwinUserFolders()?.temp;
  const xcrunCaches = [...new Set([canonicalPath(tmpdir()), ...(system ? [system] : [])])].map((temp) => join(temp, "xcrun_db"));
  return [...openedFolders({ home, agentDir, cwd: options.cwd, readable: options.readable ?? [] }), join(agentDir, "bin"), ...HOME_TOOLCHAINS.map((p) => join(home, p)), ...xcrunCaches];
}

/**
 * The read denials, for Seatbelt (macOS), which matches a root-anchored, any-depth name pattern:
 * the home and the temp folder (opened back only where allowReadEntries says), the secret folders
 * (Pi's agent folder among them) and every secret file name at any depth.
 */
export function denyReadEntries(options: SandboxOptions): string[] {
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? join(home, ".pi", "agent");
  const roots = [...new Set(["", home, options.cwd, agentDir])];
  // The temp folders hold Pi's full tool output, pi-mcp-adapter's saved results, and other tools' scratch files.
  return [home, ...userTempFolders(), ...SHARED_TEMP, ...secretDirectories(home, agentDir), ...roots.flatMap((root) => SECRET_FILE_GLOBS.map((name) => `${root}/**/${name}`))];
}

/** The system's shared folders where data of other users and tools sits, closed to the shell as the user's own temp folder is. */
const SHARED_TEMP = ["/private/tmp", "/private/var/tmp", "/Users/Shared"];

const PER_USER_FOLDER = /^\/private\/var\/folders\/[^/]+\/[^/]+$/;

/**
 * The user's own temp folder, and on macOS the per-user folder that holds the system's temp folder
 * and caches (/private/var/folders/<x>/<y>, whose T is the temp folder and C the caches), named by
 * the system so a TMPDIR set elsewhere does not leave it open. A temp folder of any other shape is
 * closed by itself, so a TMPDIR such as /tmp never closes a parent like /.
 */
function userTempFolders(): string[] {
  const temp = canonicalPath(tmpdir());
  const folders = [PER_USER_FOLDER.test(dirname(temp)) && /\/T$/.test(temp) ? dirname(temp) : temp];
  const system = darwinUserFolders();
  if (system) folders.push(system.perUser);
  return [...new Set(folders)];
}

let userFolders: { perUser: string; temp: string } | { failed: Error; at: number } | undefined;

/** How long a failed answer is kept before the system is asked again. */
const USER_FOLDERS_RETRY_MS = 10 * 60 * 1000;

/**
 * The per-user folder and its temp folder as macOS names them, whatever TMPDIR says (asked once:
 * the answer does not change while the process runs); undefined on other platforms. A system that
 * does not answer, or answers in another shape, throws: the shell then does not start, rather than
 * start with that folder open. A failure is kept for USER_FOLDERS_RETRY_MS, so each helper start
 * does not wait on it again.
 */
function darwinUserFolders(): { perUser: string; temp: string } | undefined {
  if (process.platform !== "darwin") return undefined;
  if (userFolders && "failed" in userFolders && Date.now() - userFolders.at > USER_FOLDERS_RETRY_MS) userFolders = undefined;
  if (!userFolders) {
    try {
      const ask = (name: string) => {
        try {
          return canonicalPath(execFileSync("/usr/bin/getconf", [name], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }).trim());
        } catch (error) {
          const said = String((error as { stderr?: unknown }).stderr ?? "").trim().split("\n")[0];
          const code = (error as NodeJS.ErrnoException).code;
          throw new Error(said || (code === "ETIMEDOUT" ? `getconf ${name} did not answer in 2 s` : code === "ENOENT" ? "getconf is missing" : `getconf ${name} failed`));
        }
      };
      const userDir = ask("DARWIN_USER_DIR");
      if (!PER_USER_FOLDER.test(dirname(userDir))) throw new Error(`it named ${userDir}`);
      userFolders = { perUser: dirname(userDir), temp: ask("DARWIN_USER_TEMP_DIR") };
    } catch (error) {
      userFolders = { failed: new Error(`macOS gave no usable per-user temp folder (${(error as Error).message}); macOS is asked again in 10 minutes`), at: Date.now() };
    }
  }
  if ("failed" in userFolders) throw userFolders.failed;
  return userFolders;
}

/** sandbox-runtime lets every command write here and points TMPDIR here; the helper writes only to its scratch folder. */
const RUNTIME_WRITABLE = ["/tmp/claude", "/private/tmp/claude"];

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
    try {
      darwinUserFolders();
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
    scratchDir = realpathSync(await mkdtemp(join(tmpdir(), "pi-slack-helper-")));
    const config: SandboxRuntimeConfig = {
      network: { allowedDomains: [...options.allowedDomains], deniedDomains: [] },
      filesystem: { denyRead: denyReadEntries(options), allowRead: [...allowReadEntries(options), scratchDir], allowWrite: [scratchDir], denyWrite: RUNTIME_WRITABLE },
    };
    const policy = JSON.stringify({ network: config.network, denyRead: config.filesystem.denyRead, allowRead: config.filesystem.allowRead });
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
        // SCRATCH names the one folder a command may write; TMPDIR is set to it inside the sandbox,
        // over the one sandbox-runtime sets, so temp files land where a write is allowed.
        const wrapped = await manager.wrapWithSandbox(`export TMPDIR="$SCRATCH"; ${command}`, undefined, config, execOptions.signal);
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
