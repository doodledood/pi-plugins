// The package's production wiring in a real Pi session: what it gives sandbox-runtime and the
// helper's file tools, what counts as owner input, its poll timer, and how it marks main's sends.
// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (the policy the real path builds),
// docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md (only the owner's own
// input resets the send count), docs/adr/20261104-start-watching-when-the-session-messages-someone.md and
// docs/adr/20261104-keep-the-owners-own-slack-out-of-the-helpers-reach.md (the helper's real MCP reach),
// docs/adr/20261104-give-the-slack-helper-no-shell-on-linux-for-now.md (told once on Linux) and
// docs/adr/20261104-close-the-home-folder-to-the-slack-helper.md (the closed home, as wired).
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { applyPanelAction } from "./index.ts";
import { canonicalPath } from "./secrets.ts";
import { createHarness, textOf, type Reply, type Role } from "./pi-harness.ts";

const DM = "D0FAKE0001";
const COLLEAGUE = { id: "U0COLL0001", name: "Robin Colleague" };

function script(message: string, helper: (context: Context, call: number) => Reply) {
  return (context: Context, role: Role, call: number): Reply => {
    if (role === "triage") return { kind: "text", text: "YES" };
    if (role === "helper") return helper(context, call);
    const last = textOf((context.messages.filter((m: any) => m.role !== "system").at(-1) as any)?.content);
    if (/ask Robin/.test(last)) return { kind: "tool", name: "slack_send_message", args: { channel_id: DM, message } };
    return { kind: "text", text: "ok" };
  };
}

test("the real helper path builds its sandbox and file guards for the owner's home and configured domains", async () => {
  let keyPath = "";
  const h = await createHarness({
    config: { allowedDomains: ["docs.example.org"], readableFolders: ["~/shared-notes"] },
    replies: script("question", (_c, call) => (call === 1 ? { kind: "tool", name: "read", args: { path: keyPath } } : call === 2 ? { kind: "tool", name: "read", args: { path: join(h.home, "shared-notes", "plan.md") } } : { kind: "text", text: "done" })),
  });
  mkdirSync(join(h.home, ".ssh"), { recursive: true });
  // A file only its folder makes secret (its name alone would not), so the home in the policy matters.
  keyPath = join(h.home, ".ssh", "config");
  writeFileSync(keyPath, "PRIVATE-KEY-CONTENT");
  mkdirSync(join(h.home, "shared-notes"), { recursive: true });
  writeFileSync(join(h.home, "shared-notes", "plan.md"), "SHARED-PLAN");
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "can you check your key?", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  const policy = h.sandboxConfigs.at(-1)!;
  assert.ok(policy.filesystem.denyRead.includes(join(h.home, ".ssh")), "the shell may not read the home's ~/.ssh");
  assert.ok(policy.filesystem.denyRead.includes(`${h.home}/**/.env*`));
  assert.ok(policy.filesystem.denyRead.includes(h.agentDir), "Pi's agent folder is closed to the shell");
  assert.ok(policy.filesystem.denyRead.includes(h.home), "the home folder is closed to the shell");
  const allowed = policy.filesystem.allowRead ?? [];
  for (const open of [canonicalPath(h.workspace), canonicalPath(join(h.home, "shared-notes")), join(h.agentDir, "bin"), join(h.home, ".nvm"), join(h.home, ".gitconfig")]) {
    assert.ok(allowed.includes(open), `${open} is opened back`);
  }
  assert.deepEqual(policy.network.allowedDomains, ["docs.example.org"]);
  const helperCalls = h.calls.filter((c) => c.role === "helper");
  const readResult = helperCalls.at(-1)!.context.messages.find((m: any) => m.role === "toolResult" && m.toolName === "read") as any;
  assert.match(textOf(readResult.content), /not open to the Slack helper/);
  assert.ok(JSON.stringify(helperCalls.map((c) => c.context)).includes("SHARED-PLAN"), "a folder the owner opened is readable by the file tools");
  assert.equal(JSON.stringify(helperCalls.map((c) => c.context)).includes("PRIVATE-KEY-CONTENT"), false);
});

