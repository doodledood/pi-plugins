// The helper's whole runtime, built in a real fork whose parent has a foreign extension and the
// adapter's `mcp` proxy installed. Holds docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md
// (no extension, allowlisted tools), docs/adr/20261104-sandbox-the-slack-helpers-shell.md and
// docs/adr/20261104-close-the-home-folder-to-the-slack-helper.md.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { forkEntriesForChild, selectForkBranch } from "./fork.ts";
import { HelperAbortedError, MAX_HELPER_TURNS, runHelper, type HelperBatch, type HelperEnvironment } from "./helper.ts";
import { helperMcpTools, mcpCachePathIn, readMcpCache } from "./mcp-tools.ts";
import type { Context } from "@earendil-works/pi-ai";
import { createHarness, type Harness, systemText, textOf, type Reply } from "./pi-harness.ts";
import { NO_SHELL_ON_LINUX, startShellSandbox, type ShellSandbox } from "./sandbox.ts";
import { readPolicy } from "./secrets.ts";

const batch: HelperBatch = {
  conversationLabel: "DM with Robin Colleague",
  ownerName: "Dana Owner",
  inChannel: false,
  context: [],
  messages: [{ ts: "1793700100.000001", userId: "U0COLL0001", userName: "Robin Colleague", text: "can you check?", agentFooter: false }],
  waitingApprovals: [],
  requestRoom: 1,
};

/** A home folder of the test's own, with a key in ~/.ssh and an OAuth token under the agent folder. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "helper-home-"));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_ed25519"), "PRIVATE-KEY-CONTENT");
  mkdirSync(join(home, ".pi", "agent", "mcp-oauth"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "mcp-oauth", "tokens.json"), "OAUTH-TOKEN-CONTENT");
  return home;
}

const realSandbox = (cwd: string, home: string) => startShellSandbox({ cwd, allowedDomains: [], home, agentDir: join(home, ".pi", "agent") });

/**
 * Whether a real shell scenario can run here. On Linux the helper has no shell by decision
 * (docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md): the scenario then checks
 * exactly that and ends, which is a pass, not a skip. Elsewhere it skips only where sandbox-runtime
 * does not support the platform; anywhere else, a shell that did not start is a failure.
 */
async function shellRunsHere(t: { skip(message?: string): void; diagnostic(message: string): void }, probe: ShellSandbox): Promise<boolean> {
  if (probe.ok) return true;
  if (probe.reason === NO_SHELL_ON_LINUX) {
    assert.equal(process.platform, "linux", "only Linux refuses the shell by decision");
    t.diagnostic(`no shell on Linux, as decided: ${probe.reason}`);
    return false;
  }
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  if (SandboxManager.isSupportedPlatform()) assert.fail(`sandbox-runtime supports this platform but did not start: ${probe.reason}`);
  t.skip(`sandbox-runtime does not support this platform: ${probe.reason}`);
  return false;
}

type Step = Reply | ((context: Context) => Reply);

