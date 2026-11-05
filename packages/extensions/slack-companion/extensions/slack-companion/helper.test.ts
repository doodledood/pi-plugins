// The helper's whole runtime, built in a real fork whose parent has a foreign extension and the
// adapter's `mcp` proxy installed. Holds docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md
// (no extension, allowlisted tools), docs/adr/20261104-sandbox-the-slack-helpers-shell.md and
// docs/adr/20261104-close-the-home-folder-to-the-slack-helper.md.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { forkEntriesForChild } from "./fork.ts";
import { HelperAbortedError, MAX_HELPER_TURNS } from "./helper.ts";
import type { Context } from "@earendil-works/pi-ai";
import { systemText, textOf, type Reply } from "./pi-harness.ts";
import { fakeHome, helperRun, realSandbox } from "./helper-fixtures.ts";
import { startShellSandbox } from "./sandbox.ts";

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

