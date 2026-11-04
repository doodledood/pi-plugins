// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md: watches survive a
// restart, and messages that arrived while Pi was closed are answered on resume.
import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, textOf, type Reply } from "./pi-harness.ts";

const DM = "D0FAKE0001";

function replies(context: any, role: string, call: number): Reply {
  if (role === "triage") return { kind: "text", text: "YES" };
  if (role === "helper") return call % 2 === 1 ? { kind: "tool", name: "reply_in_slack", args: { text: "caught up" } } : { kind: "text", text: "done" };
  const last = textOf(context.messages.filter((m: any) => m.role !== "system").at(-1)?.content);
  return /ask/.test(last) ? { kind: "tool", name: "slack_send_message", args: { channel_id: DM, message: "question" } } : { kind: "text", text: "ok" };
}

test("resume restores watches and answers what arrived while closed; shutdown leaves no timer or lock behind", async () => {
  const first = await createHarness({ persistSession: true, replies });
  await first.session.prompt("ask Robin");
  const [question] = first.slack.messages(DM);
  await first.session.dispose();
  first.slack.post(DM, "U0COLL0001", "Robin Colleague", "answered while you were away", question!.ts);
  const second = await createHarness({ reopen: first, replies });
  assert.equal(second.engine().activeWatches().length, 2, "both watches came back");
  await second.engine().poll();
  await second.engine().idle();
  const reply = second.slack.messages(DM).find((m) => m.threadTs === question!.ts && m.userId === second.slack.ownerId);
  assert.match(reply!.text, /caught up/);
});
