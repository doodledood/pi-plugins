// Holds docs/adr/20261104-run-slack-helpers-in-memory.md: a finished helper leaves a thin record
// of only its own entries, linked to the parent, and every paid call is counted.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SessionTreeScanner } from "../../../simple-statusline/extensions/simple-statusline/session-cost.ts";
import { createHarness, textOf, type Reply } from "./pi-harness.ts";
import { COST_RECORD_TYPE, helperRecordDir, pruneOrphanRecords } from "./records.ts";

const DM = "D0FAKE0001";

function replies(context: any, role: string, call: number): Reply {
  if (role === "triage") return { kind: "text", text: "YES" };
  if (role === "helper") return call % 2 === 1 ? { kind: "tool", name: "reply_in_slack", args: { text: "answer" } } : { kind: "text", text: "done" };
  const last = textOf(context.messages.filter((m: any) => m.role !== "system").at(-1)?.content);
  return /ask/.test(last) ? { kind: "tool", name: "slack_send_message", args: { channel_id: DM, message: "question" } } : { kind: "text", text: "ok" };
}

test("a helper's record holds only its own entries, links to the parent, and the tree total counts helpers and triage", async () => {
  const h = await createHarness({ persistSession: true, replies });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  h.slack.post(DM, "U0COLL0001", "Robin Colleague", "an answer", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  const sessionFile = h.session.sessionManager.getSessionFile()!;
  const dir = helperRecordDir(sessionFile);
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  const lines = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].type, "session");
  assert.equal(lines[0].parentSession, sessionFile);
  const mainIds = new Set((h.session.sessionManager.getEntries() as any[]).map((e) => e.id));
  assert.ok(lines.slice(1).every((e) => !mainIds.has(e.id)), "no copied parent entry");
  assert.ok(lines.slice(1).some((e) => e.type === "message" && e.message.role === "assistant" && e.message.usage), "the helper's own turns, with usage");
  const costRecords = (h.session.sessionManager.getEntries() as any[]).filter((e) => e.type === "custom" && e.customType === COST_RECORD_TYPE);
  assert.equal(costRecords.length, 1, "the triage call left a cost record");
  const tree = new SessionTreeScanner().scanTree({ ownEntries: h.session.sessionManager.getEntries() as any[], sessionFile, sessionId: h.session.sessionManager.getSessionId() });
  const expected = h.calls.length * 0.003;
  assert.ok(Math.abs(tree.totalCost - expected) < 1e-9, `tree ${tree.totalCost} vs every call ${expected}`);
});

test("a session with no file writes no helper record", async () => {
  const h = await createHarness({ replies });
  await h.session.prompt("ask Robin");
  const [question] = h.slack.messages(DM);
  h.slack.post(DM, "U0COLL0001", "Robin Colleague", "an answer", question!.ts);
  await h.engine().poll();
  await h.engine().idle();
  assert.equal(h.session.sessionManager.getSessionFile(), undefined);
  assert.ok(h.notices.some((n) => /not attributable/.test(n.text)), "the owner is told the spend cannot be attributed");
  for (const dir of [h.workspace, h.agentDir]) {
    assert.equal(readdirSync(dir, { recursive: true }).some((p) => String(p).split("/").includes("slack-companion") && String(p).endsWith(".jsonl")), false, `no helper record under ${dir}`);
  }
});

test("the records of a deleted session are removed at start; others, and anything else beside them, stay", () => {
  const sessions = mkdtempSync(join(tmpdir(), "sessions-"));
  const live = join(sessions, "live.jsonl");
  writeFileSync(live, "{}\n");
  mkdirSync(join(sessions, "live", "slack-companion"), { recursive: true });
  mkdirSync(join(sessions, "gone", "slack-companion"), { recursive: true });
  mkdirSync(join(sessions, "gone-shared", "slack-companion"), { recursive: true });
  mkdirSync(join(sessions, "gone-shared", "tasks"), { recursive: true });
  assert.equal(pruneOrphanRecords(live), 2);
  assert.ok(existsSync(join(sessions, "live", "slack-companion")), "a live session keeps its records");
  assert.equal(existsSync(join(sessions, "gone")), false, "an emptied folder goes");
  assert.ok(existsSync(join(sessions, "gone-shared", "tasks")), "another extension's data stays");
  assert.equal(existsSync(join(sessions, "gone-shared", "slack-companion")), false);
});

test("starting a session removes the records of sessions deleted since", async () => {
  const first = await createHarness({ persistSession: true, replies });
  await first.session.prompt("ask Robin");
  const sessionsDir = dirname(first.session.sessionManager.getSessionFile()!);
  mkdirSync(join(sessionsDir, "deleted-session", "slack-companion"), { recursive: true });
  await first.session.dispose();
  await createHarness({ reopen: first, replies });
  assert.equal(existsSync(join(sessionsDir, "deleted-session")), false);
});
