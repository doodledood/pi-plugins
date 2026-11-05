// The helper's real shell, in Seatbelt on macOS: what it may read, write and reach, and how git
// and long output work there. Split from helper.test.ts so the slow real-sandbox scenarios run
// beside the rest. Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md,
// docs/adr/20261104-close-the-home-folder-to-the-slack-helper.md and
// docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fakeHome, helperRun, realSandbox, runInShell, shellRunsHere } from "./helper-fixtures.ts";
import { type Reply } from "./pi-harness.ts";
import { startShellSandbox } from "./sandbox.ts";
import { canonicalPath } from "./secrets.ts";

test("the sandboxed shell writes only to scratch, reads no secrets and reaches no network", async (t) => {
  const home = fakeHome();
  const probe = await realSandbox(mkdtempSync(join(tmpdir(), "p-")), home);
  if (!(await shellRunsHere(t, probe)) || !probe.ok) return;
  await probe.dispose();
  process.env.SLACK_HELPER_TEST_TOKEN = "TOKEN-FROM-ENVIRONMENT";
  t.after(() => { delete process.env.SLACK_HELPER_TEST_TOKEN; });
  let scratch = "";
  const { results, h } = await helperRun([
    { kind: "tool", name: "bash", args: { command: "touch project-write.txt && echo WROTE" } },
    { kind: "tool", name: "bash", args: { command: `cat ${join(home, ".ssh", "id_ed25519")}; echo END` } },
    { kind: "tool", name: "bash", args: { command: `cat ${join(home, ".pi", "agent", "mcp-oauth", "tokens.json")}; echo END` } },
    { kind: "tool", name: "bash", args: { command: "cat .env; echo END" } },
    { kind: "tool", name: "bash", args: { command: "env" } },
    { kind: "tool", name: "bash", args: { command: "curl -sS -m 5 https://example.com -o /dev/null && echo NET" } },
    { kind: "tool", name: "bash", args: { command: "echo hi > \"$SCRATCH/scratch-check\" && cat \"$SCRATCH/scratch-check\" && echo SCRATCH-OK" } },
  ], {
    home,
    sandbox: async (cwd, h2) => {
      const started = await realSandbox(cwd, h2);
      if (started.ok) scratch = started.scratchDir;
      return started;
    },
  });
  assert.ok(scratch);
  assert.equal(existsSync(join(h.workspace, "project-write.txt")), false, "no write in the project");
  const outputs = results.filter((r) => r.tool === "bash").map((r) => r.text);
  assert.equal(outputs.length, 7);
  assert.equal(outputs.some((o) => /\bWROTE\b/.test(o)), false);
  assert.equal(outputs.some((o) => /PRIVATE-KEY-CONTENT|OAUTH-TOKEN-CONTENT|TOKEN=secret-value/.test(o)), false, "secret files are unreadable from the shell");
  assert.equal(outputs.some((o) => /\bNET\b/.test(o)), false, "no network");
  assert.match(outputs[4]!, /\bPATH=/, "the environment was printed");
  assert.equal(outputs.some((o) => /TOKEN-FROM-ENVIRONMENT/.test(o)), false, "credential variables are not passed to commands");
  assert.match(outputs[6]!, /SCRATCH-OK/, "the scratch folder is writable");
  // Secrets outside the home and the project: another checkout's .env, an agent folder elsewhere.
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  writeFileSync(join(outside, ".env"), "OUTSIDE-ENV-SECRET");
  const outsideAgent = mkdtempSync(join(tmpdir(), "agent-elsewhere-"));
  writeFileSync(join(outsideAgent, "auth.json"), "OUTSIDE-AUTH-SECRET");
  const { results: more } = await helperRun([
    { kind: "tool", name: "bash", args: { command: `cat ${join(outside, ".env")}; cat ${join(outsideAgent, "auth.json")}; echo END` } },
  ], { home, sandbox: (cwd, h2) => startShellSandbox({ cwd, allowedDomains: [], home: h2, agentDir: outsideAgent }) });
  assert.equal(more.some((r) => /OUTSIDE-ENV-SECRET|OUTSIDE-AUTH-SECRET/.test(r.text)), false, "denied outside the home and the project too");
  assert.match(more[0]!.text, /END/, "the command ran");
});

test("every file tool and the shell are denied Pi's auth file, cloud credentials, and secrets reached through a symlink", async (t) => {
  const home = fakeHome();
  mkdirSync(join(home, ".aws"), { recursive: true });
  writeFileSync(join(home, ".aws", "credentials"), "AWS-CREDENTIAL-CONTENT");
  writeFileSync(join(home, ".pi", "agent", "auth.json"), "PI-AUTH-CONTENT");
  writeFileSync(join(home, ".ssh", "config"), "SSH-CONFIG-CONTENT");
  writeFileSync(join(home, ".pi", "agent", "auth.json.bak-openai1m"), "PI-AUTH-BACKUP-CONTENT");
  const probe = await realSandbox(mkdtempSync(join(tmpdir(), "p-")), home);
  if (probe.ok) await probe.dispose();
  const steps: Reply[] = [];
  const secrets = [join(home, ".aws", "credentials"), join(home, ".pi", "agent", "auth.json"), join(home, ".pi", "agent", "auth.json.bak-openai1m"), "linked-config"];
  for (const path of secrets) steps.push({ kind: "tool", name: "read", args: { path } });
  steps.push({ kind: "tool", name: "grep", args: { pattern: "CONTENT", path: join(home, ".aws") } });
  steps.push({ kind: "tool", name: "grep", args: { pattern: "CONTENT", path: "." } });
  steps.push({ kind: "tool", name: "find", args: { pattern: "*", path: join(home, ".aws") } });
  steps.push({ kind: "tool", name: "ls", args: { path: "linked-dir" } });
  if (probe.ok) for (const path of secrets) steps.push({ kind: "tool", name: "bash", args: { command: `cat ${path}; echo END` } });
  const { results, h } = await helperRun(steps, {
    home,
    sandbox: async (cwd, h2) => {
      symlinkSync(join(home, ".ssh", "config"), join(cwd, "linked-config"));
      symlinkSync(join(home, ".ssh"), join(cwd, "linked-dir"));
      return realSandbox(cwd, h2);
    },
  });
  assert.ok(h);
  assert.equal(results.filter((r) => r.tool === "read").every((r) => r.isError && /not open to the Slack helper/.test(r.text)), true, "read");
  assert.equal(results.some((r) => /AWS-CREDENTIAL-CONTENT|PI-AUTH-CONTENT|PI-AUTH-BACKUP-CONTENT|SSH-CONFIG-CONTENT/.test(r.text)), false, "no tool returned a secret, a backup of one included");
  assert.ok(results.filter((r) => r.tool === "ls" || r.tool === "find").every((r) => r.isError), "find and ls refuse secret folders, through a symlink too");
  if (!probe.ok) t.diagnostic(`shell part not run: ${probe.reason}`);
});

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
  const cache = join(dirname(canonicalPath(tmpdir())), "C");
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
  if (/^\/private\/var\/folders\//.test(canonicalPath(tmpdir()))) assert.doesNotMatch(out, /LISTED-CACHES/);
  assert.doesNotMatch(out, /SHARED-USERS-NOTES/);
  assert.match(out, /END/);
});

