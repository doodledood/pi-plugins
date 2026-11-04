// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md: one line above the editor with
// the watches, the waiting count and the stops not yet seen, and a framed panel that shows each
// request's full text and keeps a resolved one in view.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyState, type Approval, type EngineState, type WatchState } from "./engine.ts";
import { Panel, renderLine, renderPanel, type Paint, type PanelAction, type SurfaceState } from "./ui.ts";

const plain: Paint = { fg: (_c, t) => t, bold: (t) => t };

function watch(over: Partial<WatchState> = {}): WatchState {
  return {
    key: "D1/1.000001", conversation: { kind: "thread", channelId: "D1", threadTs: "1.000001" },
    startedBy: "send", status: "active", point: { checkpoint: "1.000001", seen: [] }, ownPosts: [], context: [], inbox: [],
    sendsWithoutOwner: 0, lastActivityAt: 0, agentLineSent: true, spend: { day: "2026-11-04", usd: 0 }, since: "1.000001",
    partner: { userId: "U1", name: "Robin Colleague" }, ...over,
  };
}

function approval(over: Partial<Approval> = {}): Approval {
  return { id: "a1", watchKey: "D1/1.000001", label: "Robin Colleague (DM)", requester: "Robin Colleague", text: "Rerun the eval on the new KB docs,\nthen drop the old results table https://example.com/a/very/long/path/that/must/not/be/cut/off/anywhere", at: 0, status: "pending", ...over };
}

function surface(engine: Partial<EngineState>, over: Partial<SurfaceState> = {}): SurfaceState {
  return { enabled: true, engine: { ...emptyState(), ...engine }, panelKey: "alt+s", answering: new Set(), unseenErrors: 0, now: 0, ...over };
}

test("no line when off or nothing is watched; a problem shows instead of watches", () => {
  assert.deepEqual(renderLine(surface({}, { enabled: false }), plain, 120), []);
  assert.deepEqual(renderLine(surface({}), plain, 120), []);
  assert.match(renderLine(surface({}, { problem: "pi-mcp-adapter is not installed" }), plain, 120)[0]!, /pi-mcp-adapter is not installed/);
});

test("the line names each person once, what the helper last did, the waiting count and the key, at any width", () => {
  const dm = [watch({ lastNote: "replied: Checked" }), watch({ key: "D1/top", conversation: { kind: "dm-top", channelId: "D1" } })];
  const [line] = renderLine(surface({ watches: dm, approvals: [approval()] }), plain, 200);
  assert.equal((line!.match(/Robin Colleague \(DM\)/g) ?? []).length, 1, "one DM, one entry");
  assert.match(line!, /replied: Checked/);
  assert.match(line!, /1 waiting for you.*alt\+s$/);
  const many = [1, 2, 3].map((i) => watch({ key: `C${i}/1.0`, conversation: { kind: "thread", channelId: `C${i}`, threadTs: "1.0" }, lastNote: "x".repeat(200) }));
  for (const width of [60, 80, 120]) {
    const [narrow] = renderLine(surface({ watches: many, approvals: [approval()] }, { unseenErrors: 1 }), plain, width);
    assert.ok(visibleWidth(narrow!) <= width, `fits ${width}`);
    assert.match(narrow!, /1 waiting for you/, `the waiting count survives at ${width}`);
    assert.match(narrow!, /1 stopped/);
    assert.match(narrow!, /alt\+s/);
  }
  const [paused] = renderLine(surface({ watches: [watch({ status: "paused", reason: "sent 5 messages without you" })] }), plain, 200);
  assert.match(paused!, /paused: sent 5 messages without you/);
  const [answering] = renderLine(surface({ watches: [watch()] }, { answering: new Set(["D1/1.000001"]) }), plain, 200);
  assert.match(answering!, /answering…/);
});

