// The helper's real shell, in Seatbelt on macOS: what it may read and write (the broad scenario
// and secrets are in shell-secrets.test.ts, git in shell-git.test.ts, saved output in
// shell-output.test.ts). Split from helper.test.ts so the slow real-sandbox scenarios run beside
// the rest. Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md,
// docs/adr/20261104-close-the-home-folder-to-the-slack-helper.md and
// docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fakeHome, realSandbox, runInShell, shellRunsHere } from "./helper-fixtures.ts";
import { denyReadEntries, startShellSandbox } from "./sandbox.ts";
import { canonicalPath } from "./secrets.ts";

test("the real shell reads Pi's bin folder, and nothing else in Pi's agent folder", async (t) => {
  const home = fakeHome();
  const agent = join(home, ".pi", "agent");
  mkdirSync(join(agent, "bin"), { recursive: true });
  writeFileSync(join(agent, "bin", "tool-notes"), "BIN-CONTENT");
  writeFileSync(join(agent, "models.json"), "MODELS-KEY");
  const cwd = mkdtempSync(join(tmpdir(), "p-"));
  const sandbox = await realSandbox(cwd, home);
  if (!(await shellRunsHere(t, sandbox)) || !sandbox.ok) return;
  t.after(() => sandbox.dispose());
  let out = "";
  await sandbox.operations.exec(`cat '${join(agent, "bin", "tool-notes")}'; cat '${join(agent, "models.json")}'; echo END`, cwd, { onData: (d) => { out += d.toString(); }, env: process.env });
  assert.match(out, /BIN-CONTENT/, "Pi's bin is readable");
  assert.doesNotMatch(out, /MODELS-KEY/, "the rest of the agent folder is not");
  assert.match(out, /END/);
});

