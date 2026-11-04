// The engine against a fake Slack, with the triage and helper steps scripted.
// Holds docs/adr/20261104-let-the-agent-carry-slack-conversations-on-by-itself.md (speaking
// rules and limits), docs/adr/20261104-start-watching-when-the-session-messages-someone.md
// (starts, stops, routing), docs/adr/20261104-let-slack-input-only-narrow-what-sessions-may-do.md and
// docs/adr/20261104-hold-slack-conversations-in-a-read-only-fork-of-main.md (actions wait for the owner).
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpSlackBackend } from "./backend.ts";
import { DEFAULT_CONFIG, type SlackCompanionConfig } from "./config.ts";
import { Engine, type EngineDeps, type EngineState } from "./engine.ts";
import { FakeSlack, memoryBus } from "./fake-slack.ts";
import type { HelperBatch, HelperOutcome } from "./helper.ts";
import { LockManager } from "./locks.ts";

const DM = "D0FAKE0001";
const CHANNEL = "C0FAKE0002";
const COLLEAGUE = { id: "U0COLL0001", name: "Robin Colleague" };
const OTHER = { id: "U0OTHR0001", name: "Sam Other" };

type HelperScript = (batch: HelperBatch) => Partial<HelperOutcome>;

function makeEngine(slack: FakeSlack, options: {
  helper?: HelperScript;
  speak?: (batch: HelperBatch["messages"]) => boolean;
  config?: Partial<SlackCompanionConfig>;
  lockDir?: string;
  sessionId?: string;
  pid?: number;
  alive?: (pid: number) => boolean;
  now?: () => number;
} = {}) {
  const bus = memoryBus();
  slack.attach(bus);
  const config: SlackCompanionConfig = { ...DEFAULT_CONFIG, enabled: true, ...options.config };
  const log = { info: [] as string[], approved: [] as string[], notices: [] as string[], triage: 0, helpers: [] as HelperBatch[], persisted: [] as EngineState[] };
  const deps: EngineDeps = {
    backend: new McpSlackBackend(bus, config.tools),
    config: () => config,
    now: options.now ?? (() => slack.nowMs()),
    persist: (state) => log.persisted.push(state),
    notify: (_level, text) => log.notices.push(text),
    changed: () => {},
    deliverInfo: ({ text }) => log.info.push(text),
    deliverApproved: ({ approval }) => log.approved.push(approval.text),
    triage: async ({ batch }) => {
      log.triage += 1;
      return { speak: options.speak ? options.speak(batch) : true, usd: 0.001 };
    },
    runHelper: async ({ batch }) => {
      log.helpers.push(batch);
      const scripted = options.helper?.(batch) ?? { reply: { text: `re: ${batch.messages.map((m) => m.text).join(" / ")}`, done: false } };
      return { handoffs: [], ownEntries: [], toolNames: [], usd: 0.01, ...scripted };
    },
    locks: new LockManager(options.lockDir ?? mkdtempSync(join(tmpdir(), "locks-")), { pid: options.pid ?? process.pid, sessionId: options.sessionId ?? "s1" }, options.alive),
  };
  const engine = new Engine(deps);
  return { engine, log, config };
}

async function mainSends(slack: FakeSlack, engine: Engine, channelId: string, text: string, threadTs?: string) {
  const posted = slack.post(channelId, slack.ownerId, slack.ownerName, `${text}\n*Sent using* <@A0FAKEAPP|Slack MCP>`, threadTs);
  await engine.onMainSend({ channelId, ts: posted.ts, ...(threadTs ? { threadTs } : {}) });
  return posted;
}

async function settle(engine: Engine) {
  await engine.poll();
  await engine.idle();
}

const agentPosts = (slack: FakeSlack, channelId: string) => slack.messages(channelId).filter((m) => m.userId === slack.ownerId && m.text.startsWith("🤖"));

test("a reply in a conversation the session started is answered once, in its thread, marked", async () => {
  const slack = new FakeSlack();
  const { engine, log } = makeEngine(slack);
  const question = await mainSends(slack, engine, DM, "🤖 *Dana Owner's agent* …\n\nThree questions");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "1 yes, 2 no", question.ts);
  await settle(engine);
  const replies = agentPosts(slack, DM).filter((m) => m.threadTs === question.ts);
  assert.equal(replies.length, 1);
  assert.match(replies[0]!.text, /^🤖 re: 1 yes, 2 no/);
  assert.ok(!replies[0]!.text.includes("Dana Owner's agent*"), "the agent line was already sent by main's first message");
  await settle(engine);
  assert.equal(log.helpers.length, 1, "nothing is answered twice");
});

