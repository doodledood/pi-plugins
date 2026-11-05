#!/usr/bin/env node
// Checks that package-lock.json is what npm writes for the manifests in the working tree: the root
// package.json and the package.json of every workspace that exists on disk, staged or not. npm
// rebuilds the lockfile offline in a temporary copy, so the tree is never edited.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.mjs";

const REGENERATE = "npm install --package-lock-only --ignore-scripts";

/** Exit code for a missing prerequisite, as scripts/verify reads it. */
export const EXIT_UNREACHABLE = 3;

/**
 * The package.json of each workspace the root names, relative to `root`. A pattern is a folder or
 * a folder ending in `/*`, which is all this repository's workspaces use. A `!` exclusion is
 * skipped here, as npm applies it in the copy; any other glob throws.
 */
export function workspaceManifests(root) {
  const { workspaces = [] } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const folders = workspaces.flatMap((pattern) => {
    if (pattern.startsWith("!")) return [];
    if (/[*?[\]{}]/.test(pattern.replace(/\/\*$/, ""))) throw new Error(`unsupported workspace pattern: ${pattern}`);
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    if (!existsSync(join(root, parent))) return [];
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });
  return folders.map((folder) => `${folder}/package.json`).filter((file) => existsSync(join(root, file)));
}

/** Compares the lockfile with one npm writes for the tree's manifests, in a copy under `tmp`. */
export function checkLockfile(root, { npm = "npm", tmp = tmpdir() } = {}) {
  const copy = mkdtempSync(join(tmp, "check-lockfile-"));
  try {
    for (const file of ["package.json", "package-lock.json", ...workspaceManifests(root)]) {
      mkdirSync(dirname(join(copy, file)), { recursive: true });
      cpSync(join(root, file), join(copy, file));
    }
    try {
      // --loglevel=error beats an npm_config_loglevel=silent that `npm run -s` passes down, which
      // would leave no error to read.
      execFileSync(npm, ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: copy, stdio: "pipe" });
    } catch (error) {
      if (error.code === "ENOENT") return { ok: false, unreachable: true, detail: `${npm} is not installed` };
      const output = `${error.stderr ?? ""}`;
      // Offline, npm fails when a manifest asks for a package or version the lockfile lacks: the
      // lockfile is stale.
      if (/ENOTCACHED/.test(output)) return { ok: false, detail: `a manifest asks for a package or version package-lock.json lacks; run \`${REGENERATE}\`` };
      return { ok: false, detail: `npm could not rebuild the lockfile:\n${output.trim()}` };
    }
    const committed = readFileSync(join(root, "package-lock.json"), "utf8").split("\n");
    const rebuilt = readFileSync(join(copy, "package-lock.json"), "utf8").split("\n");
    const line = committed.findIndex((text, i) => text !== rebuilt[i]);
    if (line === -1 && committed.length === rebuilt.length) return { ok: true, detail: "package-lock.json matches the manifests" };
    const at = line === -1 ? Math.min(committed.length, rebuilt.length) : line;
    return { ok: false, detail: `package-lock.json is stale from line ${at + 1} (npm writes ${JSON.stringify(rebuilt[at] ?? "")}); run \`${REGENERATE}\`` };
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** Runs the check, prints its result and returns the exit code scripts/verify reads. */
export function run(root, options) {
  const result = checkLockfile(root, options);
  (result.ok ? console.log : console.error)(result.detail);
  return result.ok ? 0 : result.unreachable ? EXIT_UNREACHABLE : 1;
}

if (isMain(import.meta.url)) process.exitCode = run(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
