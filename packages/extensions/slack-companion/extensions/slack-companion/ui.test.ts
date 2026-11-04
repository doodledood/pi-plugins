// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md: one line above the editor with
// the watches, the waiting count and the stops not yet seen, and a framed panel that never grows
// past its height, shows each request whole before it can be approved, and keeps what needs the
// owner reachable.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyState, type Approval, type EngineState, type WatchState } from "./engine.ts";
import { layoutPanel, Panel, renderLine, renderPanel, type Paint, type PanelAction, type SurfaceState } from "./ui.ts";

const plain: Paint = { fg: (_c, t) => t, bold: (t) => t };
const DOWN = "\u001b[B";

function watch(over: Partial<WatchState> = {}): WatchState {
  return {
    key: "D1/1.000001", conversation: { kind: "thread", channelId: "D1", threadTs: "1.000001" },
    startedBy: "send", status: "active", point: { checkpoint: "1.000001", seen: [] }, ownPosts: [], context: [], inbox: [],
    sendsWithoutOwner: 0, lastActivityAt: 0, agentLineSent: true, spend: { day: "2026-11-04", usd: 0 }, since: "1.000001",
    partner: { userId: "U1", name: "Robin Colleague" }, ...over,
  };
}

function channelWatch(i: number, over: Partial<WatchState> = {}): WatchState {
  return watch({ key: `C${i}/1.0`, conversation: { kind: "thread", channelId: `C${i}`, threadTs: "1.0" }, channelName: `team-${i}`, partner: { userId: `U${i}`, name: `Person ${i}` }, lastActivityAt: i, ...over });
}

function approval(over: Partial<Approval> = {}): Approval {
  return { id: "a1", watchKey: "D1/1.000001", label: "Robin Colleague (DM)", requester: "Robin Colleague", text: "Rerun the eval on the new KB docs,\nthen drop the old results table https://example.com/a/very/long/path/that/must/not/be/cut/off/anywhere", at: 0, status: "pending", ...over };
}

function surface(engine: Partial<EngineState>, over: Partial<SurfaceState> = {}): SurfaceState {
  return { enabled: true, engine: { ...emptyState(), ...engine }, panelKey: "alt+s", answering: new Set(), seenAt: 0, now: 31 * 60_000, ...over };
}

const flat = (lines: string[]) => lines.join(" ").replace(/[│\s]+/g, " ");