test("only the owner's own typing or panel keys reset the send count; input another extension sends does not", async () => {
  const h = await createHarness({
    config: { pauseAfterSends: 1 },
    replies: script("question", (context) => ((context.messages.at(-1) as any)?.role === "toolResult" ? { kind: "text", text: "done" } : { kind: "tool", name: "reply_in_slack", args: { text: "answer" } })),
  });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  const key = `${DM}/${question!.ts}`;
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "1", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  assert.equal(h.engine().watch(key)!.status, "paused");
  await h.session.prompt("an extension's message", { source: "extension" });
  assert.equal(h.engine().watch(key)!.status, "paused", "not owner input");
  await h.session.prompt("the owner types");
  assert.equal(h.engine().watch(key)!.status, "active");
  h.engine().watch(key)!.sendsWithoutOwner = 1;
  await applyPanelAction(h.engine(), { kind: "stop", key: `${DM}/top` });
  assert.equal(h.engine().watch(key)!.sendsWithoutOwner, 0, "a panel key is owner input");
});

test("the poll timer starts once, and a reload stops the old one", async () => {
  const h = await createHarness({ replies: script("q", () => ({ kind: "text", text: "done" })) });
  const [first] = h.runningTimers();
  assert.equal(h.runningTimers().length, 1);
  await h.session.reload();
  assert.equal(h.runningTimers().includes(first!), false, "the retired session's timer is stopped");
  assert.ok(h.runningTimers().length <= 1);
});

