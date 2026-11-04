// The helper's whole runtime, built in a real fork whose parent has a foreign extension and the
// adapter's `mcp` proxy installed. Holds docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md
// (no extension, allowlisted tools) and docs/adr/20261104-sandbox-the-slack-helpers-shell.md.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { selectForkBranch } from "./fork.ts";
import { HelperAbortedError, MAX_HELPER_TURNS, runHelper, type HelperBatch, type HelperEnvironment } from "./helper.ts";
import { helperMcpTools, mcpCachePathIn, readMcpCache } from "./mcp-tools.ts";
import { createHarness, textOf, type Reply } from "./pi-harness.ts";
import { startShellSandbox, type ShellSandbox } from "./sandbox.ts";
import { defaultSecretPolicy } from "./secrets.ts";

const batch: HelperBatch = {
  conversationLabel: "DM with Robin Colleague",
  ownerName: "Dana Owner",
  inChannel: false,
  context: [],
  messages: [{ ts: "1793700100.000001", userId: "U0COLL0001", userName: "Robin Colleague", text: "can you check?", agentFooter: false }],
  waitingApprovals: [],
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

async function helperRun(steps: Reply[], options: { home?: string; sandbox?: (cwd: string, home: string) => Promise<ShellSandbox>; signal?: AbortSignal } = {}) {
  const queue = [...steps];
  const h = await createHarness({
    replies: (_c, role) => (role === "helper" ? (queue.shift() ?? { kind: "text", text: "done" }) : { kind: "text", text: "ok" }),
  });
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
    systemPromptOptions: { cwd: h.workspace },
    events: h.events,
    mcpTools: helperMcpTools(readMcpCache(mcpCachePathIn(h.agentDir)), new Set(h.session.getActiveToolNames()), [], ["slack_send_message"]),
    sandbox: await (options.sandbox ?? realSandbox)(h.workspace, home),
    secrets: defaultSecretPolicy(join(home, ".pi", "agent"), home),
  };
  const outcome = await runHelper(env, batch, options.signal);
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
  for (const r of reads) assert.ok(r.isError && /secret location/.test(r.text), r.text);
  assert.equal(results.some((r) => /PRIVATE-KEY-CONTENT|OAUTH-TOKEN-CONTENT|secret-value|tokens\.json|id_ed25519/.test(r.text) && !/secret location/.test(r.text)), false, "no secret content or name came back");
  assert.match(results.find((r) => r.tool === "grep" && /config\.ts/.test(r.text))!.text, /line one/, "ordinary search still works");
});

test("the sandboxed shell writes only to scratch, reads no secrets and reaches no network", async (t) => {
  const home = fakeHome();
  const probe = await realSandbox(mkdtempSync(join(tmpdir(), "p-")), home);
  if (!probe.ok) {
    // Skip only where sandbox-runtime does not support the platform; anywhere else, not starting is a failure.
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    if (SandboxManager.isSupportedPlatform()) assert.fail(`sandbox-runtime supports this platform but did not start: ${probe.reason}`);
    t.skip(`sandbox-runtime does not support this platform: ${probe.reason}`);
    return;
  }
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
});

test("a sandbox that cannot start leaves the helper without a shell", async () => {
  const { outcome } = await helperRun([{ kind: "tool", name: "bash", args: { command: "echo hi" } }], { sandbox: async () => ({ ok: false, reason: "test: no sandbox" }) });
  assert.equal(outcome.toolNames.includes("bash"), false);
  const sandbox = await startShellSandbox({ cwd: tmpdir(), allowedDomains: [] }, {
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
  const probe = await realSandbox(mkdtempSync(join(tmpdir(), "p-")), home);
  if (probe.ok) await probe.dispose();
  const steps: Reply[] = [];
  const secrets = [join(home, ".aws", "credentials"), join(home, ".pi", "agent", "auth.json"), "linked-config"];
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
  assert.equal(results.filter((r) => r.tool === "read").every((r) => r.isError && /secret location/.test(r.text)), true, "read");
  assert.equal(results.some((r) => /AWS-CREDENTIAL-CONTENT|PI-AUTH-CONTENT|SSH-CONFIG-CONTENT/.test(r.text)), false, "no tool returned a secret");
  assert.ok(results.filter((r) => r.tool === "ls" || r.tool === "find").every((r) => r.isError), "find and ls refuse secret folders, through a symlink too");
  if (!probe.ok) t.diagnostic(`shell part not run: ${probe.reason}`);
});
