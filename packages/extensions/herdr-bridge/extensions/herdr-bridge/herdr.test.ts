import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Herdr, HerdrError, cliRunner, isShellNotReady } from "./herdr.ts";

/** A stand-in `herdr` executable printing `stdout` and exiting with `code`. */
function stubHerdr(stdout: string, code: number): string {
  const path = join(mkdtempSync(join(tmpdir(), "herdr-bridge-stub-")), "herdr");
  writeFileSync(path, `#!/bin/sh\nprintf '%s' '${stdout.replace(/'/g, "'\\''")}'\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("a missing herdr executable fails with herdr_not_found and how to get it", async () => {
  await assert.rejects(cliRunner("/no/such/herdr-binary")(["agent", "list"]), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "herdr_not_found");
    assert.match(error.message, /install Herdr \(https:\/\/herdr\.dev\) and run this inside a Herdr pane/);
    return true;
  });
});

test("Herdr's JSON error becomes a HerdrError with Herdr's own code and message", async () => {
  const bin = stubHerdr('{"error":{"code":"agent_prompt_stalled","message":"no working state within 5000 ms"},"id":"cli:agent:prompt"}', 1);
  await assert.rejects(cliRunner(bin)(["agent", "prompt", "w", "x"]), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "agent_prompt_stalled");
    assert.equal(error.message, "no working state within 5000 ms");
    return true;
  });
});

test("a list without its pane, tab and workspace ids fails loudly", async () => {
  const bin = stubHerdr('{"result":{"type":"agent_list","agents":[{"name":"w","agent_status":"idle"}]}}', 0);
  await assert.rejects(new Herdr(cliRunner(bin)).listAgents(), /listed an entry without pane, tab and workspace ids/);
});

test("only the not-an-available-shell refusal counts as a shell not ready yet", () => {
  assert.equal(isShellNotReady(new HerdrError("agent target pane w2:p1 is not an available shell", "x")), true);
  assert.equal(isShellNotReady(new HerdrError("agent target pane w9:p9 not found", "agent_pane_not_found")), false);
  assert.equal(isShellNotReady(new Error("not an available shell")), false);
});
