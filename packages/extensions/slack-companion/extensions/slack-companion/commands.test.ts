// The owner's controls and the setups the package must explain rather than fail in.
// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md (stopping, /slack off).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createHarness, textOf, type Reply } from "./pi-harness.ts";
import { WATCH_TOOL } from "./index.ts";

const DM = "D0FAKE0001";
const COLLEAGUE = { id: "U0COLL0001", name: "Robin Colleague" };

function replies(script: Record<string, Reply> = {}) {
  return (context: any, role: string): Reply => {
    if (role === "triage") return { kind: "text", text: "YES" };
    if (role === "helper") return { kind: "text", text: "silent" };
    const last = textOf(context.messages.filter((m: any) => m.role !== "system").at(-1)?.content);
    for (const [pattern, reply] of Object.entries(script)) if (last.includes(pattern) && !context.messages.some((m: any) => m.role === "toolResult" && context.messages.indexOf(m) > context.messages.indexOf(context.messages.filter((x: any) => x.role === "user").at(-1)))) return reply;
    return { kind: "text", text: "ok" };
  };
}

const ask = { "ask Robin": { kind: "tool", name: "slack_send_message", args: { channel_id: DM, message: "question" } } as Reply };

test("/slack stop ends every watch; /slack off stops new watches; /slack <link> attaches", async () => {
  const h = await createHarness({ replies: replies(ask) });
  await h.session.prompt("ask Robin please");
  assert.equal(h.engine().liveWatches().length, 2);
  await h.session.prompt("/slack stop");
  assert.equal(h.engine().liveWatches().length, 0);
  assert.ok(h.notices.some((n) => /Stopped watching every Slack conversation/.test(n.text)));
  await h.session.prompt("/slack off");
  await h.session.prompt("ask Robin again");
  assert.equal(h.engine().liveWatches().length, 0, "sends no longer start watches");
  const root = h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "it still doesn't work for me");
  await h.session.prompt(`/slack https://ws.slack.com/archives/${DM}/p${root.ts.replace(".", "")}`);
  await h.engine().idle();
  assert.ok(h.engine().watch(`${DM}/${root.ts}`));
  assert.ok(h.notices.some((n) => /Watching the conversation with Robin Colleague/.test(n.text)));
});

test("/slack on turns a disabled package on, writing only `enabled` into the config", async () => {
  const h = await createHarness({ enabled: false, config: { marker: ">>" }, replies: replies(ask) });
  await h.session.prompt("/slack on");
  const saved = JSON.parse(readFileSync(join(h.agentDir, "slack-companion.json"), "utf8"));
  assert.deepEqual(saved, { enabled: true, marker: ">>" });
  await h.session.prompt("ask Robin please");
  assert.equal(h.engine().liveWatches().length, 2);
  assert.match(h.slack.messages(DM)[0]!.text, /^>> /);
});

test("the model-callable tool watches a conversation by link and stops it", async () => {
  const root = { ts: "" };
  const h = await createHarness({
    replies: (context: any, role) => {
      if (role !== "main") return { kind: "text", text: "YES" };
      const last = textOf(context.messages.filter((m: any) => m.role !== "system").at(-1)?.content);
      const link = `https://ws.slack.com/archives/${DM}/p${root.ts.replace(".", "")}`;
      if (/handle this thread/.test(last)) return { kind: "tool", name: WATCH_TOOL, args: { action: "watch", link } };
      if (/stop that thread/.test(last)) return { kind: "tool", name: WATCH_TOOL, args: { action: "stop", link } };
      return { kind: "text", text: "ok" };
    },
  });
  root.ts = h.slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "bug report").ts;
  await h.session.prompt("handle this thread");
  await h.engine().idle();
  assert.equal(h.engine().watch(`${DM}/${root.ts}`)?.status, "active");
  await h.session.prompt("stop that thread");
  assert.equal(h.engine().watch(`${DM}/${root.ts}`)?.status, "stopped");
  // Stopped: the model-callable tool may not restart it (a hand-off could steer main to); the owner may.
  await h.session.prompt("handle this thread");
  assert.equal(h.engine().watch(`${DM}/${root.ts}`)?.status, "stopped");
  const refusal = h.calls.filter((c) => c.role === "main").at(-1)!.context.messages.filter((m: any) => m.role === "toolResult").at(-1) as any;
  assert.match(textOf(refusal.content), /Only the owner can watch it again/);
  await h.session.prompt(`/slack https://ws.slack.com/archives/${DM}/p${root.ts.replace(".", "")}`);
  assert.equal(h.engine().watch(`${DM}/${root.ts}`)?.status, "active");
});

test("without pi-mcp-adapter the package loads, says why it cannot watch, and touches no send", async () => {
  const h = await createHarness({ noAdapter: true, replies: replies() });
  assert.ok(h.notices.some((n) => n.level === "error" && /pi-mcp-adapter is not installed/.test(n.text)));
  await h.session.prompt("/slack https://ws.slack.com/archives/D0FAKE0001/p1793700001000001");
  assert.ok(h.notices.some((n) => /cannot watch: pi-mcp-adapter is not installed/.test(n.text)));
  assert.equal(h.engine().liveWatches().length, 0);
});

test("a broken config leaves the package off and names the problem", async () => {
  const h = await createHarness({ rawConfig: '{"enabled": true, "pollSecond": 5}', replies: replies(ask) });
  assert.ok(h.notices.some((n) => /unknown config key "pollSecond"/.test(n.text)));
  await h.session.prompt("ask Robin please");
  assert.equal(h.engine().liveWatches().length, 0);
  assert.equal(h.slack.messages(DM)[0]!.text.startsWith("🤖"), false);
});

test("a misnamed Slack tool is named at start, with where to fix it, and nothing is watched", async () => {
  const h = await createHarness({ config: { tools: { readThread: "slack_read_thred" } }, replies: replies(ask) });
  assert.ok(h.notices.some((n) => n.level === "error" && /"slack_read_thred" is not among your Slack server's MCP tools; set the right name under "tools"/.test(n.text)));
  await h.session.prompt("ask Robin please");
  assert.equal(h.engine().liveWatches().length, 0);
  assert.equal(h.slack.messages(DM)[0]!.text.startsWith("🤖"), false, "a send is not marked when nothing can watch it");
});
