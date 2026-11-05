import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { isMain } from "./is-main.mjs";

test("a script run through a symlinked folder still knows it is the one node runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "is-main-"));
  try {
    const helper = pathToFileURL(join(import.meta.dirname, "is-main.mjs")).href;
    writeFileSync(join(dir, "script.mjs"), `import { isMain } from ${JSON.stringify(helper)};\nconsole.log(isMain(import.meta.url) ? "main" : "imported");\n`);
    symlinkSync(dir, `${dir}-link`);
    assert.equal(execFileSync("node", [join(dir, "script.mjs")], { encoding: "utf8" }).trim(), "main");
    assert.equal(execFileSync("node", [join(`${dir}-link`, "script.mjs")], { encoding: "utf8" }).trim(), "main");
  } finally {
    rmSync(`${dir}-link`, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an imported module, or no script at all, is not main", () => {
  assert.equal(isMain(import.meta.url, ["node", join(import.meta.dirname, "check-lockfile.mjs")]), false);
  assert.equal(isMain(import.meta.url, ["node"]), false);
  assert.equal(isMain(import.meta.url, ["node", "/a/path/that/does/not/exist.mjs"]), false);
});