async function helperRun(steps: Step[], options: { home?: string; sandbox?: (cwd: string, home: string) => Promise<ShellSandbox>; signal?: AbortSignal; skills?: (agentDir: string) => Skill[]; prepare?: (h: Harness) => void } = {}) {
  const queue = [...steps];
  const h = await createHarness({
    replies: (c, role) => {
      if (role !== "helper") return { kind: "text", text: "ok" };
      const next = queue.shift() ?? { kind: "text", text: "done" };
      return typeof next === "function" ? next(c) : next;
    },
  });
  options.prepare?.(h);
  await h.session.prompt("hello");
  const home = options.home ?? fakeHome();
  writeFileSync(join(h.workspace, ".env"), "TOKEN=secret-value");
  writeFileSync(join(h.workspace, "config.ts"), "line one\nline two\n");
  const handlerRunsBefore = h.foreign.handlerRuns;
  // An extension the owner installed globally: the helper must not load it.
  mkdirSync(join(h.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(h.agentDir, "extensions", "installed-elsewhere.ts"), [
    'import { writeFileSync } from "node:fs";',
    "export default function (pi: any) {",
    `  writeFileSync(${JSON.stringify(join(h.agentDir, "installed-factory-ran"))}, "yes");`,
    `  pi.on("before_agent_start", () => writeFileSync(${JSON.stringify(join(h.agentDir, "installed-ran"))}, "yes"));`,
    '  pi.registerTool({ name: "installed_tool", label: "installed", description: "installed", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "installed" }], details: {} }; } });',
    "}",
  ].join("\n"));
  const env: HelperEnvironment = {
    cwd: h.workspace,
    agentDir: h.agentDir,
    model: h.session.model!,
    thinkingLevel: "off",
    streamSimple: (m, c, o) => h.registry.streamSimple(m, c, o),
    branch: selectForkBranch(h.session.sessionManager.getBranch() as SessionEntry[], true),
    systemPromptOptions: { cwd: h.workspace, ...(options.skills ? { skills: options.skills(h.agentDir) } : {}) },
    events: h.events,
    mcpTools: helperMcpTools(readMcpCache(mcpCachePathIn(h.agentDir)), new Set(h.session.getActiveToolNames()), [], { blocked: ["slack_send_message"] }),
    sandbox: await (options.sandbox ?? realSandbox)(h.workspace, home),
    reads: readPolicy({ home, agentDir: join(home, ".pi", "agent"), roots: [h.workspace] }),
  };
  const outcome = await runHelper(env, batch, options.signal).finally(async () => {
    if (env.sandbox.ok) await env.sandbox.dispose(); // no scratch folder outlives the test
  });
  const results = outcome.ownEntries
    .filter((e: any) => e.type === "message" && e.message.role === "toolResult")
    .map((e: any) => ({ tool: e.message.toolName as string, isError: e.message.isError as boolean, text: textOf(e.message.content) }));
  return { h, outcome, results, home, handlerRunsBefore };
}

test("the helper's runtime: no extension, no handler, only the allowlisted tools, and those tools work", async () => {
  let scratch = "";
  const { h, outcome, results, handlerRunsBefore } = await helperRun([
    { kind: "tool", name: "read", args: { path: "notes.md" } },
    { kind: "tool", name: "data_lookup", args: { q: "kb" } },
    { kind: "tool", name: "mcp", args: { tool: "slack_send_message", args: { channel_id: "D0FAKE0001", message: "x" } } },
    { kind: "tool", name: "foreign_tool", args: {} },
    { kind: "tool", name: "data_write", args: { q: "x" } },
    { kind: "tool", name: "reply_in_slack", args: { text: "Checked: KB is king." } },
  ], {
    sandbox: async (cwd, home) => {
      const started = await realSandbox(cwd, home);
      if (started.ok) scratch = started.scratchDir;
      return started;
    },
  });
  // data_lookup: read-only and active in main. Read-only tools main does not have active (the Slack
  // reads) and data_write (not read-only) are left out.
  const expected = ["read", "grep", "find", "ls", "data_lookup", "search_read_only_tools", "call_read_only_tool", "reply_in_slack", "hand_off_to_main"];
  assert.deepEqual(new Set(outcome.toolNames), new Set(scratch ? [...expected, "bash"] : expected));
  for (const forbidden of ["mcp", "mcp__slack", "edit", "write", "goal", "slack_send_message", "mcp__slack__slack_send_message", "foreign_tool", "data_write", "slack_watch", "installed_tool"]) {
    assert.equal(outcome.toolNames.includes(forbidden), false, forbidden);
  }
  assert.match(results.find((r) => r.tool === "read")!.text, /KB as king/);
  assert.deepEqual(h.dataCalls, ["data_lookup"], "the read-only MCP tool ran through the parent's runtime event");
  for (const name of ["mcp", "foreign_tool", "data_write"]) {
    assert.ok(results.some((r) => r.tool === name && r.isError), `${name} does not exist in the helper`);
  }
  assert.equal(h.foreign.toolRuns, 0);
  assert.equal(h.foreign.handlerRuns, handlerRunsBefore, "the parent's handlers never run in the helper");
  assert.equal(existsSync(join(h.agentDir, "installed-ran")), false, "an installed extension's handler never ran in the helper");
  assert.equal(existsSync(join(h.agentDir, "installed-factory-ran")), false, "an installed extension's factory never ran while the helper was built");
  assert.equal(h.slack.messages("D0FAKE0001").length, 0, "the helper cannot post through the proxy");
  assert.deepEqual(outcome.reply, { text: "Checked: KB is king.", done: false });
});

test("the helper's model calls reach main's provider with main's own credential, never the helper's placeholder", async () => {
  const { h } = await helperRun([{ kind: "text", text: "nothing to add" }]);
  const helperCalls = h.calls.filter((c) => c.role === "helper");
  assert.ok(helperCalls.length >= 1);
  for (const call of helperCalls) assert.equal(call.apiKey, "k", "main's registry credential");
});

test("every file tool is denied secret locations, in every spelling Pi's tools accept", async () => {
  const home = fakeHome();
  const key = join(home, ".ssh", "id_ed25519");
  const token = join(home, ".pi", "agent", "mcp-oauth", "tokens.json");
  const { results } = await helperRun([
    { kind: "tool", name: "read", args: { path: key } },
    { kind: "tool", name: "read", args: { path: `@${key}` } },
    { kind: "tool", name: "read", args: { path: pathToFileURL(key).href } },
    { kind: "tool", name: "read", args: { path: `@${pathToFileURL(token).href}` } },
    { kind: "tool", name: "read", args: { path: ".env" } },
    { kind: "tool", name: "read", args: { path: "@.env" } },
    { kind: "tool", name: "grep", args: { pattern: "CONTENT", path: join(home, ".ssh") } },
    { kind: "tool", name: "grep", args: { pattern: "CONTENT", path: home } },
    { kind: "tool", name: "grep", args: { pattern: "line", path: ".", context: 3 } },
    { kind: "tool", name: "find", args: { pattern: "*", path: join(home, ".pi") } },
    { kind: "tool", name: "ls", args: { path: join(home, ".ssh") } },
    { kind: "tool", name: "ls", args: { path: `@${join(home, ".pi", "agent", "mcp-oauth")}` } },
  ], { home });
  const reads = results.filter((r) => r.tool === "read");
  assert.equal(reads.length, 6);
  for (const r of reads) assert.ok(r.isError && /not open to the Slack helper/.test(r.text), r.text);
  assert.equal(results.some((r) => /PRIVATE-KEY-CONTENT|OAUTH-TOKEN-CONTENT|secret-value|tokens\.json|id_ed25519/.test(r.text) && !/not open to the Slack helper/.test(r.text)), false, "no secret content or name came back");
  assert.match(results.find((r) => r.tool === "grep" && /config\.ts/.test(r.text))!.text, /line one/, "ordinary search still works");
});

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

test("a sandbox that cannot start leaves the helper without a shell", async () => {
  const { outcome, h } = await helperRun([{ kind: "tool", name: "bash", args: { command: "echo hi" } }], { sandbox: async () => ({ ok: false, reason: "test: no sandbox" }) });
  assert.equal(outcome.toolNames.includes("bash"), false);
  const prompt = systemText(h.calls.filter((c) => c.role === "helper").at(-1)!.context);
  assert.match(prompt, /you have no shell/, "the helper is not promised a shell it lacks");
  assert.doesNotMatch(prompt, /sandboxed shell/);
  const sandbox = await startShellSandbox({ cwd: tmpdir(), allowedDomains: [], platform: "darwin" }, {
    isSupportedPlatform: () => true,
    initialize: async () => { throw new Error("seatbelt refused"); },
    updateConfig: () => {},
    wrapWithSandbox: async (c) => c,
  });
  assert.equal(sandbox.ok, false);
  assert.match((sandbox as { reason: string }).reason, /seatbelt refused/);
});

test("a stopped run does not start, and a run stuck calling tools is stopped at the turn limit", async () => {
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(helperRun([], { signal: stopped.signal }), HelperAbortedError);
  const { outcome, h } = await helperRun(Array.from({ length: MAX_HELPER_TURNS + 10 }, () => ({ kind: "tool", name: "ls", args: {} }) as Reply));
  assert.equal(outcome.stoppedAtTurnLimit, true);
  assert.ok(h.calls.filter((c) => c.role === "helper").length <= MAX_HELPER_TURNS + 1);
});

test("the helper reaches every read-only tool through search and call, and nothing else", async () => {
  const { h, results } = await helperRun([
    { kind: "tool", name: "search_read_only_tools", args: { query: "thread" } },
    { kind: "tool", name: "call_read_only_tool", args: { tool: "slack_read_user_profile", arguments: { response_format: "detailed" } } },
    { kind: "tool", name: "call_read_only_tool", args: { tool: "slack_send_message", arguments: { channel_id: "D0FAKE0001", message: "x" } } },
    { kind: "tool", name: "call_read_only_tool", args: { tool: "data_write", arguments: { q: "x" } } },
  ]);
  const [search, profile, send, write] = results;
  assert.match(search!.text, /slack_read_thread \(slack\)/);
  assert.equal(profile!.isError, false);
  assert.match(profile!.text, /Display Name: Dana Owner/);
  assert.ok(send!.isError && /not a read-only tool/.test(send!.text));
  assert.ok(write!.isError && /not a read-only tool/.test(write!.text));
  assert.equal(h.slack.messages("D0FAKE0001").length, 0);
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

test("the helper is told when no more requests can wait, so it never tells the person one waits", async () => {
  const { outcome, results } = await helperRun([
    { kind: "tool", name: "hand_off_to_main", args: { kind: "action", text: "first" } },
    { kind: "tool", name: "hand_off_to_main", args: { kind: "action", text: "second" } },
  ]);
  assert.deepEqual(outcome.handoffs.map((h) => h.text), ["first"], "room for one");
  assert.match(results[1]!.text, /No more requests can wait/);
});

test("one reply per batch: a second reply is refused; main's custom entries never reach the helper", async () => {
  const { outcome, results } = await helperRun([
    { kind: "tool", name: "reply_in_slack", args: { text: "first" } },
    { kind: "tool", name: "reply_in_slack", args: { text: "second" } },
  ]);
  assert.equal(outcome.reply!.text, "first");
  assert.match(results[1]!.text, /already has its reply/);
  const custom = { type: "custom", customType: "slack-companion-state", data: { secret: "state" }, id: "c1", parentId: null, timestamp: new Date().toISOString() };
  assert.equal(forkEntriesForChild([custom as any]).some((e: any) => e.type === "custom"), false);
});

test("grep and find refuse a secret folder reached through a symlink", async () => {
  const home = fakeHome();
  const { results } = await helperRun([
    { kind: "tool", name: "grep", args: { pattern: "CONTENT", path: "linked-ssh" } },
    { kind: "tool", name: "find", args: { pattern: "*", path: "linked-ssh" } },
  ], { home, sandbox: async (cwd, h2) => { symlinkSync(join(home, ".ssh"), join(cwd, "linked-ssh")); return realSandbox(cwd, h2); } });
  assert.ok(results.every((r) => r.isError && /not open to the Slack helper/.test(r.text)), JSON.stringify(results));
});

test("the helper can load the skills it is offered from Pi's agent folder, and nothing else there", async () => {
  const home = fakeHome();
  const agentDir = join(home, ".pi", "agent");
  const skillDir = join(agentDir, "git", "example.com", "pkg", "skills", "triage-notes");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "SKILL-BODY");
  mkdirSync(join(skillDir, "references"));
  writeFileSync(join(skillDir, "references", "LOG.md"), "REFERENCE-BODY");
  writeFileSync(join(skillDir, ".env"), "SKILL-SECRET");
  writeFileSync(join(agentDir, "models.json"), "MODELS-KEY");
  mkdirSync(join(agentDir, "skills", "not-offered"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "not-offered", "SKILL.md"), "OTHER-BODY");
  const skill = { name: "triage-notes", description: "notes", filePath: join(skillDir, "SKILL.md"), baseDir: skillDir, sourceInfo: { path: join(skillDir, "SKILL.md"), source: "package", scope: "user" } as any, disableModelInvocation: false };
  const { results } = await helperRun([
    { kind: "tool", name: "read", args: { path: join(skillDir, "SKILL.md") } },
    { kind: "tool", name: "read", args: { path: join(skillDir, "references", "LOG.md") } },
    { kind: "tool", name: "read", args: { path: join(skillDir, ".env") } },
    { kind: "tool", name: "read", args: { path: join(agentDir, "models.json") } },
    { kind: "tool", name: "read", args: { path: join(agentDir, "skills", "not-offered", "SKILL.md") } },
  ], { home, skills: () => [skill] });
  const [body, reference, secret, models, other] = results;
  assert.equal(body!.isError, false);
  assert.match(body!.text, /SKILL-BODY/, "an offered skill loads");
  assert.match(reference!.text, /REFERENCE-BODY/, "and the files beside its SKILL.md, which it names by relative path");
  for (const [r, what] of [[secret, "a secret name inside the skill"], [models, "models.json"], [other, "a skill not offered"]] as const) {
    assert.ok(r!.isError && /not open to the Slack helper/.test(r!.text), `${what} stays closed`);
  }
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

test("before main's first prompt, the skills the loader offers can be loaded", async () => {
  // No prompt options yet (a restored watch answering before the owner types): the loader finds its own skills.
  let skillPath = "";
  const { results } = await helperRun([() => ({ kind: "tool", name: "read", args: { path: skillPath } })], {
    prepare: (h) => {
      const dir = join(h.agentDir, "skills", "triage-notes");
      mkdirSync(dir, { recursive: true });
      skillPath = join(dir, "SKILL.md");
      writeFileSync(skillPath, "---\nname: triage-notes\ndescription: how to triage\n---\nSKILL-BODY");
    },
  });
  assert.equal(results[0]!.isError, false, results[0]!.text);
  assert.match(results[0]!.text, /SKILL-BODY/);
});

test("a result the helper's own call saved to a file can be read; other saved results cannot", async () => {
  const other = mkdtempSync(join(tmpdir(), "fake-guard-"));
  writeFileSync(join(other, "output.txt"), "SOMEONE-ELSES-RESULT");
  const savedPath = (c: Context) => /Full text saved to: ([^\]\s]+)\]/.exec(textOf((c.messages.at(-1) as any)?.content))?.[1] ?? "";
  const { results } = await helperRun([
    { kind: "tool", name: "call_read_only_tool", args: { tool: "slack_read_user_profile", arguments: { response_format: "detailed" } } },
    (c) => ({ kind: "tool", name: "read", args: { path: savedPath(c) } }),
    { kind: "tool", name: "read", args: { path: join(other, "output.txt") } },
  ], { prepare: (h) => h.slack.failures.set("slack_read_user_profile", ["truncate"]) });
  const [, own, foreign] = results;
  assert.equal(own!.isError, false, own!.text);
  assert.match(own!.text, /Display Name: Dana Owner/);
  assert.ok(foreign!.isError && /not open to the Slack helper/.test(foreign!.text));
});

async function runInShell(t: any, cwd: string, home: string, command: string, agentDir = join(home, ".pi", "agent")): Promise<string | undefined> {
  const sandbox = await startShellSandbox({ cwd, allowedDomains: [], home, agentDir });
  if (!(await shellRunsHere(t, sandbox)) || !sandbox.ok) return undefined;
  t.after(() => sandbox.dispose());
  let out = "";
  await sandbox.operations.exec(command, cwd, { onData: (d) => { out += d.toString(); }, env: process.env });
  return out;
}

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

test("searches through the helper drop what it may not read: no secret file's lines or name come back", async () => {
  const { results } = await helperRun([
    { kind: "tool", name: "grep", args: { pattern: "TOKEN", path: "." } },
    { kind: "tool", name: "find", args: { pattern: "*", path: "." } },
    { kind: "tool", name: "ls", args: { path: "." } },
  ]);
  for (const r of results) {
    assert.equal(/secret-value|\.env/.test(r.text), false, `${r.tool}: ${r.text}`);
  }
  assert.match(results[1]!.text, /config\.ts/, "ordinary files are listed");
});

test("the helper can read the full output its own long shell command saved", async (t) => {
  let saved = "";
  const { results } = await helperRun([
    { kind: "tool", name: "bash", args: { command: "seq 1 30000" } },
    (c) => {
      saved = /Full output: ([^\]\s]+)/.exec(textOf((c.messages.at(-1) as any)?.content))?.[1] ?? "";
      return { kind: "tool", name: "read", args: { path: saved, offset: 29990 } };
    },
  ]);
  if (results.length < 2 || !results[0]!.text.includes("Full output")) {
    t.diagnostic("no shell here, or the output was not cut: nothing to check");
    return;
  }
  assert.equal(results[1]!.isError, false, results[1]!.text);
  assert.match(results[1]!.text, /30000/);
});