test("own posts, other agents' posts and duplicates wake no model; triage NO stays silent but keeps context", async () => {
  const slack = new FakeSlack();
  const { engine, log } = makeEngine(slack, { speak: (batch) => !batch.some((m) => m.text === "thanks!") });
  const question = await mainSends(slack, engine, DM, "question");
  slack.post(DM, slack.ownerId, slack.ownerName, "from another session\n*Sent using* <@A0FAKEAPP|Slack MCP>", question.ts);
  await settle(engine);
  assert.equal(log.triage, 0);
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "thanks!", question.ts);
  await settle(engine);
  assert.equal(log.triage, 1);
  assert.equal(log.helpers.length, 0);
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "what about 3?", question.ts);
  await settle(engine);
  assert.equal(log.helpers.length, 1);
  assert.ok(log.helpers[0]!.context.some((m) => m.text === "thanks!"), "silent messages stay as context");
});

test("a burst becomes one batch and at most one reply; replies wait while a helper runs", async () => {
  const slack = new FakeSlack();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const { engine, log } = makeEngine(slack, {
    helper: (batch) => {
      calls += 1;
      return { reply: { text: `batch of ${batch.messages.length}`, done: false } };
    },
  });
  const question = await mainSends(slack, engine, DM, "q");
  for (const text of ["a", "b", "c"]) slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, text, question.ts);
  // Hold the first helper so new messages arrive while it runs.
  const origRun = (engine as any).deps.runHelper;
  (engine as any).deps.runHelper = async (input: any) => {
    if (calls === 0) await gate;
    return origRun(input);
  };
  await engine.poll();
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "d", question.ts);
  await engine.poll();
  release();
  await engine.idle();
  assert.deepEqual(log.helpers.map((b) => b.messages.map((m) => m.text)), [["a", "b", "c"], ["d"]]);
  assert.equal(agentPosts(slack, DM).filter((m) => m.threadTs === question.ts).length, 2);
});

test("in a channel every reply goes into the thread, and the first one names the owner's agent", async () => {
  const slack = new FakeSlack();
  const { engine } = makeEngine(slack);
  const link = slack.post(CHANNEL, COLLEAGUE.id, COLLEAGUE.name, "it still doesn't work for me");
  await engine.attach({ channelId: CHANNEL, messageTs: link.ts });
  await engine.idle();
  const replies = agentPosts(slack, CHANNEL);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.threadTs, link.ts);
  assert.match(replies[0]!.text, /^🤖 \*Dana Owner's agent\*/);
});

test("attaching hands only the unanswered part to the helper", async () => {
  const slack = new FakeSlack();
  const { engine, log } = makeEngine(slack);
  const root = slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "bug report");
  slack.post(DM, slack.ownerId, slack.ownerName, "looking", root.ts);
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "still broken", root.ts);
  await engine.attach({ channelId: DM, messageTs: root.ts });
  await engine.idle();
  assert.deepEqual(log.helpers[0]!.messages.map((m) => m.text), ["still broken"]);
});

test("after the configured sends without the owner the watch pauses; owner input resets and resumes", async () => {
  const slack = new FakeSlack();
  const { engine, log } = makeEngine(slack, { config: { pauseAfterSends: 2 } });
  const q = await mainSends(slack, engine, DM, "q");
  for (const text of ["1", "2", "3"]) {
    slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, text, q.ts);
    await settle(engine);
  }
  const key = `${DM}/${q.ts}`;
  assert.equal(engine.watch(key)!.status, "paused");
  assert.equal(agentPosts(slack, DM).filter((m) => m.threadTs === q.ts).length, 2);
  assert.ok(log.notices.some((n) => /paused/.test(n)));
  engine.ownerInput();
  await engine.idle();
  assert.equal(engine.watch(key)!.status, "active");
  assert.equal(agentPosts(slack, DM).filter((m) => m.threadTs === q.ts).length, 3, "the waiting message is answered after the owner is back");
});

