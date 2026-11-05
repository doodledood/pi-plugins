import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checkLockfile, EXIT_UNREACHABLE, run, workspaceManifests } from "./check-lockfile.mjs";

const NPM_OFFLINE = ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"];
const REGENERATE = /run `npm install --package-lock-only --ignore-scripts`/;
const scratch = mkdtempSync(join(tmpdir(), "lockfile-tests-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeJson(root, file, json) {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), `${JSON.stringify(json, null, 2)}\n`);
}

/** A repository with two workspace folders and no dependencies, its lockfile written once by npm. */
const template = join(scratch, "template");
writeJson(template, "package.json", { name: "fixture", version: "1.0.0", private: true, workspaces: ["packages/extensions/*", "packages/themes/*", "!packages/themes/skipped"] });
writeJson(template, "packages/extensions/one/package.json", { name: "one", version: "0.1.0" });
execFileSync("npm", NPM_OFFLINE, { cwd: template, stdio: "pipe" });

let fixtures = 0;
/** A fresh copy of the fixture, and an empty folder the check must leave empty again. */
function repo() {
  const root = join(scratch, `repo-${++fixtures}`);
  const tmp = join(scratch, `tmp-${fixtures}`);
  cpSync(template, root, { recursive: true });
  mkdirSync(tmp);
  const check = (options = {}) => {
    const result = checkLockfile(root, { tmp, ...options });
    assert.deepEqual(readdirSync(tmp), [], "the check removes its temporary copy");
    return result;
  };
  return { root, check, write: (file, json) => writeJson(root, file, json) };
}

test("a lockfile npm wrote for the tree's manifests passes, and the check edits nothing", () => {
  const { root, check } = repo();
  assert.deepEqual(check(), { ok: true, detail: "package-lock.json matches the manifests" });
  assert.deepEqual(workspaceManifests(root), ["packages/extensions/one/package.json"], "a folder that does not exist and an exclusion are skipped");
});

test("a version bump without regenerating the lockfile fails and names the command that fixes it", () => {
  const { check, write } = repo();
  write("packages/extensions/one/package.json", { name: "one", version: "0.1.1" });
  const result = check();
  assert.equal(result.ok, false);
  assert.match(result.detail, /stale from line \d+/);
  assert.match(result.detail, REGENERATE);
});

test("a new workspace on disk counts whether or not git has it, so a stale lockfile cannot pass before staging", () => {
  const { root, check, write } = repo();
  write("packages/themes/two/package.json", { name: "two", version: "0.1.0" });
  assert.match(check().detail, /stale from line \d+/, "the new workspace is missing from the lockfile");
  execFileSync("npm", NPM_OFFLINE, { cwd: root, stdio: "pipe" });
  assert.equal(check().ok, true, "and passes once the lockfile is regenerated");
});

test("a removed workspace fails as stale until the lockfile is regenerated", () => {
  const { root, check } = repo();
  rmSync(join(root, "packages/extensions/one"), { recursive: true });
  const result = check();
  assert.match(result.detail, /stale from line \d+/);
  assert.match(result.detail, REGENERATE);
  execFileSync("npm", NPM_OFFLINE, { cwd: root, stdio: "pipe" });
  assert.equal(check().ok, true);
});

for (const [name, locked] of [
  ["a package the lockfile lacks", false],
  ["a version the locked one does not meet", true],
]) {
  test(`offline, a manifest asking for ${name} is reported as a stale lockfile`, () => {
    const { root, check, write } = repo();
    const before = { cache: process.env.npm_config_cache, loglevel: process.env.npm_config_loglevel };
    try {
      process.env.npm_config_cache = join(scratch, `cache-${fixtures}`);
      process.env.npm_config_loglevel = "silent"; // as `npm run -s` passes it down
      if (locked) {
        // The lockfile holds 1.0.0, as it would after an install; the manifest then asks for ^2.
        const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
        lock.packages["packages/extensions/one"].dependencies = { "a-package-no-cache-holds": "1.0.0" };
        lock.packages["node_modules/a-package-no-cache-holds"] = { version: "1.0.0" };
        writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
      }
      write("packages/extensions/one/package.json", { name: "one", version: "0.1.0", dependencies: { "a-package-no-cache-holds": locked ? "^2.0.0" : "1.0.0" } });
      const result = check();
      assert.equal(result.ok, false);
      assert.match(result.detail, /asks for a package or version package-lock.json lacks/);
      assert.match(result.detail, REGENERATE);
    } finally {
      for (const [key, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[`npm_config_${key}`];
        else process.env[`npm_config_${key}`] = value;
      }
    }
  });
}

test("a manifest npm cannot read fails with npm's own words", () => {
  const { root, check } = repo();
  writeFileSync(join(root, "packages/extensions/one/package.json"), "{ not json");
  assert.match(check().detail, /^npm could not rebuild the lockfile/);
});

test("a missing npm is reported as unreachable, and the script exits 3 for it, 1 for stale, 0 for a match", () => {
  const { root, write } = repo();
  const tmp = join(scratch, `tmp-${fixtures}`);
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  try {
    assert.equal(run(root, { tmp }), 0);
    assert.deepEqual(checkLockfile(root, { tmp, npm: "npm-that-does-not-exist" }), { ok: false, unreachable: true, detail: "npm-that-does-not-exist is not installed" });
    assert.equal(run(root, { tmp, npm: "npm-that-does-not-exist" }), EXIT_UNREACHABLE);
    write("packages/extensions/one/package.json", { name: "one", version: "0.2.0" });
    assert.equal(run(root, { tmp }), 1);
  } finally {
    Object.assign(console, quiet);
  }
  assert.deepEqual(readdirSync(tmp), []);
});

test("workspace patterns: a plain folder is taken as named, and a glob other than a trailing /* throws", () => {
  const { root, write } = repo();
  write("package.json", { name: "fixture", version: "1.0.0", private: true, workspaces: ["packages/extensions/one"] });
  assert.deepEqual(workspaceManifests(root), ["packages/extensions/one/package.json"]);
  write("package.json", { name: "fixture", version: "1.0.0", private: true, workspaces: ["packages/{a,b}"] });
  assert.throws(() => workspaceManifests(root), /unsupported workspace pattern: packages\/\{a,b\}/);
});
