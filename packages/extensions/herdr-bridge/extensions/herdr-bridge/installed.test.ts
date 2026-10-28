import assert from "node:assert/strict";
import test from "node:test";
import { CHECKED, LEFT_OUT, classifyInstalled } from "./e2e/harness.ts";

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
