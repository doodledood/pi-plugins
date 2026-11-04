// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (secret locations) and
// docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md (secret-shaped replies).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filterSecretLines, findSecretShape, isSecretPath, secretDirectories, walksIntoSecrets } from "./secrets.ts";

function home() {
  const root = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(root, ".ssh"));
  writeFileSync(join(root, ".ssh", "id_ed25519"), "key");
  mkdirSync(join(root, "project"));
  writeFileSync(join(root, "project", ".env"), "TOKEN=x");
  writeFileSync(join(root, "project", "app.ts"), "code");
  symlinkSync(join(root, ".ssh", "id_ed25519"), join(root, "project", "innocent.txt"));
  return { root, policy: { directories: secretDirectories(root, join(root, ".pi", "agent")) } };
}

test("secret folders, secret file names and symlinks into them are secret; project code is not", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  assert.equal(isSecretPath(policy, cwd, join(root, ".ssh", "id_ed25519")), true);
  assert.equal(isSecretPath(policy, cwd, ".env"), true);
  assert.equal(isSecretPath(policy, cwd, "innocent.txt"), true, "a symlink is judged by where it leads");
  assert.equal(isSecretPath(policy, cwd, "app.ts"), false);
  assert.equal(walksIntoSecrets(policy, cwd, root), true, "searching the home folder would walk into ~/.ssh");
  assert.equal(walksIntoSecrets(policy, cwd, "."), false);
});

test("output lines naming secret files are dropped", () => {
  const { root, policy } = home();
  const cwd = join(root, "project");
  const out = filterSecretLines(policy, cwd, ".", "app.ts:1:code\n.env:1:TOKEN=x\nREADME.md-2-text");
  assert.equal(out, "app.ts:1:code\nREADME.md-2-text");
});

test("common credential shapes are recognized; ordinary text is not", () => {
  assert.equal(findSecretShape("key AKIAABCDEFGHIJKLMNOP here"), "AWS access key");
  assert.equal(findSecretShape(`ghp_${"a".repeat(36)}`), "GitHub token");
  assert.equal(findSecretShape("xoxb-123456789012-abcdef"), "Slack token");
  assert.equal(findSecretShape("-----BEGIN OPENSSH PRIVATE KEY-----"), "private key block");
  assert.equal(findSecretShape("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123"), "bearer token");
  assert.equal(findSecretShape(`sk-${"x".repeat(30)}`), "API key");
  assert.equal(findSecretShape("The pass rate moved from 77% to 81%."), undefined);
});