test("the panel is framed, lists requests first with their whole text, then live, then ended watches", () => {
  const ended = Array.from({ length: 6 }, (_, i) => watch({ key: `C${i}/1.0`, conversation: { kind: "thread", channelId: `C${i}`, threadTs: "1.0" }, status: "stopped", reason: "no messages for 24 h" }));
  const lines = renderPanel(surface({ watches: [...ended, watch({ lastNote: "asked you to approve" })], approvals: [approval()] }), 0, plain, 60, 0, 60);
  assert.equal(lines.some((l) => l.includes("…") && !/waiting for your OK/.test(l)), false, "no request row is cut");
  const text = lines.join("\n");
  assert.match(lines[0]!, /^╭─ Slack /);
  assert.match(lines.at(-1)!, /^╰─+╯$/);
  assert.match(renderPanel(surface({ approvals: [approval()] }), 0, plain, 120, 0, 60).join("\n"), /◐ waiting for your OK · Robin Colleague in Robin Colleague \(DM\)/);
  assert.match(text.replace(/[│\s]+/g, ""), /be\/cut\/off\/anywhere/, "a long word is wrapped, not cut");
  assert.ok(text.indexOf("waiting for your OK") < text.indexOf("● watching"));
  assert.ok(text.indexOf("● watching") < text.indexOf("· ended"));
  assert.match(text, /3 more ended/);
  assert.match(text, /a approve · d deny/);
  for (const l of lines) assert.ok(visibleWidth(l) <= 60);
  assert.match(renderPanel(surface({}, { enabled: false }), 0, plain, 60, 0).join(" ").replace(/[│\s]+/g, " "), /\/slack on turns it on: then a Slack/);
  assert.match(renderPanel(surface({}), 0, plain, 60, 0).join(" ").replace(/[│\s]+/g, " "), /\/slack <link> watches a conversation someone else started/);
});

test("a tall panel scrolls around the selection and keeps its keys", () => {
  const many = Array.from({ length: 12 }, (_, i) => approval({ id: `a${i}` }));
  const lines = renderPanel(surface({ watches: [watch()], approvals: many }), 8, plain, 60, 0, 20);
  assert.ok(lines.length <= 22);
  const text = lines.join("\n");
  assert.match(text, /↑ \d+ more/);
  assert.match(text, /a approve · d deny · ↑↓ move · esc close/);
});

test("approving keeps the request in view as resolved, so a second key press cannot approve the next unread one", () => {
  const state: EngineState = { ...emptyState(), watches: [watch()], approvals: [approval({ id: "a1" }), approval({ id: "a2", text: "Drop the table" })] };
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface(state, { now: 100 }), plain, (a) => {
    actions.push(a);
    if (a.kind === "approve") Object.assign(state.approvals.find((x) => x.id === a.id)!, { status: "approved", resolvedAt: 150 });
  }, () => {}, undefined, () => 40);
  panel.handleInput("a");
  panel.handleInput("a");
  assert.deepEqual(actions, [{ kind: "approve", id: "a1" }]);
  assert.match(panel.render(60).join("\n"), /✓ approved — sent to your session/);
});

test("panel keys map to owner actions only, including watching an ended conversation again", () => {
  const actions: PanelAction[] = [];
  let closed = false;
  const state = surface({ watches: [watch({ status: "paused", reason: "r" }), watch({ key: "D2/1.0", conversation: { kind: "thread", channelId: "D2", threadTs: "1.0" }, status: "error", reason: "tool_error" })], approvals: [approval()] });
  const panel = new Panel(() => state, plain, (a) => actions.push(a), () => { closed = true; }, undefined, () => 40);
  panel.handleInput("a");
  panel.handleInput("\u001b[B");
  panel.handleInput("r");
  panel.handleInput("\u001b[B");
  panel.handleInput("w");
  panel.handleInput("\u001b");
  assert.deepEqual(actions, [{ kind: "approve", id: "a1" }, { kind: "resume", key: "D1/1.000001" }, { kind: "rewatch", key: "D2/1.0" }]);
  assert.equal(closed, true);
});