test("no line when off or nothing is watched; a problem shows a short title and the key", () => {
  assert.deepEqual(renderLine(surface({}, { enabled: false }), plain, 120), []);
  assert.deepEqual(renderLine(surface({}), plain, 120), []);
  const [problem] = renderLine(surface({}, { problem: { title: "Slack tool name not found", detail: "the long explanation with a path" } }), plain, 80);
  assert.match(problem!, /^ ● slack can't watch: Slack tool name not found +alt\+s opens$/);
});

test("at every width the line fits, keeps the waiting count, the stops and the key, and leads with what needs the owner", () => {
  const states = [
    { watches: [watch({ lastNote: "replied: Checked" })], approvals: [approval()] },
    { watches: [1, 2, 3].map((i) => channelWatch(i, { lastNote: "x".repeat(200) })), approvals: [approval()] },
    { watches: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => channelWatch(i)), approvals: [approval(), approval({ id: "a2" })] },
    { watches: [channelWatch(1), channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" }), channelWatch(3, { status: "error", endedAt: 5 })] },
  ];
  for (const engine of states) {
    for (let width = 40; width <= 220; width += 1) {
      const [line] = renderLine(surface(engine), plain, width);
      assert.ok(visibleWidth(line!) <= width, `fits ${width}`);
      assert.match(line!, /alt\+s( opens)?$/, `the key at ${width}: ${line}`);
      const waiting = engine.approvals?.length;
      if (waiting) assert.match(line!, new RegExp(`${waiting} waiting`), `waiting at ${width}`);
      if (engine.watches.some((w) => w.status === "error")) assert.match(line!, /1 stopped/, `stopped at ${width}`);
      if (engine.watches.some((w) => w.status === "paused")) assert.match(line!, /1 paused/, `paused at ${width}`);
      assert.equal(/\+\d*…|\+\d+ watch…/.test(line!), false, `the folded count is never cut, at ${width}: ${line}`);
    }
  }
  for (let width = 120; width <= 220; width += 10) {
    const [line] = renderLine(surface(states[2]!), plain, width);
    assert.match(line!, /Person \d.*\+\d+ watching/, `watches shown, the rest folded, at ${width}: ${line}`);
  }
  const [wide] = renderLine(surface(states[3]!), plain, 200);
  assert.match(wide!, /^ ● slack · Person 2 #team-2 paused/, "the paused watch leads");
  for (const width of [100, 120, 140]) assert.match(renderLine(surface(states[3]!), plain, width)[0]!, /paused · /, `the state word survives at ${width}`);
  const [dm] = renderLine(surface({ watches: [watch({ lastNote: "replied: ok" }), watch({ key: "D1/top", conversation: { kind: "dm-top", channelId: "D1" } })] }), plain, 200);
  assert.equal((dm!.match(/Robin Colleague/g) ?? []).length, 1, "one DM, one entry");
  const [answering] = renderLine(surface({ watches: [watch()] }, { answering: new Set(["D1/1.000001"]) }), plain, 200);
  assert.match(answering!, /answering…/);
});

test("the panel never exceeds its height, keeps its frame and keys, and shows a request's age at its usual width", () => {
  const fixtures: Array<Partial<EngineState>> = [
    { watches: [watch()], approvals: Array.from({ length: 12 }, (_, i) => approval({ id: `a${i}` })) },
    { watches: Array.from({ length: 10 }, (_, i) => channelWatch(i, { activity: [{ at: 0, text: "replied: ok" }, { at: 1, text: "stayed silent" }] })) },
    { watches: [watch()], approvals: [approval({ text: Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`).join("\n") })] },
  ];
  for (const engine of fixtures) {
    for (const width of [60, 80, 120]) {
      for (const maxRows of [12, 19, 24, 40]) {
        for (let selected = 0; selected < 12; selected += 3) {
          const lines = renderPanel(surface(engine), selected, plain, width, 0, maxRows);
          assert.ok(lines.length <= maxRows, `${lines.length} rows > ${maxRows} (width ${width}, selected ${selected})`);
          assert.match(lines[0]!, /^╭─ Slack/);
          assert.match(lines.at(-1)!, /^╰─+╯$/);
          assert.match(lines.at(-2)!, /esc close/);
          for (const l of lines) assert.ok(visibleWidth(l) <= width);
        }
      }
    }
  }
  const text = renderPanel(surface({ approvals: [approval()] }), 0, plain, 80, 0, 40).join("\n");
  assert.match(text, /╭─ Slack · 1 waiting/);
  assert.match(text, /◐ waiting for your OK · 31 min ago/);
  assert.match(text, /from Robin Colleague \(DM\)/);
  assert.match(flat(text.split("\n")).replace(/ /g, ""), /be\/cut\/off\/anywhere/, "a long word is wrapped, not cut");
});

test("a request taller than the panel scrolls inside itself, and cannot be approved before its last line was shown", () => {
  const steps = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`);
  const long = [...steps, "Finally: drop the old results table."].join("\n");
  const state: EngineState = { ...emptyState(), approvals: [approval({ text: long })] };
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface(state), plain, (a) => actions.push(a), () => {}, undefined, () => 20);
  let rendered = panel.render(80);
  assert.ok(rendered.length <= 20);
  assert.match(rendered.join("\n"), /more lines of this item/);
  assert.match(rendered.join("\n"), /read to the end to approve/);
  panel.handleInput("a");
  assert.deepEqual(actions, [], "not approvable yet");
  let sawEnd = false;
  for (let i = 0; i < 60; i += 1) {
    panel.handleInput(DOWN);
    rendered = panel.render(80);
    sawEnd ||= rendered.join("\n").includes("Finally: drop the old results table.");
  }
  assert.ok(sawEnd, "the request's last line was shown");
  assert.match(rendered.join("\n"), /a approve · d deny/);
  panel.handleInput("a");
  assert.deepEqual(actions, [{ kind: "approve", id: "a1" }]);
});

test("ended watches: newest first, every error listed, the rest folded and expandable", () => {
  const ended = [
    channelWatch(1, { status: "error", reason: "tool_error", endedAt: 1 }),
    ...[2, 3, 4, 5].map((i) => channelWatch(i, { status: "stopped", reason: "no messages for 24 h", endedAt: 10 + i })),
  ];
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface({ watches: ended }), plain, (a) => actions.push(a), () => {}, undefined, () => 40);
  const text = flat(panel.render(80));
  assert.ok(text.indexOf("Person 1's thread in #team-1 × stopped") < text.indexOf("Person 5"), "the error is listed first");
  assert.ok(text.indexOf("Person 5") < text.indexOf("Person 4"), "newest quiet end first");
  assert.match(text, /1 more ended/);
  panel.handleInput("w");
  assert.deepEqual(actions, [{ kind: "rewatch", key: "C1/1.0" }], "w on the error watch");
  for (let i = 0; i < 4; i += 1) panel.handleInput(DOWN);
  panel.handleInput("\r");
  assert.match(flat(panel.render(80)), /Person 2's thread in #team-2/, "enter shows all ended");
});

test("rows say which conversation a DM watch is, and what happened lately", () => {
  const thread = watch({ context: [{ ts: "1.000001", userId: "U0", userName: "Dana Owner", text: "🤖 **Dana Owner's agent** — …\n\nThree quick questions about the eval", agentFooter: true }], activity: [{ at: Date.UTC(2026, 10, 4, 14, 29), text: "replied: Checked" }, { at: Date.UTC(2026, 10, 4, 14, 41), text: "stayed silent on 1 message" }] });
  const top = watch({ key: "D1/top", conversation: { kind: "dm-top", channelId: "D1" } });
  const text = flat(renderPanel(surface({ watches: [top, thread] }), 0, plain, 100, 0, 40));
  assert.match(text, /Robin Colleague \(DM\) · thread "Three quick questions about the…"/);
  assert.match(text, /Robin Colleague \(DM\) · top level/);
  assert.match(text, /\d\d:\d\d replied: Checked \d\d:\d\d stayed silent on 1 message/);
  assert.equal(text.includes("Dana Owner: 🤖"), false, "an agent post is not shown as the latest message");
  assert.match(flat(renderPanel(surface({}, { enabled: false }), 0, plain, 60, 0)), /Run \/slack on to turn it on/);
  assert.match(flat(renderPanel(surface({}, { problem: { title: "t", detail: "the whole explanation" } }), 0, plain, 60, 0)), /Can't watch: t the whole explanation/);
});

test("approving keeps the request in view as resolved, so a second key press cannot approve the next one", () => {
  const state: EngineState = { ...emptyState(), watches: [watch()], approvals: [approval({ id: "a1" }), approval({ id: "a2", text: "Drop the table" })] };
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface(state, { now: 100 }), plain, (a) => {
    actions.push(a);
    if (a.kind === "approve") Object.assign(state.approvals.find((x) => x.id === a.id)!, { status: "approved", resolvedAt: 150 });
  }, () => {}, undefined, () => 40);
  panel.render(60);
  panel.handleInput("a");
  panel.handleInput("a");
  assert.deepEqual(actions, [{ kind: "approve", id: "a1" }]);
  assert.match(panel.render(60).join("\n"), /✓ approved — sent to your session/);
});

test("panel keys map to owner actions only", () => {
  const actions: PanelAction[] = [];
  let closed = false;
  const state = surface({ watches: [watch({ status: "paused", reason: "r", pause: "sendLimit" }), channelWatch(2, { status: "error", reason: "tool_error", endedAt: 3 })], approvals: [approval()] });
  const panel = new Panel(() => state, plain, (a) => actions.push(a), () => { closed = true; }, undefined, () => 40);
  panel.render(80);
  panel.handleInput("a");
  panel.handleInput(DOWN);
  panel.handleInput("r");
  panel.handleInput(DOWN);
  panel.handleInput("w");
  panel.handleInput("\u001b");
  assert.deepEqual(actions, [{ kind: "approve", id: "a1" }, { kind: "resume", key: "D1/1.000001" }, { kind: "rewatch", key: "C2/1.0" }]);
  assert.equal(closed, true);
  assert.equal(layoutPanel(state, { selected: 0, offset: 0, allEnded: false }, plain, 80, 0, 40).selectedFullySeen, true);
});