test("the real shell reads the project inside the home and the toolchains, and nothing else there; secrets in the project stay closed", async (t) => {
  const home = fakeHome();
  const project = join(home, "code", "app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "notes.md"), "PROJECT-NOTES");
  writeFileSync(join(project, ".env.local"), "PROJECT-ENV-SECRET");
  mkdirSync(join(home, ".config", "firebase"), { recursive: true });
  writeFileSync(join(home, ".config", "firebase", "me_application_default_credentials.json"), "FIREBASE-REFRESH-TOKEN");
  mkdirSync(join(home, "Documents"), { recursive: true });
  writeFileSync(join(home, "Documents", "private.txt"), "PRIVATE-DOC");
  mkdirSync(join(home, ".nvm"), { recursive: true });
  writeFileSync(join(home, ".nvm", "nvm.sh"), "NVM-SCRIPT");
  const sandbox = await startShellSandbox({ cwd: project, allowedDomains: [], home, agentDir: join(home, ".pi", "agent") });
  if (!(await shellRunsHere(t, sandbox)) || !sandbox.ok) return;
  t.after(() => sandbox.dispose());
  let out = "";
  const files = ["notes.md", ".env.local", join(home, ".config", "firebase", "me_application_default_credentials.json"), join(home, "Documents", "private.txt"), join(home, ".nvm", "nvm.sh")];
  await sandbox.operations.exec(`${files.map((f) => `cat '${f}' 2>/dev/null`).join("; ")}; echo END`, project, { onData: (d) => { out += d.toString(); }, env: process.env });
  assert.match(out, /PROJECT-NOTES/, "the project is readable");
  assert.match(out, /NVM-SCRIPT/, "a toolchain is readable");
  for (const secret of ["PROJECT-ENV-SECRET", "FIREBASE-REFRESH-TOKEN", "PRIVATE-DOC"]) assert.doesNotMatch(out, new RegExp(secret), `${secret} stays closed`);
  assert.match(out, /END/);
});

test("the real shell writes only to its scratch folder: not to sandbox-runtime's shared temp, and TMPDIR is the scratch folder", async (t) => {
  const home = fakeHome();
  const cwd = mkdtempSync(join(tmpdir(), "p-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "other-"));
  writeFileSync(join(elsewhere, "pi-bash-log.txt"), "MAIN-SESSION-OUTPUT");
  const marker = `zz-${process.pid}-${Date.now()}`;
  const shared = mkdtempSync("/tmp/shared-");
  writeFileSync(join(shared, "notes.txt"), "SHARED-TMP-NOTES");
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  const out = await runInShell(t, cwd, home, `echo x > /tmp/claude/${marker} 2>/dev/null && echo WROTE-SHARED; echo y > "$SCRATCH/ok" && echo WROTE-SCRATCH; [ "$TMPDIR" = "$SCRATCH" ] && echo TMPDIR-IS-SCRATCH; cat '${join(elsewhere, "pi-bash-log.txt")}' '${join(shared, "notes.txt")}' 2>/dev/null; echo END`);
  if (out === undefined) return;
  assert.doesNotMatch(out, /WROTE-SHARED/, "sandbox-runtime's shared /tmp/claude is not writable");
  assert.match(out, /WROTE-SCRATCH/);
  assert.match(out, /TMPDIR-IS-SCRATCH/);
  assert.doesNotMatch(out, /MAIN-SESSION-OUTPUT/, "other files in the temp folder are closed");
  assert.doesNotMatch(out, /SHARED-TMP-NOTES/, "and in the shared /tmp");
  assert.match(out, /END/);
});

test("the real shell opens nothing when the project is a secret folder, such as Pi's agent folder", async (t) => {
  const home = fakeHome();
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "models.json"), "MODELS-KEY");
  const out = await runInShell(t, agent, home, `cat '${join(agent, "models.json")}' 2>/dev/null; echo END`);
  if (out === undefined) return;
  assert.doesNotMatch(out, /MODELS-KEY/);
  assert.match(out, /END/);
});

test("the real shell cannot read the user's caches or /Users/Shared", async (t) => {
  const home = fakeHome();
  const cwd = mkdtempSync(join(tmpdir(), "p-"));
  // The system's own caches folder, whatever TMPDIR the test runs with.
  const cache = process.platform === "darwin" ? join(dirname(canonicalPath(execFileSync("getconf", ["DARWIN_USER_DIR"], { encoding: "utf8" }).trim())), "C") : join(dirname(canonicalPath(tmpdir())), "C");
  let shared: string | undefined;
  try {
    shared = mkdtempSync("/Users/Shared/slack-companion-test-");
    writeFileSync(join(shared, "notes.txt"), "SHARED-USERS-NOTES");
  } catch {
    shared = undefined; // not writable here: only the caches are checked
  }
  t.after(() => shared && rmSync(shared, { recursive: true, force: true }));
  const out = await runInShell(t, cwd, home, `ls '${cache}' >/dev/null 2>&1 && echo LISTED-CACHES; ${shared ? `cat '${join(shared, "notes.txt")}' 2>/dev/null;` : ""} echo END`);
  if (out === undefined) return;
  if (process.platform === "darwin") assert.doesNotMatch(out, /LISTED-CACHES/);
  assert.doesNotMatch(out, /SHARED-USERS-NOTES/);
  assert.match(out, /END/);
});


test("with TMPDIR set elsewhere, the shell still closes the per-user temp and cache folder the system names (macOS)", () => {
  const saved = process.env.TMPDIR;
  const elsewhere = mkdtempSync("/tmp/sc-tmpdir-");
  try {
    const perUser = process.platform === "darwin" ? dirname(canonicalPath(execFileSync("getconf", ["DARWIN_USER_DIR"], { encoding: "utf8" }).trim())) : undefined;
    process.env.TMPDIR = elsewhere;
    const entries = denyReadEntries({ cwd: elsewhere, home: fakeHome(), allowedDomains: [] });
    assert.ok(entries.includes(canonicalPath(elsewhere)), "the temp folder in use");
    if (perUser) assert.ok(entries.includes(perUser), `the system's per-user folder ${perUser}`);
    assert.equal(entries.includes("/private"), false);
  } finally {
    process.env.TMPDIR = saved;
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("on macOS, a system that does not name the per-user folder leaves the helper without a shell, never with that folder open", () => {
  if (process.platform !== "darwin") return; // the per-user folder is macOS's
  const home = fakeHome();
  const script = `import(${JSON.stringify(join(import.meta.dirname, "sandbox.ts"))}).then((m) => m.startShellSandbox({ cwd: ${JSON.stringify(home)}, home: ${JSON.stringify(home)}, allowedDomains: [] })).then((r) => console.log(JSON.stringify(r)))`;
  // The system's getconf does not answer (a getconf found on PATH instead would answer: it is not asked).
  const fakeBin = mkdtempSync(join(tmpdir(), "fake-getconf-"));
  const preload = join(fakeBin, "no-getconf.mjs");
  writeFileSync(preload, `import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module"; const real = cp.execFileSync; cp.execFileSync = (file, ...rest) => { if (file === "/usr/bin/getconf") throw Object.assign(new Error("spawnSync /usr/bin/getconf ETIMEDOUT"), { code: "ETIMEDOUT", stderr: "" }); return real(file, ...rest); }; syncBuiltinESMExports();`);
  const out = execFileSync(process.execPath, ["--import", preload, "--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8" });
  const result = JSON.parse(out.trim().split("\n").at(-1)!);
  assert.equal(result.ok, false, out);
  assert.equal(result.reason, "macOS gave no usable per-user temp folder (getconf DARWIN_USER_DIR did not answer in 2 s); macOS is asked again 10 minutes after this");
});