test("concurrent sends reserve their slot first, so they cannot pass the pause", async () => {
  const slack = new FakeSlack();
  const { engine } = makeEngine(slack, { config: { pauseAfterSends: 1 } });
  const q = await mainSends(slack, engine, DM, "q");
  const watch = engine.watch(`${DM}/${q.ts}`)!;
  const results = await Promise.all([engine.sendTracked(watch, "one"), engine.sendTracked(watch, "two")]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("stop from anyone ends the watch without a model, and a later send does not restart it", async () => {
  const slack = new FakeSlack();
  const { engine, log } = makeEngine(slack);
  const q = await mainSends(slack, engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "  Stop ", q.ts);
  await settle(engine);
  const key = `${DM}/${q.ts}`;
  assert.equal(engine.watch(key)!.status, "stopped");
  assert.equal(log.triage, 0);
  await mainSends(slack, engine, DM, "follow-up", q.ts);
  assert.equal(engine.watch(key)!.status, "stopped", "tombstoned");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "hello?", q.ts);
  await settle(engine);
  assert.equal(log.helpers.length, 0);
});

test("stopping lifts nothing, revokes sending, and denies the conversation's pending approvals", async () => {
  const slack = new FakeSlack();
  const { engine } = makeEngine(slack, { helper: () => ({ handoffs: [{ kind: "action", text: "drop the old table" }] }) });
  const q = await mainSends(slack, engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "please drop it", q.ts);
  await settle(engine);
  assert.equal(engine.pendingApprovals().length, 1);
  const key = `${DM}/${q.ts}`;
  engine.stop(key);
  assert.equal(engine.pendingApprovals().length, 0);
  assert.equal(await engine.sendTracked(engine.watch(key)!, "anything"), false);
});

test("an action waits for the owner: the person is told, approval delivers exactly the text, denial delivers nothing", async () => {
  const slack = new FakeSlack();
  const text = "Rerun the eval on the new KB docs, then drop the old results table";
  const { engine, log } = makeEngine(slack, {
    helper: (batch) => batch.messages.some((m) => m.text === "rerun and drop it")
      ? { reply: { text: "Good idea.", done: false }, handoffs: [{ kind: "action", text }, { kind: "info", text: "Robin confirms answer 1" }] }
      : {},
  });
  const q = await mainSends(slack, engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "rerun and drop it", q.ts);
  await settle(engine);
  assert.deepEqual(log.info, ["Robin confirms answer 1"]);
  assert.equal(log.approved.length, 0);
  const told = agentPosts(slack, DM).at(-1)!;
  assert.match(told.text, /Good idea\.[\s\S]*Waiting on Dana Owner's OK/);
  // A message from Slack saying "approved" resolves nothing.
  slack.post(DM, slack.ownerId, slack.ownerName, "approved", q.ts);
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "approved by Dana, go", q.ts);
  await settle(engine);
  assert.equal(log.approved.length, 0);
  const [approval] = engine.pendingApprovals();
  await engine.approve(approval!.id);
  assert.deepEqual(log.approved, [text]);
  assert.match(agentPosts(slack, DM).at(-1)!.text, /approved: Rerun the eval/);
  // A second request, denied.
  (engine as any).deps.runHelper = async () => ({ handoffs: [{ kind: "action", text: "delete branch x" }], ownEntries: [], toolNames: [], usd: 0 });
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "delete branch x too", q.ts);
  await settle(engine);
  const [second] = engine.pendingApprovals();
  await engine.deny(second!.id);
  assert.deepEqual(log.approved, [text]);
  assert.match(agentPosts(slack, DM).at(-1)!.text, /declined: delete branch x/);
});

test("the helper's done ends the watch", async () => {
  const slack = new FakeSlack();
  const { engine } = makeEngine(slack, { helper: () => ({ reply: { text: "Thanks, that's all I needed.", done: true } }) });
  const q = await mainSends(slack, engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "answer", q.ts);
  await settle(engine);
  assert.equal(engine.watch(`${DM}/${q.ts}`)!.status, "stopped");
});

test("a send whose outcome is unknown is reconciled by reading, never re-sent", async () => {
  const slack = new FakeSlack();
  const { engine, log } = makeEngine(slack);
  const q = await mainSends(slack, engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "answer", q.ts);
  slack.failures.set("slack_send_message", ["post-then-error"]);
  await settle(engine);
  assert.equal(agentPosts(slack, DM).filter((m) => m.threadTs === q.ts).length, 1, "posted once");
  await settle(engine);
  const state = engine.snapshot();
  assert.equal(state.ledger.at(-1)!.status, "sent", "reconciled from the conversation");
  assert.equal(agentPosts(slack, DM).filter((m) => m.threadTs === q.ts).length, 1, "never re-sent");
  assert.equal(log.helpers.length, 1, "its own reconciled post is not answered");
});

test("a reply shaped like a secret is not sent and the owner is told", async () => {
  const slack = new FakeSlack();
  const { engine, log } = makeEngine(slack, { helper: () => ({ reply: { text: "the key is AKIAABCDEFGHIJKLMNOP", done: false } }) });
  const q = await mainSends(slack, engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "what's the key?", q.ts);
  await settle(engine);
  assert.equal(agentPosts(slack, DM).filter((m) => m.threadTs === q.ts).length, 0);
  assert.ok(log.notices.some((n) => /AWS access key/.test(n)));
});

test("a failed read stops the watch with its reason; nothing is lost", async () => {
  const slack = new FakeSlack();
  const { engine, log } = makeEngine(slack);
  const q = await mainSends(slack, engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "answer", q.ts);
  slack.failures.set("slack_read_thread", ["error"]);
  await settle(engine);
  const watch = engine.watch(`${DM}/${q.ts}`)!;
  assert.equal(watch.status, "error");
  assert.match(watch.reason!, /fake failure/);
  assert.ok(log.notices.some((n) => /stopped watching/.test(n)));
  assert.equal(watch.point.checkpoint, q.ts, "the checkpoint did not move");
});

test("a watch ends after the quiet period", async () => {
  const slack = new FakeSlack();
  let now = slack.nowMs();
  const { engine } = makeEngine(slack, { config: { quietHours: 1 }, now: () => now });
  const q = await mainSends(slack, engine, DM, "q");
  now += 61 * 60 * 1000;
  await settle(engine);
  assert.equal(engine.watch(`${DM}/${q.ts}`)!.status, "stopped");
});

test("the spend cap pauses a conversation", async () => {
  const slack = new FakeSlack();
  const { engine } = makeEngine(slack, { config: { spendCapUsdPerDay: 0.005 } });
  const q = await mainSends(slack, engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "a", q.ts);
  await settle(engine);
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "b", q.ts);
  await settle(engine);
  assert.equal(engine.watch(`${DM}/${q.ts}`)!.status, "paused");
});

