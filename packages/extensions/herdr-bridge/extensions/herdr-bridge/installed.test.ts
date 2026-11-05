import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHECKED, LEFT_OUT, UNDER_TEST, classifyInstalled, packageNameOf } from "./e2e/harness.ts";

test("checks load only installed packages read and checked; credential-reaching ones stay out", () => {
  const { load, leftOut } = classifyInstalled(["npm:pi-mcp-adapter", "npm:pi-web-access", "npm:@juicesharp/rpiv-todo", "git:github.com/doodledood/pi-plugins"], ["herdr-agent-state.ts"]);
  assert.deepEqual(leftOut, ["npm:pi-mcp-adapter", "npm:pi-web-access"]);
  assert.deepEqual(load, ["npm:@juicesharp/rpiv-todo", "git:github.com/doodledood/pi-plugins"]);
  assert.ok(LEFT_OUT.includes("pi-mcp-adapter") && !CHECKED.includes("pi-mcp-adapter"));
});

test("a package or local extension nobody classified fails the run instead of being loaded", () => {
  assert.throws(() => classifyInstalled(["npm:some-new-package"], []), /some-new-package not classified/);
  assert.throws(() => classifyInstalled([], ["my-local.ts"]), /local extension my-local\.ts not classified/);
});

test("an installed copy of this package is told apart by its package name, so the copy under test replaces it", () => {
  assert.equal(UNDER_TEST, "@doodledood/pi-herdr-bridge");
  const root = mkdtempSync(join(tmpdir(), "herdr-installed-"));
  try {
    const write = (file: string, text: string) => {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), text);
    };
    write("bundle/package.json", JSON.stringify({ name: "bundle" }));
    write("bundle/packages/extensions/herdr-bridge/package.json", JSON.stringify({ name: UNDER_TEST }));
    write("bundle/packages/extensions/herdr-bridge/extensions/herdr-bridge/index.ts", "");
    write("bundle/packages/extensions/other/extensions/other.ts", "");
    assert.equal(packageNameOf(join(root, "bundle/packages/extensions/herdr-bridge/extensions/herdr-bridge/index.ts")), UNDER_TEST);
    assert.equal(packageNameOf(join(root, "bundle/packages/extensions/other/extensions/other.ts")), "bundle", "a folder with no package.json of its own belongs to the one above");
    assert.equal(packageNameOf(join(root, "loose.ts")), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
