import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkLockfile, workspaceManifests } from "./check-lockfile.mjs";

/** A repository with workspaces and no dependencies, so npm writes its lockfile offline. */
function repo() {
  const root = mkdtempSync(join(tmpdir(), "lockfile-fixture-"));
  const write = (file, json) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), `${JSON.stringify(json, null, 2)}\n`);
  };
  write("package.json", { name: "fixture", version: "1.0.0", private: true, workspaces: ["packages/extensions/*", "packages/themes/*"] });
  write("packages/extensions/one/package.json", { name: "one", version: "0.1.0" });
  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], { cwd: root, stdio: "pipe" });
  return { root, write, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a lockfile npm wrote for the tree's manifests passes, and the check edits nothing", () => {
  const { root, done } = repo();
  try {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith("check-lockfile-")).length;
    assert.deepEqual(checkLockfile(root), { ok: true, detail: "package-lock.json matches the manifests" });
    assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith("check-lockfile-")).length, before, "its temporary copy is removed");
    assert.deepEqual(workspaceManifests(root), ["packages/extensions/one/package.json"], "a workspace folder that does not exist is skipped");
  } finally {
    done();
  }
});

test("a version bump without regenerating the lockfile fails and names the command that fixes it", () => {
  const { root, write, done } = repo();
  try {
    write("packages/extensions/one/package.json", { name: "one", version: "0.1.1" });
    const result = checkLockfile(root);
    assert.equal(result.ok, false);
    assert.match(result.detail, /stale from line \d+.*npm install --package-lock-only --ignore-scripts/);
  } finally {
    done();
  }
});

test("a new workspace on disk counts whether or not git has it, so a stale lockfile cannot pass before staging", () => {
  const { root, write, done } = repo();
  try {
    write("packages/themes/two/package.json", { name: "two", version: "0.1.0" });
    assert.equal(checkLockfile(root).ok, false, "the new workspace is missing from the lockfile");
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], { cwd: root, stdio: "pipe" });
    assert.equal(checkLockfile(root).ok, true, "and passes once the lockfile is regenerated");
  } finally {
    done();
  }
});

test("offline, a manifest naming a package the lockfile lacks is reported as a stale lockfile", () => {
  const { root, write, done } = repo();
  const cache = mkdtempSync(join(tmpdir(), "lockfile-empty-cache-"));
  const before = process.env.npm_config_cache;
  try {
    write("packages/extensions/one/package.json", { name: "one", version: "0.1.0", dependencies: { "a-package-no-cache-holds": "1.0.0" } });
    process.env.npm_config_cache = cache;
    const result = checkLockfile(root);
    assert.equal(result.ok, false);
    assert.match(result.detail, /names a package package-lock.json lacks; run `npm install --package-lock-only --ignore-scripts`/);
  } finally {
    if (before === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = before;
    rmSync(cache, { recursive: true, force: true });
    done();
  }
});

test("a removed workspace fails until the lockfile is regenerated, and a missing npm is reported as unreachable", () => {
  const { root, done } = repo();
  try {
    rmSync(join(root, "packages/extensions/one"), { recursive: true });
    assert.equal(existsSync(join(root, "packages/extensions/one")), false);
    assert.equal(checkLockfile(root).ok, false);
    assert.deepEqual(checkLockfile(root, { npm: "npm-that-does-not-exist" }), { ok: false, unreachable: true, detail: "npm-that-does-not-exist is not installed" });
  } finally {
    done();
  }
});
