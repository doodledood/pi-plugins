import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

test("every verification recipe parses and names only paths that exist", () => {
  const run = spawnSync(join(root, "scripts", "verify"), ["check"], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, `scripts/verify check failed:\n${run.stdout}${run.stderr}`);
});
