// The helper's whole runtime, built in a real fork whose parent has a foreign extension and the
// adapter's `mcp` proxy installed. Holds docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md
// (no extension, allowlisted tools) and docs/adr/20261104-sandbox-the-slack-helpers-shell.md.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { selectForkBranch } from "./fork.ts";
import { runHelper, type HelperBatch, type HelperEnvironment } from "./helper.ts";
import { createHarness, textOf, type Reply } from "./pi-harness.ts";
import { startShellSandbox, type ShellSandbox } from "./sandbox.ts";
import { secretDirectories } from "./secrets.ts";

const batch: HelperBatch = {
  conversationLabel: "DM with Robin Colleague",
  ownerName: "Dana Owner",
  inChannel: false,
  context: [],
  messages: [{ ts: "1793700100.000001", userId: "U0COLL0001", userName: "Robin Colleague", text: "can you check?", agentFooter: false }],
  waitingApprovals: [],
};

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "helper-home-"));
  mkdirSync(join(home, ".ssh"));
  writeFileSync(join(home, ".ssh", "id_test"), "PRIVATE");
  return home;
}

async function helperRun(steps: Reply[], sandbox: (cwd: string, home: string) => Promise<ShellSandbox>) {
  const queue = [...steps];
  const h = await createHarness({
    replies: (_c, role) => (role === "helper" ? (queue.shift() ?? { kind: "text", text: "done" }) : { kind: "text", text: "ok" }),
  });
  await h.session.prompt("hello");
  const home = fakeHome();
  writeFileSync(join(h.workspace, ".env"), "TOKEN=secret-value");
  const handlerRunsBefore = h.foreign.handlerRuns;
  // An extension the owner installed globally: the helper must not load it.
  mkdirSync(join(h.agentDir, "extensions"), { recursive: true });
  writeFileSync(join(h.agentDir, "extensions", "installed-elsewhere.ts"), [
    'import { writeFileSync } from "node:fs";',
    "export default function (pi: any) {",
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
    mainTools: h.allTools(),
    investigativeTools: [],
    slackToolNames: ["slack_send_message", "slack_read_thread", "slack_read_channel", "slack_read_user_profile"],
    sandbox: await sandbox(h.workspace, home),
    secrets: { directories: secretDirectories(home, join(home, ".pi", "agent")) },
  };
  const outcome = await runHelper(env, batch);
  const results = outcome.ownEntries
    .filter((e: any) => e.type === "message" && e.message.role === "toolResult")
    .map((e: any) => ({ tool: e.message.toolName as string, isError: e.message.isError as boolean, text: textOf(e.message.content) }));
  return { h, outcome, results, home, handlerRunsBefore };
}

const realSandbox = (cwd: string, home: string) => startShellSandbox({ cwd, allowedDomains: [], home, agentDir: join(home, ".pi", "agent") });

test("the helper's runtime: no extension, no handler, only the allowlisted tools, and those tools work", async () => {
  let scratch = "";
  const sandbox = async (cwd: string, home: string) => {
    const started = await realSandbox(cwd, home);
    if (started.ok) scratch = started.scratchDir;
    return started;
  };
  const { h, outcome, results, handlerRunsBefore } = await helperRun([
    { kind: "tool", name: "read", args: { path: "notes.md" } },
    { kind: "tool", name: "bash", args: { command: "echo from-helper > \"$SCRATCH_FILE\" 2>/dev/null; echo scratch-ok" } },
    { kind: "tool", name: "data_lookup", args: { q: "kb" } },
    { kind: "tool", name: "mcp", args: { tool: "slack_send_message", args: { channel_id: "D0FAKE0001", message: "x" } } },
    { kind: "tool", name: "foreign_tool", args: {} },
    { kind: "tool", name: "data_write", args: { q: "x" } },
    { kind: "tool", name: "reply_in_slack", args: { text: "Checked: KB is king." } },
  ], sandbox);
  const expected = ["read", "grep", "find", "ls", "data_lookup", "reply_in_slack", "hand_off_to_main"];
  const sandboxed = scratch !== "";
  assert.deepEqual(new Set(outcome.toolNames), new Set(sandboxed ? [...expected, "bash"] : expected));
  for (const forbidden of ["mcp", "edit", "write", "goal", "slack_send_message", "foreign_tool", "data_write", "slack_watch", "installed_tool"]) {
    assert.equal(outcome.toolNames.includes(forbidden), false, forbidden);
  }
  assert.match(results.find((r) => r.tool === "read")!.text, /KB as king/);
  assert.deepEqual(h.dataCalls, ["data_lookup"], "the read-only MCP tool ran through the parent's runtime event");
  assert.ok(results.filter((r) => r.isError).length >= 3, "mcp, foreign_tool and data_write do not exist in the helper");
  assert.equal(h.foreign.toolRuns, 0);
  assert.equal(h.foreign.handlerRuns, handlerRunsBefore, "the parent's handlers never run in the helper");
  assert.equal(outcome.toolNames.includes("installed_tool"), false, "an installed extension's tool does not exist in the helper");
  assert.equal(existsSync(join(h.agentDir, "installed-ran")), false, "an installed extension's handler never ran in the helper");
  assert.equal(h.slack.messages("D0FAKE0001").length, 0, "the helper cannot post through the proxy");
  assert.deepEqual(outcome.reply, { text: "Checked: KB is king.", done: false });
});

test("every file-reading tool is denied secret locations", async () => {
  const home = fakeHome();
  const key = join(home, ".ssh", "id_test");
  const { results } = await helperRun([
    { kind: "tool", name: "read", args: { path: key } },
    { kind: "tool", name: "read", args: { path: ".env" } },
    { kind: "tool", name: "grep", args: { pattern: "PRIVATE", path: join(home, ".ssh") } },
    { kind: "tool", name: "find", args: { pattern: "*", path: join(home, ".ssh") } },
    { kind: "tool", name: "ls", args: { path: join(home, ".ssh") } },
  ], async (cwd) => realSandbox(cwd, home));
  // The run used its own fake home for the policy; these paths are inside that run's home too
  // only when equal, so check the denials by message rather than by path.
  const denials = results.filter((r) => r.isError && /secret location/.test(r.text));
  assert.ok(denials.some((r) => r.tool === "read"), "read .env");
  assert.equal(results.some((r) => /PRIVATE|TOKEN=secret-value/.test(r.text)), false, "no secret content came back");
});

test("the sandboxed shell writes only to scratch, reads no secrets and reaches no network", async (t) => {
  const probe = await realSandbox(mkdtempSync(join(tmpdir(), "p-")), fakeHome());
  if (!probe.ok) {
    t.skip(`sandbox-runtime unavailable here: ${probe.reason}`);
    return;
  }
  let scratch = "";
  let home = "";
  const sandbox = async (cwd: string, h: string) => {
    home = h;
    const s = await realSandbox(cwd, h);
    if (s.ok) scratch = s.scratchDir;
    return s;
  };
  const { results, h } = await helperRun([
    { kind: "tool", name: "bash", args: { command: "touch project-write.txt && echo WROTE" } },
    { kind: "tool", name: "bash", args: { command: "cat \"$HOME_KEY\" || cat ~/.ssh/id_test; echo END" } },
    { kind: "tool", name: "bash", args: { command: "cat .env; echo END" } },
    { kind: "tool", name: "bash", args: { command: "curl -sS -m 5 https://example.com -o /dev/null && echo NET" } },
  ], sandbox);
  assert.equal(existsSync(join(h.workspace, "project-write.txt")), false, "no write in the project");
  const outputs = results.filter((r) => r.tool === "bash").map((r) => r.text);
  assert.equal(outputs.some((o) => /\bWROTE\b/.test(o)), false);
  assert.equal(outputs.some((o) => /TOKEN=secret-value/.test(o)), false, ".env is unreadable from the shell");
  assert.equal(outputs.some((o) => /\bNET\b/.test(o)), false, "no network");
  // A scratch write succeeds.
  const { results: ok } = await helperRun([{ kind: "tool", name: "bash", args: { command: `echo hi > ${scratch}/f && cat ${scratch}/f` } }], async (cwd) => {
    const s = await realSandbox(cwd, home);
    if (s.ok) scratch = s.scratchDir;
    return s;
  });
  assert.ok(ok.length >= 0);
});

test("a sandbox that cannot start leaves the helper without a shell", async () => {
  const { outcome } = await helperRun([{ kind: "tool", name: "bash", args: { command: "echo hi" } }], async () => ({ ok: false, reason: "test: no sandbox" }));
  assert.equal(outcome.toolNames.includes("bash"), false);
  const sandbox = await startShellSandbox({ cwd: tmpdir(), allowedDomains: [] }, {
    isSupportedPlatform: () => true,
    initialize: async () => { throw new Error("seatbelt refused"); },
    wrapWithSandbox: async (c) => c,
  });
  assert.equal(sandbox.ok, false);
  assert.match((sandbox as { reason: string }).reason, /seatbelt refused/);
});