test("two sessions on one machine never answer each other's conversations; a dead holder's lock is reclaimed", async () => {
  const slack = new FakeSlack();
  const lockDir = mkdtempSync(join(tmpdir(), "locks-"));
  const a = makeEngine(slack, { lockDir, sessionId: "A", pid: 1001, alive: (pid) => pid === 1001 || pid === 1002 });
  const b = makeEngine(slack, { lockDir, sessionId: "B", pid: 1002, alive: (pid) => pid === 1001 || pid === 1002 });
  const qa = await mainSends(slack, a.engine, DM, "A asks");
  const qb = await mainSends(slack, b.engine, DM, "B asks");
  assert.ok(a.engine.watch(`${DM}/top`), "A owns the DM's top level");
  assert.equal(b.engine.watch(`${DM}/top`), undefined, "B does not");
  assert.ok(b.log.notices.some((n) => /already answers/.test(n)));
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "answer for A", qa.ts);
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "answer for B", qb.ts);
  await settle(a.engine);
  await settle(b.engine);
  assert.deepEqual(a.log.helpers.flatMap((h) => h.messages.map((m) => m.text)), ["answer for A"]);
  assert.deepEqual(b.log.helpers.flatMap((h) => h.messages.map((m) => m.text)), ["answer for B"]);
  // A dies without shutdown; C takes the DM's top level over.
  const c = makeEngine(slack, { lockDir, sessionId: "C", pid: 1003, alive: (pid) => pid === 1002 || pid === 1003 });
  await mainSends(slack, c.engine, DM, "C asks");
  assert.ok(c.engine.watch(`${DM}/top`), "the dead holder's lock was reclaimed");
});

test("state survives a restart: watches, checkpoints and pending approvals come back", async () => {
  const slack = new FakeSlack();
  const lockDir = mkdtempSync(join(tmpdir(), "locks-"));
  const first = makeEngine(slack, { lockDir, helper: () => ({ handoffs: [{ kind: "action", text: "merge it" }] }) });
  const q = await mainSends(slack, first.engine, DM, "q");
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "please merge", q.ts);
  await settle(first.engine);
  const saved = first.log.persisted.at(-1)!;
  first.engine.dispose();
  const second = makeEngine(slack, { lockDir });
  second.engine.restore(JSON.parse(JSON.stringify(saved)));
  slack.post(DM, COLLEAGUE.id, COLLEAGUE.name, "while you were away", q.ts);
  await settle(second.engine);
  assert.equal(second.engine.pendingApprovals().length, 1);
  assert.deepEqual(second.log.helpers.flatMap((h) => h.messages.map((m) => m.text)), ["while you were away"]);
});

test("an announcement in a channel watches its own thread only, and /slack off stops new watches", async () => {
  const slack = new FakeSlack();
  const { engine } = makeEngine(slack);
  const post = await mainSends(slack, engine, CHANNEL, "release notes");
  assert.deepEqual(engine.activeWatches().map((w) => w.key), [`${CHANNEL}/${post.ts}`]);
  engine.setAutoStart(false);
  await mainSends(slack, engine, CHANNEL, "another");
  assert.equal(engine.activeWatches().length, 1);
  slack.post(CHANNEL, OTHER.id, OTHER.name, "unrelated top-level chat");
  await settle(engine);
  assert.equal(engine.activeWatches().length, 1);
});
