// /goal_edit keeps its editor open while the agent works; the edit must apply
// only to the goal it was opened on, and only if that goal is still editable.
import test from "node:test";
import assert from "node:assert/strict";
import { createEventBus, type AgentEndEvent } from "@earendil-works/pi-coding-agent";
import { activate } from "./index.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { CheckerRunner, CheckerRunInput } from "./checker.ts";
import type { CheckerVerdict } from "./types.ts";

function host() {
  const h: any = {
    events: createEventBus(), handlers: {} as any, tools: [] as any[], cmds: new Map(), entries: [] as any[], sent: [] as any[],
    registerTool(t: any) { h.tools.push(t); }, registerCommand(n: string, o: any) { h.cmds.set(n, o.handler); },
    on(e: string, f: any) { h.handlers[e] = f; }, appendEntry(t: string, d: any) { h.entries.push({ t, d }); },
    sendUserMessage(c: string, o: any) { h.sent.push({ c, o }); }, sendMessage() {}, getThinkingLevel() { return "off"; }, exec() { throw new Error(); },
  };
  return h;
}
function ctx(editor: () => Promise<string | undefined>, idle = () => false, notes: string[] = []) {
  return {
    cwd: "/tmp", hasUI: true, model: { provider: "p", id: "m" },
    ui: { setStatus() {}, notify(message: string) { notes.push(message); }, editor, theme: { fg: (_: string, t: string) => t } },
    sessionManager: { getBranch: () => [], getSessionFile: () => "/tmp/s.jsonl", getLeafId: () => "l" },
    isIdle: idle, hasPendingMessages: () => false, signal: undefined,
  } as any;
}
class Deferred implements CheckerRunner {
  inputs: CheckerRunInput[] = []; res: Array<(v: CheckerVerdict) => void> = [];
  run(i: CheckerRunInput) { this.inputs.push(i); return new Promise<CheckerVerdict>((r) => this.res.push(r)); }
}
const endEvt = { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "toolCall", name: "bash" }], stopReason: "stop" }] } as unknown as AgentEndEvent;
const last = (h: any) => h.entries.at(-1)?.d?.goal;
// The worker turn ends and the checker starts (Pi 1.4: agent_end, then agent_before_settle).
async function endRun(h: any, c: any): Promise<void> {
  await h.handlers.agent_end(endEvt, c);
  await h.handlers.agent_before_settle?.({ type: "agent_before_settle", outcome: "completed", entries: [], continue: false, context: {} }, c);
}

test("an edit submitted after the checker started is not applied", async () => {
  const h = host(); const chk = new Deferred(); const notes: string[] = [];
  activate(h, chk, () => ({ config: DEFAULT_CONFIG, path: "x" }));
  let submit!: (v: string) => void;
  const c = ctx(() => new Promise((r) => { submit = r; }), () => false, notes);
  await h.cmds.get("goal")("original goal", c);
  const editing = h.cmds.get("goal_edit")("", c);
  const ending = endRun(h, c);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(last(h).status, "checking");
  submit("edited goal text");
  await editing;
  assert.equal(last(h).status, "checking", "the running checker was not interrupted");
  assert.match(notes.at(-1) ?? "", /not applied.*checking/su);
  chk.res[0]!({ decision: "complete", complete: true, reason: "done", evidence: ["x"] });
  await ending;
  assert.equal(last(h).goal, "original goal");
});

test("an edit submitted after the goal completed is not applied", async () => {
  const h = host(); const chk = new Deferred(); const notes: string[] = [];
  activate(h, chk, () => ({ config: DEFAULT_CONFIG, path: "x" }));
  let submit!: (v: string) => void;
  const c = ctx(() => new Promise((r) => { submit = r; }), () => false, notes);
  await h.cmds.get("goal")("original goal", c);
  const editing = h.cmds.get("goal_edit")("", c);
  const ending = endRun(h, c);
  await new Promise((r) => setTimeout(r, 5));
  chk.res[0]!({ decision: "complete", complete: true, reason: "done", evidence: ["x"] });
  await ending;
  assert.equal(last(h).status, "complete");
  submit("edited goal text");
  await editing;
  assert.equal(last(h).status, "complete");
  assert.equal(last(h).goal, "original goal");
  assert.match(notes.at(-1) ?? "", /not applied.*complete/su);
});

test("an edit of a paused goal never lands on a goal the model started meanwhile", async () => {
  const h = host(); const chk = new Deferred(); const notes: string[] = [];
  activate(h, chk, () => ({ config: DEFAULT_CONFIG, path: "x" }));
  let submit!: (v: string) => void;
  const c = ctx(() => new Promise((r) => { submit = r; }), () => true, notes);
  await h.cmds.get("goal")("GOAL-A original", c);
  await h.cmds.get("goal_pause")("", c);
  const editing = h.cmds.get("goal_edit")("", c);
  await h.tools[0].execute("t1", { goal: "GOAL-B started by model" }, undefined, undefined, c);
  const bId = last(h).id;
  submit("GOAL-A refined by user");
  await editing;
  assert.equal(last(h).id, bId);
  assert.equal(last(h).goal, "GOAL-B started by model");
  assert.match(notes.at(-1) ?? "", /not applied.*replaced/su);
});
