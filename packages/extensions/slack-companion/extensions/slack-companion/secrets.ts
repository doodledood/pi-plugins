// What the Slack helper may never read, and what may never leave in a reply.
// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (secret reads) and
// docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md (secret-shaped replies).
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Resolve a tool's path argument exactly as Pi's file tools do (unicode spaces, a leading `@`,
 * `~`, `file://` URLs), so a guard checks the file the tool will open. Pi does not export its
 * resolver; path-parity.test.ts compares this copy with Pi's own on every rule.
 */
export function resolveToolPath(input: string, cwd: string, home = homedir()): string {
  let normalized = input.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = home;
  else if (normalized.startsWith("~/")) normalized = join(home, normalized.slice(2));
  else if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * Folders whose contents are credentials, or may hold them. Agent harnesses keep API keys, MCP
 * server environments and tokens in their config folders (Pi's models.json, ~/.claude's settings,
 * Codex's config.toml), so those folders are closed whole, even inside a folder the owner opens.
 */
export function secretDirectories(home = homedir(), agentDir = join(home, ".pi", "agent")): string[] {
  return [
    agentDir,
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".cursor"),
    join(home, ".gemini"),
    join(home, ".windsurf"),
    join(home, ".config", "opencode"),
    join(home, ".config", "mcp"),
    join(home, "Library", "Application Support", "Claude"),
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".azure"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".mcp-auth"),
    join(home, ".config", "telegram-notify"),
    join(home, ".config", "gh"),
    join(home, ".password-store"),
    join(home, ".local", "share", "keyrings"),
  ];
}

/**
 * Names of files that hold credentials wherever they sit, as globs (`*` is any run of characters).
 * The one list both guards use: the file tools match names against it anywhere, and the shell
 * sandbox (macOS) denies the names from the filesystem root.
 */
export const SECRET_FILE_GLOBS: readonly string[] = [
  // Each with its variants and backups (auth.json.bak, .env.local, mcp.json.old, credentials.json~).
  ".env*",
  "auth.json*",
  ".netrc*",
  ".npmrc*",
  ".pgpass*",
  "credentials",
  "credentials.json*",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "mcp.json*",
  ".mcp.json*",
  "mcp-adapter.json*",
  "mcp-auth.json*",
  ".credentials.json*",
  // MCP configs that pi-mcp-adapter imports servers from; they carry servers' keys and headers.
  ".claude.json*",
  "claude_desktop_config.json*",
  "opencode.json*",
  ".git-credentials*",
  ".*_history",
];

// Matched without regard to case: macOS opens `.ENV` as `.env`.
const SECRET_FILE_NAMES = SECRET_FILE_GLOBS.map((glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"));

/**
 * The one spelling of a path the filesystem gives back: symlinks resolved and, on macOS, the case
 * as stored. A path that does not exist is spelled from its nearest existing folder.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** Is any part of this path named like a secret (a folder named `credentials` closes what is in it)? */
function namedLikeSecret(path: string): boolean {
  return path.split(sep).some((part) => part !== "" && SECRET_FILE_NAMES.some((re) => re.test(part)));
}

/**
 * What the helper's file tools may read: an allowlist, so another spelling of a path (other case,
 * the data-volume path, /dev/fd) is closed rather than missed. A path is readable only when its
 * canonical spelling is inside a root, or is one of the exact files, and nothing in it is named
 * like a secret. See docs/adr/20261104-close-the-home-folder-to-the-slack-helper.md.
 */
export interface ReadPolicy {
  home: string;
  /** Folders the file tools may read: the project and the owner's readable folders (see readableRoots). */
  roots: string[];
  /** Exact files besides: the offered skills' files, and files the helper's own MCP calls returned. */
  files: Set<string>;
  /** Secret folders, canonical: closed even inside a root (opening ~/.config does not open ~/.config/gcloud). */
  closed: string[];
}

/**
 * The folders that may be opened, canonical: never the home or a folder holding it, and never a
 * secret folder or a folder inside one (an allow there would win over the shell's deny).
 */
export function readableRoots(home: string, folders: readonly string[], agentDir = join(home, ".pi", "agent")): string[] {
  const closed = [home, ...secretDirectories(home, agentDir)].map(canonicalPath);
  const canonicalHome = canonicalPath(home);
  return [...new Set(folders.map((f) => canonicalPath(resolve(f))))].filter(
    (f) => !inside(canonicalHome, f) && !closed.slice(1).some((dir) => inside(f, dir)) && !namedLikeSecret(f),
  );
}

export function readPolicy(options: { home?: string; agentDir?: string; roots: readonly string[]; files?: readonly string[] }): ReadPolicy {
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? join(home, ".pi", "agent");
  return {
    home,
    roots: readableRoots(home, options.roots, agentDir),
    files: new Set((options.files ?? []).filter((f) => !namedLikeSecret(f)).map(canonicalPath)),
    closed: secretDirectories(home, agentDir).map(canonicalPath),
  };
}

/** May the file tools open this absolute path? */
export function isReadableAbsolute(policy: ReadPolicy, absolute: string): boolean {
  const path = canonicalPath(absolute);
  if (namedLikeSecret(path)) return false;
  if (policy.files.has(path)) return true;
  if (policy.closed.some((dir) => inside(path, dir))) return false;
  return policy.roots.some((root) => inside(path, root));
}

/** May the file tools open the file a tool would open for `path`? */
export function isReadablePath(policy: ReadPolicy, cwd: string, path: string): boolean {
  return isReadableAbsolute(policy, resolveToolPath(path, cwd, policy.home));
}

/**
 * Drop any output line that names a path the file tools may not read. Pi's grep prints a match as
 * `path:N: text` and a context line as `path-N- text`, and a path may itself contain `-N-`, so
 * every prefix that ends at either separator is a candidate; listing tools print bare paths, so
 * the whole line is a candidate too. A candidate counts only when it names something that exists:
 * other text is not a path.
 */
export function filterUnreadableLines(policy: ReadPolicy, cwd: string, root: string, output: string): string {
  const base = resolveToolPath(root, cwd, policy.home);
  const denied = (pathPart: string) => {
    const trimmed = pathPart.trim().replace(/\/$/, "");
    if (trimmed === "") return false;
    const absolute = isAbsolute(trimmed) ? trimmed : join(base, trimmed);
    return existsSync(absolute) && !isReadableAbsolute(policy, absolute);
  };
  return output
    .split("\n")
    .filter((line) => {
      const candidates = [line];
      for (const match of line.matchAll(/[:-]\d+[:-]/g)) candidates.push(line.slice(0, match.index));
      return !candidates.some(denied);
    })
    .join("\n");
}

/** Environment variables a sandboxed command never sees: anything that looks like a credential. */
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i;

export function sanitizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (!SECRET_ENV.test(name)) out[name] = value;
  return out;
}

/** Shapes of credentials that must never leave in a Slack reply. */
export const SECRET_SHAPES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "AWS access key", pattern: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { name: "GitHub token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "Slack token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/i },
  { name: "API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
];

/** The name of the first secret shape `text` contains, if any. */
export function findSecretShape(text: string): string | undefined {
  return SECRET_SHAPES.find(({ pattern }) => pattern.test(text))?.name;
}

/** Remove terminal control and escape sequences, so text shown to the owner is what it says. */
export function stripControl(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}
