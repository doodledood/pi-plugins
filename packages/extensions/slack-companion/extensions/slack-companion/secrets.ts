// What the Slack helper may never read, and what may never leave in a reply.
// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (secret reads) and
// docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md (secret-shaped replies).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
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
 * server environments and tokens in their config folders (Pi's models.json, ~/.claude.json's
 * neighbours, Codex's config.toml), so those folders are closed whole.
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
 * The one list both guards use: the file tools match names against it anywhere; the shell sandbox
 * denies the names from the filesystem root on macOS, and on Linux denies the files that
 * sandbox.findSecretFiles finds.
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

const SECRET_FILE_NAMES = SECRET_FILE_GLOBS.map((glob) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

export interface SecretPolicy {
  directories: string[];
  home: string;
}

export function defaultSecretPolicy(agentDir?: string, home = homedir()): SecretPolicy {
  // /proc holds every process's environment (Pi's own API keys among them). Only the file tools
  // deny it; the shell runs with a cleaned environment, and denying /proc there breaks commands.
  return { directories: [...secretDirectories(home, agentDir), "/proc"], home };
}

function underSecretDirectory(policy: SecretPolicy, absolute: string): boolean {
  return policy.directories.some((dir) => inside(absolute, dir) || inside(absolute, realOrSelf(dir)));
}

/** Is this file name one of SECRET_FILE_GLOBS (with its copies and backups)? */
function isSecretFileName(name: string): boolean {
  return SECRET_FILE_NAMES.some((re) => re.test(name));
}

/** Is this absolute path (symlinks resolved) a secret file, or inside a secret folder? */
export function isSecretAbsolute(policy: SecretPolicy, absolute: string): boolean {
  const real = realOrSelf(absolute);
  return [absolute, real].some((p) => isSecretFileName(basename(p)) || underSecretDirectory(policy, p));
}

/** Is the file a tool would open for `path` a secret? */
export function isSecretPath(policy: SecretPolicy, cwd: string, path: string): boolean {
  return isSecretAbsolute(policy, resolveToolPath(path, cwd, policy.home));
}

/** Would searching or listing from `path` walk into a secret folder? */
export function walksIntoSecrets(policy: SecretPolicy, cwd: string, path: string): boolean {
  const absolute = resolveToolPath(path, cwd, policy.home);
  const real = realOrSelf(absolute);
  if (isSecretAbsolute(policy, absolute)) return true;
  return policy.directories.some((dir) => [dir, realOrSelf(dir)].some((d) => inside(d, absolute) || inside(d, real)));
}

/**
 * Drop any output line that names a secret path. Pi's grep prints a match as `path:N: text` and a
 * context line as `path-N- text`, and a path may itself contain `-N-`, so every prefix that ends
 * at either separator is a candidate; one secret candidate drops the line. Listing tools print
 * bare paths, so the whole line is a candidate too.
 */
export function filterSecretLines(policy: SecretPolicy, cwd: string, root: string, output: string): string {
  const base = resolveToolPath(root, cwd, policy.home);
  const isSecret = (pathPart: string) => {
    const trimmed = pathPart.trim().replace(/\/$/, "");
    return trimmed !== "" && isSecretAbsolute(policy, isAbsolute(trimmed) ? trimmed : join(base, trimmed));
  };
  return output
    .split("\n")
    .filter((line) => {
      const candidates = [line];
      for (const match of line.matchAll(/[:-]\d+[:-]/g)) candidates.push(line.slice(0, match.index));
      return !candidates.some(isSecret);
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
