// The helper's real shell, continued: git across worktrees and submodules, and long output it
// saved. Split from shell.test.ts so the slow real-sandbox scenarios run side by side. Holds
// docs/adr/20261104-close-the-home-folder-to-the-slack-helper.md (the repository's own folders,
// saved results).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeHome, helperRun, realSandbox, runInShell } from "./helper-fixtures.ts";
import { textOf } from "./pi-harness.ts";

test("git works in the real shell from a linked worktree, whose repository lies outside the project", async (t) => {
  const home = fakeHome();
  const main = join(home, "code", "repo");
  mkdirSync(main, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });
  git(main, "init", "-q");
  writeFileSync(join(main, "a.txt"), "a");
  git(main, "add", "a.txt");
  git(main, "commit", "-qm", "first commit here");
  const worktree = join(home, "code", "repo-wt");
  git(main, "worktree", "add", "-q", worktree);
  const out = await runInShell(t, worktree, home, "git log --oneline -1 2>&1; echo END");
  if (out === undefined) return;
  assert.match(out, /first commit here/, out);
  assert.doesNotMatch(out, /error|couldn't|not permitted/i, "git runs without errors");
});

test("git works in the real shell from a submodule, whose repository lies in the superproject", async (t) => {
  const home = fakeHome();
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args], { stdio: "ignore" });
  const lib = join(home, "code", "lib");
  mkdirSync(lib, { recursive: true });
  git(lib, "init", "-q");
  writeFileSync(join(lib, "l.txt"), "l");
  git(lib, "add", "l.txt");
  git(lib, "commit", "-qm", "lib commit here");
  const superproject = join(home, "code", "app");
  mkdirSync(superproject, { recursive: true });
  git(superproject, "init", "-q");
  git(superproject, "submodule", "add", "-q", lib, "lib");
  const out = await runInShell(t, join(superproject, "lib"), home, "git log --oneline -1 2>&1; echo END");
  if (out === undefined) return;
  assert.match(out, /lib commit here/, out);
});

test("the helper can read the full output its own long shell command saved", async (t) => {
  let saved = "";
  const { results } = await helperRun([
    { kind: "tool", name: "bash", args: { command: "seq 1 30000" } },
    (c) => {
      saved = /Full output: ([^\]\s]+)/.exec(textOf((c.messages.at(-1) as any)?.content))?.[1] ?? "";
      return { kind: "tool", name: "read", args: { path: saved, offset: 29990 } };
    },
  ], { sandbox: realSandbox });
  if (results.length < 2 || !results[0]!.text.includes("Full output")) {
    t.diagnostic("no shell here, or the output was not cut: nothing to check");
    return;
  }
  assert.equal(results[1]!.isError, false, results[1]!.text);
  assert.match(results[1]!.text, /30000/);
});

test("the helper can read the full output of its own shell command that timed out", async () => {
  let saved = "";
  const { results } = await helperRun([
    { kind: "tool", name: "bash", args: { command: "seq 1 30000; sleep 5", timeout: 1 } },
    (c) => {
      saved = /Full output: ([^\]\s]+)\]/.exec(textOf((c.messages.at(-1) as any)?.content))?.[1] ?? "";
      return { kind: "tool", name: "read", args: { path: saved, offset: 29990 } };
    },
  ], { sandbox: realSandbox });
  if (!saved) return; // no shell here
  assert.ok(results[0]!.isError, "the command timed out");
  assert.equal(results[1]!.isError, false, results[1]!.text);
  assert.match(results[1]!.text, /30000/);
});
