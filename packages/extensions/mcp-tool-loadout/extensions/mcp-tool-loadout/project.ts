// Resolve a stable per-repo key so all worktrees/clones of the same repo share usage
// stats (instead of fragmenting by cwd). Falls back to the cwd basename when not a git repo.
import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

/** Repo name (last path segment, sans .git) parsed from a git remote URL. */
export function repoNameFromOriginUrl(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/i, "").replace(/[/]+$/, "");
  if (!trimmed) return undefined;
  // scp-like "git@host:owner/repo" → take after the last ":"; URLs keep their path.
  const path = trimmed.includes("://") ? trimmed : trimmed.slice(trimmed.lastIndexOf(":") + 1);
  const seg = path.split("/").filter(Boolean).pop();
  return seg && seg.length > 0 ? seg : undefined;
}

/** Repo dir name from an absolute git common dir ("…/<repo>/.git" → "<repo>"). */
export function repoNameFromCommonDir(commonDirAbs: string): string | undefined {
  const norm = commonDirAbs.replace(/[/]+$/, "");
  if (!norm) return undefined;
  const repoDir = basename(norm) === ".git" ? dirname(norm) : norm;
  const name = basename(repoDir);
  return name && name !== "." && name !== "/" ? name : undefined;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stable usage-stats key for the repo containing `cwd`. Prefers the origin remote's
 * repo name, then the shared git common dir's repo folder (unifies worktrees), then
 * the cwd basename. Pure parsing is split out for testing; the git calls are thin glue.
 */
export function resolveProjectKey(cwd: string): string {
  const origin = git(cwd, ["config", "--get", "remote.origin.url"]);
  if (origin) {
    const name = repoNameFromOriginUrl(origin);
    if (name) return name;
  }
  const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (commonDir) {
    const name = repoNameFromCommonDir(commonDir);
    if (name) return name;
  }
  return basename(cwd) || cwd;
}