test("main's own message is sent whole, and gets the agent line even if it already starts with the marker", async () => {
  const long = `🤖 ${"word ".repeat(900)}end`;
  const h = await createHarness({ replies: script(long, () => ({ kind: "text", text: "done" })) });
  await h.session.prompt("ask Robin");
  const [sent] = h.slack.messages(DM);
  assert.match(sent!.text, /^🤖 \*\*Dana Owner's agent\*\*/);
  assert.equal((sent!.text.match(/🤖/g) ?? []).length, 1, "one marker");
  assert.match(sent!.text, /end\n\*Sent using\*/, "not cut");
  assert.equal(sent!.text.includes("(cut;"), false);
});

function triageScript(triage: Reply) {
  return (context: Context, role: Role, call: number): Reply => {
    if (role === "triage") return triage;
    return script("question", (c) => ((c.messages.at(-1) as any)?.role === "toolResult" ? { kind: "text", text: "done" } : { kind: "tool", name: "reply_in_slack", args: { text: "answer" } }))(context, role, call);
  };
}

async function oneReply(triage: Reply, config: Record<string, unknown> = {}) {
  const h = await createHarness({ config, replies: triageScript(triage) });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "thanks!", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  return { h, key: `${DM}/${question!.ts}` };
}

test("the real triage call: NO stays silent, a failed call stops the watch loudly, a configured model is used", async () => {
  const silent = await oneReply({ kind: "text", text: "NO" });
  assert.equal(silent.h.calls.filter((c) => c.role === "helper").length, 0, "no helper for NO");
  assert.match(silent.h.engine().watch(silent.key)!.lastNote!, /stayed silent/);
  const failed = await oneReply({ kind: "error", message: "quota exceeded" });
  assert.equal(failed.h.engine().watch(failed.key)!.status, "error");
  assert.match(failed.h.engine().watch(failed.key)!.reason!, /triage model failed: quota exceeded/);
  const cheapest = await oneReply({ kind: "text", text: "YES" });
  assert.deepEqual(cheapest.h.calls.filter((c) => c.role === "triage").map((c) => c.model), ["scripted-slack/cheap"], "by default the cheapest priced model");
  assert.ok(cheapest.h.calls.filter((c) => c.role === "helper").every((c) => c.model === "scripted-slack/det"), "the helper runs on the session's model");
  const configured = await oneReply({ kind: "text", text: "YES" }, { triageModel: "scripted-slack/det" });
  assert.deepEqual(configured.h.calls.filter((c) => c.role === "triage").map((c) => c.model), ["scripted-slack/det"], "a configured model wins");
});

test("the real helper gets read-only tools and the owner's listed ones; never the send tool, nor his own Slack unless listed", async () => {
  const h = await createHarness({
    config: { investigativeTools: ["slack_send_message", "data/data_write"] },
    replies: script("question", (_c, call) => (call === 1 ? { kind: "tool", name: "call_read_only_tool", args: { tool: "slack_send_message", arguments: { channel_id: DM, message: "x" } } } : { kind: "text", text: "done" })),
  });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "hello", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  const names = h.calls.find((c) => c.role === "helper")!.tools;
  for (const name of ["data_lookup", "data_write"]) assert.ok(names.includes(name), name);
  for (const name of ["slack_send_message", "slack_read_thread", "slack_read_channel", "search_read_only_tools", "call_read_only_tool"]) {
    assert.equal(names.includes(name), false, `${name}: the send tool never; the owner's own Slack only when he lists it`);
  }
  const result = h.calls.filter((c) => c.role === "helper").at(-1)!.context.messages.filter((m: any) => m.role === "toolResult").at(-1) as any;
  assert.equal(result.toolName, "call_read_only_tool");
  assert.equal(result.isError, true, "the call had nothing to reach");
  assert.equal(h.slack.messages(DM).filter((m) => m.userId === h.slack.ownerId).length, 1, "only main's question was ever posted as the owner");

});

test("startup says what it could not do: an unreadable tool cache, and saved watches from another version", async () => {
  const broken = await createHarness({ mcpCacheText: "{", replies: script("q", () => ({ kind: "text", text: "done" })) });
  assert.ok(broken.notices.some((n) => n.level === "error" && /tool cache could not be read/.test(n.text)));
  assert.equal(broken.engine().liveWatches().length, 0);
  const first = await createHarness({ persistSession: true, replies: script("question", () => ({ kind: "text", text: "done" })) });
  await first.session.prompt("ask Robin");
  const old = (first.session.sessionManager.getBranch() as any[]).filter((e) => e.type === "custom" && e.customType === "slack-companion-state").at(-1);
  first.session.sessionManager.appendCustomEntry("slack-companion-state", { ...old.data, version: 1 });
  await first.session.dispose();
  const second = await createHarness({ reopen: first, replies: script("q", () => ({ kind: "text", text: "done" })) });
  assert.ok(second.notices.some((n) => /came from another version of the package and were not restored/.test(n.text)));
  assert.equal(second.engine().liveWatches().length, 0);
});

test("a session that ends releases its locks", async () => {
  const h = await createHarness({ replies: script("question", () => ({ kind: "text", text: "done" })) });
  await h.session.prompt("ask Robin");
  const locks = join(h.agentDir, "slack-companion", "locks");
  assert.ok(readdirSync(locks).length > 0);
  writeFileSync(join(h.agentDir, "slack-companion.json"), JSON.stringify({ enabled: false }));
  await h.session.reload(); // the old session's runtime shuts down; the new one, disabled, takes nothing
  for (const folder of readdirSync(locks)) {
    for (const file of readdirSync(join(locks, folder))) assert.equal(JSON.parse(readFileSync(join(locks, folder, file), "utf8")).released, true, `${folder}/${file} is let go`);
  }
});

test("the panel opened through Pi fits the overlay it asks for, gates approval on reading, and records seen stops", async () => {
  const long = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`).join("\n");
  const h = await createHarness({
    ui: { rows: 20 },
    replies: script("question", (c) => ((c.messages.at(-1) as any)?.role === "toolResult" ? { kind: "text", text: "done" } : { kind: "tool", name: "hand_off_to_main", args: { kind: "action", text: long } })),
  });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "please migrate", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  assert.equal(h.engine().pendingApprovals().length, 1);
  const closed = h.session.prompt("/slack");
  while (!h.opened.length) await new Promise((r) => setTimeout(r, 5));
  const { component, options, close } = h.opened[0]!;
  try {
    assert.equal(options.overlayOptions.maxHeight, "80%");
    assert.ok(component.render(80).length <= Math.floor(20 * 0.8), "no row the overlay would cut");
    component.handleInput("a");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(h.engine().pendingApprovals().length, 1, "not approvable before the end was shown");
    for (let i = 0; i < 20 && !component.render(80).join("\n").includes("(end of this item)"); i += 1) component.handleInput(" ");
    assert.match(component.render(80).join("\n"), /Step 40: migrate shard 40\./);
    component.handleInput("a");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.engine().pendingApprovals().length, 0, "approved once read");
    // A stop with an error, rendered in the panel, is recorded as seen in the saved state.
    h.slack.failures.set("slack_read_thread", ["garbage"]);
    await h.engine().poll();
    const stopped = h.engine().snapshot().watches.find((w) => w.status === "error")!;
    for (let i = 0; i < 10; i += 1) component.handleInput("\u001b[B");
    component.render(80);
    const saved = (h.session.sessionManager.getBranch() as any[]).filter((e) => e.type === "custom" && e.customType === "slack-companion-state").at(-1).data;
    assert.ok(saved.seenErrors.includes(`${stopped.key}@${stopped.endedAt}`), "seen, and saved");
  } finally {
    close();
    await closed;
  }
});

test("a stop the owner has seen stays quiet on the line after a restart; an unseen one is still shown", async () => {
  const replies = script("question", () => ({ kind: "text", text: "noted" }));
  const first = await createHarness({ ui: { rows: 30 }, persistSession: true, replies });
  await first.session.prompt("ask Robin");
  const [question] = first.slack.messages(DM);
  first.slack.failures.set("slack_read_thread", ["garbage"]);
  first.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "hi", question!.ts);
  await first.engine().poll();
  assert.match(first.line(120).join(""), /stopped/, "an unseen stop shows on the line");
  await first.session.dispose();
  const unseen = await createHarness({ ui: { rows: 30 }, reopen: first, replies });
  assert.match(unseen.line(120).join(""), /stopped/, "still shown after a restart while unseen");
  const closed = unseen.session.prompt("/slack");
  while (!unseen.opened.length) await new Promise((r) => setTimeout(r, 5));
  unseen.opened[0]!.component.render(80);
  unseen.opened[0]!.close();
  await closed;
  await unseen.session.dispose();
  const seen = await createHarness({ ui: { rows: 30 }, reopen: unseen, replies });
  assert.doesNotMatch(seen.line(120).join(""), /stopped/, "seen before the restart: quiet after it");
});

test("an information hand-off steers main while it is busy, and main stays usable while a request waits", async () => {
  let release!: () => void;
  const dataGate = new Promise<void>((r) => (release = r));
  const h = await createHarness({
    dataGate,
    replies: (context: Context, role: Role): Reply => {
      if (role === "triage") return { kind: "text", text: "YES" };
      if (role === "helper") return (context.messages.at(-1) as any)?.role === "toolResult" ? { kind: "text", text: "done" } : { kind: "tool", name: "hand_off_to_main", args: { kind: "info", text: "Robin: staging is fine" } };
      const last = context.messages.filter((m: any) => m.role !== "system").at(-1) as any;
      if (/ask Robin/.test(textOf(last?.content))) return { kind: "tool", name: "slack_send_message", args: { channel_id: DM, message: "question" } };
      if (/look it up/.test(textOf(last?.content))) return { kind: "tool", name: "data_lookup", args: { q: "x" } };
      return { kind: "text", text: "ok" };
    },
  });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  const busy = h.session.prompt("look it up"); // main waits on the data tool
  while (!h.dataCalls.length) await new Promise((r) => setTimeout(r, 5));
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "staging is fine", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  release();
  await busy;
  await h.session.agent.waitForIdle?.();
  const afterTool = h.calls.filter((c) => c.role === "main").find((c) => c.context.messages.some((m: any) => m.role === "toolResult" && m.toolName === "data_lookup"))!;
  assert.ok(afterTool.context.messages.some((m: any) => /\[Slack hand-off\][\s\S]*staging is fine/.test(textOf(m.content))), "the hand-off reached main within its running turn");
  // A request now waits for the owner; main keeps working meanwhile.
  h.engine()["state"].approvals.push({ id: "w1", watchKey: `${DM}/${question!.ts}`, label: "Robin Colleague (DM)", requester: "Robin Colleague", text: "merge it", at: 0, status: "pending" });
  assert.equal(h.engine().pendingApprovals().length, 1);
  const before = h.calls.filter((c) => c.role === "main").length;
  await h.session.prompt("anything else?");
  assert.equal(h.calls.filter((c) => c.role === "main").length, before + 1, "main answers while a request waits");
  assert.equal(h.engine().pendingApprovals().length, 1, "and the request still waits for the owner");
});

test("every notice reaches the owner without control codes, whatever text it quotes", async () => {
  const h = await createHarness({ ui: { rows: 30 }, replies: script("question", (c) => ((c.messages.at(-1) as any)?.role === "toolResult" ? { kind: "text", text: "done" } : { kind: "tool", name: "reply_in_slack", args: { text: "on it" } })) });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "hi", question!.ts);
  h.slack.failures.set("slack_send_message", ["ansi-error"]);
  await h.engine().poll();
  await h.engine().idle();
  await h.engine().poll();
  assert.ok(h.notices.length > 0, "the failed send was reported");
  for (const { text } of h.notices) assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f\u009b]/.test(text), false, JSON.stringify(text));
});

test("a server that drives the owner's browser is private: its read-only tools reach no helper unless listed", async () => {
  const run = async (config: Record<string, unknown>) => {
    const h = await createHarness({
      config,
      replies: script("question", (c) => {
        const last = c.messages.at(-1) as any;
        return last?.role === "toolResult" ? { kind: "text", text: "done" } : { kind: "tool", name: "search_read_only_tools", args: { query: "network" } };
      }),
    });
    await h.session.prompt("ask Robin");
    const [question] = h.slack.messages(DM);
    h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "what did the browser load?", question!.ts);
    await h.engine().poll();
    await h.engine().idle();
    const helperCalls = h.calls.filter((c) => c.role === "helper");
    const found = textOf((helperCalls.at(-1)!.context.messages.at(-1) as any).content);
    return { found, direct: helperCalls[0]!.tools };
  };
  const hidden = await run({});
  assert.doesNotMatch(hidden.found, /list_network_requests/);
  assert.equal(hidden.direct.includes("list_network_requests"), false);
  const listed = await run({ investigativeTools: ["chrome-devtools/list_network_requests"] });
  assert.ok(listed.direct.includes("list_network_requests") || /list_network_requests/.test(listed.found), "listed by the owner: reachable");
  const added = await run({ privateServers: ["mail"] });
  assert.doesNotMatch(added.found, /list_network_requests/, "adding a private server keeps the browser servers private");
  assert.equal(added.direct.includes("list_network_requests"), false);
});

test("on Linux the owner is told once that the helper has no shell, and the file tools still guard secrets", async () => {
  let keyPath = "";
  const h = await createHarness({
    platform: "linux",
    replies: script("question", (_c, call) => (call % 2 === 1 ? { kind: "tool", name: "read", args: { path: keyPath } } : { kind: "text", text: "done" })),
  });
  mkdirSync(join(h.home, ".ssh"), { recursive: true });
  keyPath = join(h.home, ".ssh", "id_ed25519");
  writeFileSync(keyPath, "PRIVATE-KEY-CONTENT");
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  for (const text of ["first", "second"]) {
    h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, text, question!.ts);
    await h.engine().poll();
    await h.engine().idle();
  }
  const helperRuns = h.calls.filter((c) => c.role === "helper");
  assert.ok(helperRuns.length >= 2, "two helper runs");
  assert.equal(helperRuns.some((c) => c.tools.includes("bash")), false, "no shell on Linux");
  assert.equal(h.sandboxConfigs.length, 0, "no sandbox is configured");
  assert.equal(h.notices.filter((n) => /runs without a shell: on Linux/.test(n.text)).length, 1, "said once, not per run");
  const reads = helperRuns.map((c) => JSON.stringify(c.context.messages)).join("");
  assert.equal(reads.includes("PRIVATE-KEY-CONTENT"), false, "the file tools still deny secrets");
});

test("through the real send path, a fresh DM is named by the words main wrote, never by the package's agent line", async () => {
  for (const marker of ["🤖", ""]) {
    const h = await createHarness({
      ui: { rows: 30 },
      config: { marker },
      replies: (context: Context, role: Role) => {
        if (role !== "main") return { kind: "text", text: "ok" };
        const last = textOf((context.messages.filter((m: any) => m.role !== "system").at(-1) as any)?.content);
        if (/ask Robin/.test(last)) return { kind: "tool", name: "slack_send_message", args: { channel_id: DM, message: "Which build should I ship today?" } };
        if (/ask Sam/.test(last)) return { kind: "tool", name: "slack_send_message", args: { channel_id: "D0FAKE0003", message: "Can you review the eval change?" } };
        return { kind: "text", text: "ok" };
      },
    });
    await h.session.prompt("ask Robin");
    await h.session.prompt("ask Sam");
    const [line] = h.line(160);
    assert.match(line!, /DM "Which build sho…"/, `marker ${JSON.stringify(marker)}: ${line}`);
    assert.match(line!, /DM "Can you review…"/, "two fresh DMs read apart");
    assert.doesNotMatch(line!, /agent\*\*|Dana Owner/, "the package's agent line is not the name");
  }
});

test("in a real session, the session's own post, agent posts, a reaction and a repeated read wake no model; a real reply does", async () => {
  const h = await createHarness({ replies: script("question", () => ({ kind: "text", text: "done" })) });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  const models = () => h.calls.filter((c) => c.role === "triage" || c.role === "helper").length;
  h.slack.post(DM, h.slack.ownerId, h.slack.ownerName, "from another of my agents\n*Sent using* <@A0FAKEAPP|Slack MCP>", question!.ts);
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "from Robin's agent\n*Sent using* <@A0FAKEAPP|Slack MCP>", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  h.slack.messages(DM).at(-1)!.text += " :thumbsup:"; // a reaction changes nothing that matters
  await h.engine().poll();
  await h.engine().poll();
  await h.engine().idle();
  assert.equal(models(), 0, "no model woke");
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "a real question", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  assert.equal(h.calls.filter((c) => c.role === "triage").length, 1, "a real reply is judged once");
});

test("a session start removes lock folders released more than a day ago", async () => {
  const first = await createHarness({ persistSession: true, replies: script("question", () => ({ kind: "text", text: "done" })) });
  const locks = join(first.agentDir, "slack-companion", "locks");
  mkdirSync(join(locks, "D0OLD_top"), { recursive: true });
  const marker = join(locks, "D0OLD_top", "2.json");
  writeFileSync(marker, JSON.stringify({ pid: 1, sessionId: "old", released: true }));
  const old = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(marker, old, old);
  await first.session.dispose();
  await createHarness({ reopen: first, replies: script("question", () => ({ kind: "text", text: "done" })) });
  assert.equal(existsSync(join(locks, "D0OLD_top")), false);
});

test("main's own send whose result named no message is read back as this session's: a reply after it is answered", async () => {
  const h = await createHarness({
    replies: (context: Context, role: Role): Reply => {
      if (role === "triage") return { kind: "text", text: "YES" };
      if (role === "helper") return { kind: "tool", name: "reply_in_slack", args: { text: "on it" } };
      const last = textOf((context.messages.filter((m: any) => m.role !== "system").at(-1) as any)?.content);
      if (/ask Robin/.test(last)) return { kind: "tool", name: "slack_send_message", args: { channel_id: DM, message: "question" } };
      if (/follow up/.test(last)) return { kind: "tool", name: "slack_send_message", args: { channel_id: DM, message: "one more thing" } };
      return { kind: "text", text: "ok" };
    },
  });
  await h.session.prompt("ask Robin");
  await h.engine().poll();
  h.slack.failures.set("slack_send_message", ["garbage"]); // it posts, but its result names no message
  await h.session.prompt("follow up");
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "my answer to both");
  await h.engine().poll();
  await h.engine().idle();
  assert.equal(h.notices.some((n) => /after another session's message/.test(n.text)), false, h.notices.map((n) => n.text).join("\n"));
  assert.ok(h.calls.some((c) => c.role === "helper"), "the reply is answered");
});

test("a session start whose lock sweep fails warns and still starts", async () => {
  const first = await createHarness({ persistSession: true, replies: script("question", () => ({ kind: "text", text: "done" })) });
  const locks = join(first.agentDir, "slack-companion", "locks");
  mkdirSync(locks, { recursive: true });
  chmodSync(locks, 0o000); // the sweep cannot list it
  try {
    await first.session.dispose();
    const second = await createHarness({ reopen: first, replies: script("question", () => ({ kind: "text", text: "done" })) });
    if (process.getuid?.() !== 0) assert.ok(second.notices.some((n) => n.level === "warning" && /old lock folders could not be removed/.test(n.text)), second.notices.map((n) => n.text).join("\n"));
  } finally {
    chmodSync(locks, 0o700);
  }
});
