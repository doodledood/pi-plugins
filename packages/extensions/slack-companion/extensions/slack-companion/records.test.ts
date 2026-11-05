// Holds docs/adr/20261104-run-slack-helpers-in-memory.md: a finished helper leaves a thin record
// of only its own entries, linked to the parent, and every paid call is counted.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SessionTreeScanner } from "../../../simple-statusline/extensions/simple-statusline/session-cost.ts";
import { createHarness, textOf, type Reply } from "./pi-harness.ts";
import { COST_RECORD_TYPE, helperRecordDir, ORPHAN_AGE_MS, pruneOrphanRecords } from "./records.ts";

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

test("only a deleted session's old records are removed; live, new, current and foreign folders stay", () => {
  const sessions = mkdtempSync(join(tmpdir(), "sessions-"));
  const now = Date.now();
  const record = (name: string, parent: string, ageMs: number) => {
    const dir = join(sessions, name, "slack-companion");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "r.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", parentSession: join(sessions, `${parent}.jsonl`) })}\n`);
    utimesSync(path, (now - ageMs) / 1000, (now - ageMs) / 1000);
  };
  const live = join(sessions, "live.jsonl");
  writeFileSync(live, "{}\n");
  record("live", "live", 2 * ORPHAN_AGE_MS);
  record("gone", "gone", 2 * ORPHAN_AGE_MS);
  record("gone-new", "gone-new", 1000); // not yet a day old: perhaps a session not written yet
  record("gone-shared", "gone-shared", 2 * ORPHAN_AGE_MS);
  mkdirSync(join(sessions, "gone-shared", "tasks"), { recursive: true });
  mkdirSync(join(sessions, "extensions", "slack-companion"), { recursive: true });
  writeFileSync(join(sessions, "extensions", "slack-companion", "index.ts"), "code"); // not records at all
  record("current", "current", 2 * ORPHAN_AGE_MS); // the running session, its file not written yet
  record("borrowed", "someone-else", 2 * ORPHAN_AGE_MS); // records naming another session: not this folder's
  mkdirSync(join(sessions, "odd", "slack-companion"), { recursive: true });
  writeFileSync(join(sessions, "odd", "slack-companion", "r.jsonl"), "null\n"); // valid JSON, not a header
  utimesSync(join(sessions, "odd", "slack-companion", "r.jsonl"), (now - 2 * ORPHAN_AGE_MS) / 1000, (now - 2 * ORPHAN_AGE_MS) / 1000);
  mkdirSync(join(sessions, "notes", "slack-companion"), { recursive: true });
  writeFileSync(join(sessions, "notes", "slack-companion", "log.jsonl"), `${JSON.stringify({ type: "note" })}\n`); // jsonl, but not a record
  utimesSync(join(sessions, "notes", "slack-companion", "log.jsonl"), (now - 2 * ORPHAN_AGE_MS) / 1000, (now - 2 * ORPHAN_AGE_MS) / 1000);
  assert.equal(pruneOrphanRecords(join(sessions, "current.jsonl"), now), 2);
  assert.ok(existsSync(join(sessions, "live", "slack-companion")), "a live session keeps its records");
  assert.ok(existsSync(join(sessions, "gone-new", "slack-companion")), "recent records stay");
  assert.ok(existsSync(join(sessions, "current", "slack-companion")), "the current session's records stay");
  assert.ok(existsSync(join(sessions, "borrowed", "slack-companion")), "records of another session stay");
  assert.ok(existsSync(join(sessions, "odd", "slack-companion")), "a file that is not a record header stays, and nothing throws");
  assert.ok(existsSync(join(sessions, "notes", "slack-companion", "log.jsonl")), "a jsonl that is not a record stays");
  assert.ok(existsSync(join(sessions, "extensions", "slack-companion", "index.ts")), "a folder that is not records stays");
  assert.equal(existsSync(join(sessions, "gone")), false, "an emptied folder goes");
  assert.ok(existsSync(join(sessions, "gone-shared", "tasks")), "another extension's data stays");
});

test("starting a session removes the records of sessions deleted since", async () => {
  const first = await createHarness({ persistSession: true, replies });
  await first.session.prompt("ask Robin");
  const sessionsDir = dirname(first.session.sessionManager.getSessionFile()!);
  const old = join(sessionsDir, "deleted-session", "slack-companion", "r.jsonl");
  mkdirSync(dirname(old), { recursive: true });
  writeFileSync(old, `${JSON.stringify({ type: "session", parentSession: join(sessionsDir, "deleted-session.jsonl") })}\n`);
  utimesSync(old, (Date.now() - 2 * ORPHAN_AGE_MS) / 1000, (Date.now() - 2 * ORPHAN_AGE_MS) / 1000);
  await first.session.dispose();
  const off = await createHarness({ reopen: first, replies, enabled: false });
  assert.ok(existsSync(old), "a package that is off removes nothing");
  await off.session.dispose();
  await createHarness({ reopen: first, replies });
  assert.equal(existsSync(join(sessionsDir, "deleted-session")), false);
});
