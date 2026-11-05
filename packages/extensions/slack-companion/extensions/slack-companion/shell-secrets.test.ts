// The helper's real shell, continued: the broad scenario (scratch-only writes, no secrets, no
// network) and the secrets every file tool and the shell are denied. Split from shell.test.ts so
// the slow real-sandbox scenarios run side by side. Holds
// docs/adr/20261104-sandbox-the-slack-helpers-shell.md.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fakeHome, helperRun, realSandbox, shellRunsHere } from "./helper-fixtures.ts";
import { type Reply } from "./pi-harness.ts";
import { startShellSandbox } from "./sandbox.ts";

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
