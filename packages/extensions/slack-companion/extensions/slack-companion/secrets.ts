// What the Slack helper may never read, and what may never leave in a reply.
// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (secret reads) and
// docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md (secret-shaped replies).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

/** Folders whose contents are credentials. */
export function secretDirectories(home = homedir(), agentDir = join(home, ".pi", "agent")): string[] {
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "gcloud"),
    join(home, ".azure"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".mcp-auth"),
    join(agentDir, "mcp-oauth"),
    join(agentDir, "mcp-oauth-encrypted"),
  ];
}

/** Files that hold credentials wherever they sit. */
const SECRET_FILE_NAMES = [/^\.env(\..*)?$/, /^auth\.json$/, /^\.netrc$/, /^\.npmrc$/, /^\.pgpass$/, /^credentials(\.json)?$/, /^id_[a-z0-9]+$/];

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
}

export function defaultSecretPolicy(): SecretPolicy {
  return { directories: secretDirectories().map(realOrSelf) };
}

/** Is `path` (relative to cwd, symlinks resolved) a secret file, inside a secret folder, or above one? */
export function isSecretPath(policy: SecretPolicy, cwd: string, path: string): boolean {
  const absolute = realOrSelf(isAbsolute(path) ? path : resolve(cwd, path));
  if (SECRET_FILE_NAMES.some((re) => re.test(basename(absolute)))) return true;
  return policy.directories.some((dir) => inside(absolute, dir) || inside(absolute, realOrSelf(dir)));
}

/** Searching or listing from here would walk into a secret folder. */
export function walksIntoSecrets(policy: SecretPolicy, cwd: string, path: string): boolean {
  const absolute = realOrSelf(isAbsolute(path) ? path : resolve(cwd, path));
  return isSecretPath(policy, cwd, path) || policy.directories.some((dir) => inside(dir, absolute) || inside(realOrSelf(dir), absolute));
}

/** Drop any output line that names a secret path. */
export function filterSecretLines(policy: SecretPolicy, cwd: string, root: string, output: string): string {
  return output
    .split("\n")
    .filter((line) => {
      const pathPart = line.split(/:(?=\d+[:-])/)[0]!.trim();
      if (!pathPart) return true;
      const candidate = isAbsolute(pathPart) ? pathPart : join(resolve(cwd, root), pathPart);
      return !isSecretPath(policy, cwd, candidate);
    })
    .join("\n");
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
