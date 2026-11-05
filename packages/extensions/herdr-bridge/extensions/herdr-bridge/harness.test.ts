import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isMain } from "./e2e/harness.ts";

test("an end-to-end run started through a symlinked folder still knows it is the script being run", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-is-main-"));
  try {
    writeFileSync(join(dir, "run.ts"), "");
    symlinkSync(dir, `${dir}-link`);
    const url = pathToFileURL(join(dir, "run.ts")).href;
    assert.equal(isMain(url, ["node", join(dir, "run.ts")]), true);
    assert.equal(isMain(url, ["node", join(`${dir}-link`, "run.ts")]), true, "the symlinked path is the same script");
    assert.equal(isMain(url, ["node", join(dir, "other.ts")]), false, "another script, or one that does not exist, is not");
    assert.equal(isMain(url, ["node"]), false, "and with no script, nothing is");
  } finally {
    rmSync(`${dir}-link`, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
