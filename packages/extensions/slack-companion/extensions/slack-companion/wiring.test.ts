// The package's production wiring in a real Pi session: what it gives sandbox-runtime and the
// helper's file tools, what counts as owner input, its poll timer, and how it marks main's sends.
// Holds docs/adr/20261104-sandbox-the-slack-helpers-shell.md (the policy the real path builds),
// docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md (only the owner's own
// input resets the send count) and docs/adr/20261104-start-watching-when-the-session-messages-someone.md.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { applyPanelAction } from "./index.ts";
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
    config: { allowedDomains: ["docs.example.org"] },
    replies: script("question", (_c, call) => (call === 1 ? { kind: "tool", name: "read", args: { path: keyPath } } : { kind: "text", text: "done" })),
  });
  mkdirSync(join(h.home, ".ssh"), { recursive: true });
  // A file only its folder makes secret (its name alone would not), so the home in the policy matters.
  keyPath = join(h.home, ".ssh", "config");
  writeFileSync(keyPath, "PRIVATE-KEY-CONTENT");
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "can you check your key?", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  const policy = h.sandboxConfigs.at(-1)!;
  assert.ok(policy.filesystem.denyRead.includes(join(h.home, ".ssh")), "the shell may not read the home's ~/.ssh");
  assert.ok(policy.filesystem.denyRead.includes(`${h.home}/**/.env`));
  assert.deepEqual(policy.network.allowedDomains, ["docs.example.org"]);
  const helperCalls = h.calls.filter((c) => c.role === "helper");
  const readResult = helperCalls.at(-1)!.context.messages.find((m: any) => m.role === "toolResult" && m.toolName === "read") as any;
  assert.match(textOf(readResult.content), /secret location/);
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
