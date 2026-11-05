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
  return { enabled: true, engine: { ...emptyState(), ...engine }, panelKey: "alt+s", answering: new Set(), seenErrors: new Set(), now: 31 * 60_000, ...over };
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
      if (engine.watches.some((w) => w.status === "paused")) assert.match(line!, /paused/, `paused at ${width}`);
      assert.equal(/\+\d*…|\+\d+ watch…/.test(line!), false, `the folded count is never cut, at ${width}: ${line}`);
    }
  }
  for (let width = 40; width <= 220; width += 1) {
    for (const engine of states) {
      const [line] = renderLine(surface(engine), plain, width);
      assert.equal(/(Person \d+|#team-\d*)…/.test(line!), false, `no label is cut, at ${width}: ${line}`);
    }
  }
  for (let width = 120; width <= 220; width += 10) {
    const [line] = renderLine(surface(states[2]!), plain, width);
    assert.match(line!, /Person \d #team-\d.*\+\d+ watching/, `watches shown whole, the rest folded, at ${width}: ${line}`);
  }
  const [wide] = renderLine(surface(states[3]!), plain, 200);
  assert.match(wide!, /^ ● slack · Person 2 #team-2 paused/, "the paused watch leads");
  for (const width of [100, 120, 140]) {
    const [line] = renderLine(surface(states[3]!), plain, width);
    assert.match(line!, /Person 2 #team-2 paused/, `the paused watch leads with its state at ${width}`);
    assert.equal(/1 paused/.test(line!), false, "not counted again when shown by name");
  }
  const narrow = { watches: [channelWatch(1), channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" }), channelWatch(3, { status: "error", endedAt: 5 })], approvals: [approval(), approval({ id: "a2" })] };
  for (let width = 40; width < 60; width += 1) assert.match(renderLine(surface(narrow), plain, width)[0]!, /2 waiting/, `the waiting count first, at ${width}`);
  const colors: string[] = [];
  const recording: Paint = { fg: (c, t) => { colors.push(`${c}:${t}`); return t; }, bold: (t) => t };
  renderLine(surface({ watches: [watch({ lastNote: "replied: Checked" })] }), recording, 120);
  assert.ok(colors.includes("muted:replied: Checked"), "a note is quiet: muted, like the dock");
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
  const channelRequest = flat(renderPanel(surface({ approvals: [approval({ label: "Taylor QA's thread in #release-train", requester: "Taylor QA" })] }), 0, plain, 80, 0, 40));
  assert.match(channelRequest, /from Taylor QA in #release-train/, "the person is named once");
  assert.match(flat(text.split("\n")).replace(/ /g, ""), /be\/cut\/off\/anywhere/, "a long word is wrapped, not cut");
});

test("a request taller than the panel scrolls inside itself, keeps its header in view, and cannot be approved before its last line was shown", () => {
  const steps = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`);
  const long = [...steps, "Finally: drop the old results table."].join("\n");
  const state: EngineState = { ...emptyState(), approvals: [approval({ text: long }), approval({ id: "a2", text: "short one" })] };
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface(state), plain, (a) => actions.push(a), () => {}, undefined, () => 20);
  let rendered = panel.render(80).join("\n");
  assert.match(rendered, /more lines · read to the end to approve · space next page/);
  assert.match(rendered, /d deny · ↑↓ move · esc close/);
  assert.equal(/a approve/.test(rendered), false, "the keys do not offer approval yet");
  panel.handleInput("a");
  assert.deepEqual(actions, [], "not approvable yet");
  for (let i = 0; i < 3; i += 1) panel.handleInput(" "); // a page at a time
  rendered = panel.render(80).join("\n");
  assert.match(rendered, /Finally: drop the old results table\./);
  assert.match(rendered, /◐ waiting for your OK · 31 min ago[\s\S]*from Robin Colleague \(DM\)/, "who asked stays in view at the end");
  assert.match(rendered, /a approve · d deny/);
  panel.handleInput(DOWN); // held once at the end
  assert.match(panel.render(80).join("\n"), /Finally: drop/);
  panel.handleInput(DOWN); // then moves on
  panel.handleInput("\u001b[A"); // and back: lands at the end, still approvable
  rendered = panel.render(80).join("\n");
  assert.match(rendered, /Finally: drop the old results table\.[\s\S]*a approve · d deny/);
  panel.handleInput("a");
  assert.deepEqual(actions, [{ kind: "approve", id: "a1" }]);
});

test("the selection follows its item when the list changes, so a key acts on what the owner chose", () => {
  const state: EngineState = { ...emptyState(), watches: [channelWatch(1, { lastActivityAt: 1 }), channelWatch(2, { lastActivityAt: 2 })] };
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface(state), plain, (a) => actions.push(a), () => {}, undefined, () => 40);
  panel.render(80);
  panel.handleInput(DOWN); // Person 1 (the older one)
  state.approvals = [approval()]; // a request arrives at the top
  panel.render(80);
  panel.handleInput("s");
  assert.deepEqual(actions, [{ kind: "stop", key: "C1/1.0" }]);
});

test("the panel orders by need: requests, paused, unseen stops, answering, the rest; ended ones newest first", () => {
  const watches = [
    channelWatch(1, { lastActivityAt: 9 }),
    channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" }),
    channelWatch(3, { status: "error", reason: "tool_error", endedAt: 1 }),
    channelWatch(4),
    ...[5, 6, 7, 8].map((i) => channelWatch(i, { status: "stopped", reason: "no messages for 24 h", endedAt: 10 + i })),
  ];
  const text = flat(renderPanel(surface({ watches, approvals: [approval()] }, { answering: new Set(["C4/1.0"]) }), 0, plain, 100, 0, 60));
  const order = ["waiting for your OK", "Person 2's", "Person 3's", "Person 4's", "Person 1's", "Person 8's", "Person 7's", "Person 6's", "1 more ended"].map((t) => text.indexOf(t));
  assert.deepEqual([...order].sort((a, b) => a - b), order, text);
  assert.ok(order.every((i) => i >= 0));
});

test("a stop counts as seen only once its row was on screen, and every error stays reachable", () => {
  const errors = [1, 2, 3, 4, 5, 6].map((i) => channelWatch(i, { status: "error", reason: "tool_error", endedAt: i }));
  const seen = new Set<string>();
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface({ watches: errors }, { seenErrors: seen }), plain, (a) => actions.push(a), () => {}, undefined, () => 12, (ids) => ids.forEach((id) => seen.add(id)));
  panel.render(80);
  assert.ok(seen.size > 0 && seen.size < 6, `only the rows shown (${seen.size})`);
  for (let i = 0; i < 6; i += 1) panel.handleInput(DOWN);
  panel.render(80);
  assert.equal(seen.size, 6);
  panel.handleInput("w");
  assert.equal(actions.length, 1);
  const [line] = renderLine(surface({ watches: errors }, { seenErrors: seen }), plain, 120);
  assert.equal(/stopped/.test(line ?? ""), false, "nothing unseen left on the line");
});

test("ended watches fold into an expandable count", () => {
  const ended = [2, 3, 4, 5].map((i) => channelWatch(i, { status: "stopped", reason: "no messages for 24 h", endedAt: 10 + i }));
  const panel = new Panel(() => surface({ watches: ended }), plain, () => {}, () => {}, undefined, () => 40);
  assert.match(flat(panel.render(80)), /1 more ended/);
  for (let i = 0; i < 3; i += 1) panel.handleInput(DOWN);
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
  assert.equal(layoutPanel(state, { selected: 0, offset: 0, allEnded: false, read: new Set() }, plain, 80, 0, 40).selectedEndInView, true);
});

test("every key is safe in the panel's message states: off, a problem, nothing watched", () => {
  const states = [surface({}, { enabled: false }), surface({}, { problem: { title: "t", detail: "d ".repeat(400) } }), surface({})];
  for (const state of states) {
    const panel = new Panel(() => state, plain, () => { throw new Error("no action expected"); }, () => {}, undefined, () => 12);
    for (const key of [DOWN, "\u001b[A", " ", "\u001b[6~", "\u001b[5~", "\r", "a", "d", "s", "r", "w"]) {
      panel.handleInput(key);
      assert.ok(panel.render(60).length <= 12, "a long message is cut to the panel's height");
    }
  }
});

test("a stop is reported seen once; rendering again asks for nothing", () => {
  const watches = [channelWatch(1, { status: "error", reason: "tool_error", endedAt: 1 })];
  const seen = new Set<string>();
  let calls = 0;
  const panel = new Panel(() => surface({ watches }, { seenErrors: seen }), plain, () => {}, () => {}, undefined, () => 40, (ids) => { calls += 1; ids.forEach((id) => seen.add(id)); });
  for (let i = 0; i < 5; i += 1) panel.render(80);
  assert.equal(calls, 1);
});

test("the long-item marker offers paging, and asks to read to the end only while that is true", () => {
  const long = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}.`).join("\n");
  const read = layoutPanel(surface({ approvals: [approval({ text: long })] }), { selected: 0, offset: 0, allEnded: false, read: new Set(["a1"]) }, plain, 80, 0, 20);
  assert.match(read.lines.join("\n"), /more lines · space next page/);
  assert.equal(/read to the end/.test(read.lines.join("\n")), false, "already read");
  const approved = layoutPanel(surface({ approvals: [approval({ text: long, status: "approved", resolvedAt: 5 })] }), { selected: 0, offset: 0, allEnded: false, read: new Set() }, plain, 80, 0, 20);
  assert.equal(/read to the end/.test(approved.lines.join("\n")), false, "approved");
});

test("when the line is very narrow, it drops the lowest count before the word slack", () => {
  const engine = { watches: [channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" }), channelWatch(3, { status: "error", endedAt: 5 })], approvals: [approval(), approval({ id: "a2" })] };
  for (let width = 40; width < 50; width += 1) {
    const [line] = renderLine(surface(engine), plain, width);
    assert.match(line!, /^ ● slack · 2 waiting/, `at ${width}: ${line}`);
  }
});

test("a paused watch is counted once: as paused, not also as watching", () => {
  const engine = { watches: [channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" })] };
  for (let width = 40; width <= 120; width += 1) {
    const [line] = renderLine(surface(engine), plain, width);
    assert.equal(/1 watching/.test(line!), false, `at ${width}: ${line}`);
    assert.match(line!, /paused/);
  }
});
