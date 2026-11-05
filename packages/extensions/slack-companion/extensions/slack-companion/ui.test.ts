// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md: one line above the editor with
// the watches, the waiting count and the stops not yet seen, and a framed panel that never grows
// past its height, shows each request whole before it can be approved, and keeps what needs the
// owner reachable.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyState, type Approval, type EngineState, type WatchState } from "./engine.ts";
import { cutApart, cutMiddle, layoutPanel, Panel, renderLine, renderPanel, type Paint, type PanelAction, type SurfaceState } from "./ui.ts";

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
  const thread = watch({ context: [{ ts: "1.000001", userId: "U0", userName: "Dana Owner", text: "Three quick questions about the eval", agentFooter: true, origin: "this session" }], activity: [{ at: Date.UTC(2026, 10, 4, 14, 29), text: "replied: Checked" }, { at: Date.UTC(2026, 10, 4, 14, 41), text: "stayed silent on 1 message" }] });
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

test("a DM row keeps the name whole before the snippet, and a cut label keeps its color and weight to the end", () => {
  const long = "Bartholomew Quillfeather";
  // Real SGR codes (zero width), one color per name, so a reset inside a label shows.
  const codes: Record<string, number> = { text: 37, muted: 90 };
  const painted: Paint = { fg: (c, t) => `\u001b[${codes[c] ?? 36}m${t}\u001b[39m`, bold: (t) => `\u001b[1m${t}\u001b[22m` };
  const thread = watch({ partner: { userId: "U1", name: long }, context: [{ ts: "1.000001", userId: "U1", userName: long, text: "Three quick questions about the deploy before Friday's release window opens", agentFooter: false, origin: "person" }] });
  const ended = watch({ ...thread, key: "D1/2.0", conversation: { kind: "thread", channelId: "D1", threadTs: "1.000001" }, status: "stopped", endedAt: 1 });
  const channel = channelWatch(1, { channelName: "release-coordination-and-incident-follow-ups", partner: { userId: "U2", name: long } });
  for (const width of [44, 60, 80, 120]) {
    const rows = renderPanel(surface({ watches: [thread, ended, channel] }), 0, painted, width, 0);
    const channelRow = rows.find((r) => r.includes("Bartho") && !r.includes("(DM)"))!;
    assert.equal(channelRow.includes("\u001b[0m"), false, `a cut channel label keeps its paint at ${width}`);
    const labels = rows.filter((r) => r.includes("(DM)"));
    assert.ok(labels.length >= 2, `both rows at ${width}`);
    for (const row of labels) {
      assert.equal(row.includes("\u001b[0m"), false, `no reset code cuts the paint at ${width}`);
      assert.match(row, /\u001b\[(37|90)m(\u001b\[1m)?[^\u001b]*\(DM\)[^\u001b]*(\u001b\[22m)?\u001b\[39m/, `one painted span holds the whole label at ${width}: ${JSON.stringify(row)}`);
    }
    if (width >= 60) assert.ok(labels.every((r) => r.includes(`${long} (DM)`)), `the name is whole at ${width}`);
  }
});

test("paused conversations are counted as the line shows them: a DM's top level and its thread are one", () => {
  const top = watch({ key: "D1/top", conversation: { kind: "dm-top", channelId: "D1" }, status: "paused", pause: "sendLimit" });
  const thread = watch({ status: "paused", pause: "sendLimit" });
  const others = [1, 2, 3, 4, 5, 6].map((i) => channelWatch(i, { lastNote: `helper replied: answer number ${i} with words` }));
  for (const width of [40, 60, 80]) {
    const [line] = renderLine(surface({ watches: [top, thread, ...others] }), plain, width);
    assert.equal(/2 paused/.test(line!), false, `one conversation is paused, not two (${width}): ${line}`);
  }
});

test("the line is never wider than the terminal, at any width, in any state", () => {
  const states: SurfaceState[] = [
    surface({}, { problem: { title: "pi-mcp-adapter is not installed", detail: "x" } }),
    surface({ watches: [watch({ lastNote: "helper replied: Checked" })], approvals: [approval()] }),
    surface({ watches: [watch({ status: "paused", pause: "spendCap" }), ...[1, 2, 3, 4, 5].map((i) => channelWatch(i, { lastNote: `helper replied: answer ${i}` }))] }),
    surface({ watches: [watch({ status: "error", reason: "x", endedAt: 1 })] }),
  ];
  for (const state of states) for (let width = 10; width <= 60; width += 1) {
    for (const line of renderLine(state, plain, width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
  }
});

test("the line names the people before it spends room on long words", () => {
  const request = surface({ watches: [watch({ lastNote: "helper asked you to approve" })], approvals: [approval()] });
  const [one] = renderLine(request, plain, 66);
  assert.match(one!, /Robin Colleague/, `the requester is named at 66 columns: ${one}`);
  const two = surface({
    watches: [watch({ lastNote: "helper asked you to approve" }), channelWatch(1, { partner: { userId: "U2", name: "Sam Teammate" }, channelName: "eval", lastNote: "helper asked you to approve", lastActivityAt: 5 })],
    approvals: [approval(), approval({ id: "a2", watchKey: "C1/1.0", requester: "Sam Teammate", label: "Sam Teammate's thread in #eval" })],
  });
  const [both] = renderLine(two, plain, 110);
  assert.match(both!, /Robin Colleague/);
  assert.match(both!, /Sam Teammate/, `both requesters are named at 110 columns: ${both}`);
});

test("before anyone answers, the line and the panel name a conversation by the same first words, cut by cells", () => {
  const fresh = (key: string, channelId: string, text: string, over: Partial<WatchState> = {}) =>
    watch({ key, conversation: { kind: "thread", channelId, threadTs: "1.000001" }, partner: undefined, context: [{ ts: "1.000001", userId: "U0", userName: "Dana Owner", text, agentFooter: true, origin: "this session" }], ...over });
  const state = surface({ watches: [fresh("C1/1.000001", "C0GEN", "Deploy is blocked on the flaky check", { channelName: "general" }), fresh("C2/1.000001", "C0GEN", "Who owns the flaky check now?", { channelName: "general" }), fresh("D9/1.000001", "D9", "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀 ship it")] });
  const panel = renderPanel(state, 0, plain, 100, 0).join("\n");
  assert.match(panel, /#general "Deploy is blocked/, "a channel thread is told apart by its first words in the panel too");
  assert.match(panel, /#general "Who owns the flaky/);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(panel), false, "no emoji is split in half");
  const [line] = renderLine(state, plain, 120);
  assert.match(line!, /#general "Deploy is block…"/);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(line!), false);
});

test("a watch that is catching up after a gap says so on the line", () => {
  const [line] = renderLine(surface({ watches: [watch({ rejoining: 1, lastNote: "watching again" })] }), plain, 120);
  assert.match(line!, /Robin Colleague catching up/);
});

test("the panel says a rejoining watch is catching up, and tells apart fresh threads of a long-named channel at any width", () => {
  const panel = renderPanel(surface({ watches: [watch({ rejoining: 1 })] }), 0, plain, 80, 0).join("\n");
  assert.match(panel, /◌ catching up/);
  assert.doesNotMatch(panel, /● watching/);
  const fresh = (key: string, text: string) =>
    watch({ key, conversation: { kind: "thread", channelId: "C0REL", threadTs: key.split("/")[1]! }, channelName: "release-train-2026-q4-coordination", partner: undefined, context: [{ ts: key.split("/")[1]!, userId: "U0", userName: "Dana Owner", text, agentFooter: true, origin: "this session" }] });
  const state = surface({ watches: [fresh("C0REL/1.000001", "Deploy is blocked on the migration"), fresh("C0REL/2.000001", "Who owns the flaky check now?")] });
  for (const width of [40, 48, 60, 80]) {
    const rows = renderPanel(state, 0, plain, width, 0).filter((r) => r.includes("#rel"));
    assert.equal(rows.length, 2, `${width}`);
    assert.notEqual(rows[0]!.replace("›", " "), rows[1]!.replace("›", " "), `two rows read apart at ${width}: ${rows.join(" | ")}`);
  }
});

test("channels that share a long start read apart: the panel names them whole where there is room, and every cut keeps their ends", () => {
  const fresh = (key: string, channelId: string, channelName: string, over: Partial<WatchState> = {}) =>
    watch({ key, conversation: { kind: "thread", channelId, threadTs: key.split("/")[1]! }, channelName, partner: undefined, context: [{ ts: key.split("/")[1]!, userId: "U0", userName: "Dana Owner", text: "Deploy is blocked on the migration, anyone?", agentFooter: true, origin: "this session" }], ...over });
  for (const rejoining of [undefined, 1]) {
    const state = surface({ watches: [fresh("C0Q3/1.000001", "C0Q3", "release-train-2026-q3", { rejoining }), fresh("C0Q4/1.000001", "C0Q4", "release-train-2026-q4", { rejoining })] });
    const wide = renderPanel(state, 0, plain, 80, 0).join("\n");
    assert.match(wide, /#release-train-2026-q3 "Deploy/, `whole at 80: ${wide}`);
    for (const width of [40, 48, 60]) {
      const rows = renderPanel(state, 0, plain, width, 0).filter((r) => r.includes("#rel"));
      assert.equal(rows.length, 2, `${width}`);
      assert.match(rows.join("\n"), /q3/, `${width}: ${rows.join(" | ")}`);
      assert.match(rows.join("\n"), /q4/, `${width}: ${rows.join(" | ")}`);
      assert.match(rows.join("\n"), /"Depl/, `the first words still show at ${width}`);
    }
    const [line] = renderLine(state, plain, 160);
    assert.match(line!, /q3/);
    assert.match(line!, /q4/);
  }
  assert.equal(cutMiddle("release-train-2026-q4", 9), "rele…6-q4");
  assert.equal(cutMiddle("short", 9), "short");
  assert.equal(cutApart("release-train-2026-q4-coordination", ["release-train-2026-q3-coordination"], 12), "rel…-q4-coo…", "from just before where it differs");
  for (const width of [7, 8, 10]) {
    const [a, b] = [cutApart("team-frontend-alerts-prod", ["team-frontend-alerts-stag"], width), cutApart("team-frontend-alerts-stag", ["team-frontend-alerts-prod"], width)];
    assert.notEqual(a, b, `the difference shows at ${width}: ${a}`);
    assert.ok(visibleWidth(a) <= width);
  }
  assert.equal(cutApart("general-chatter-and-more", ["eval"], 9), cutMiddle("general-chatter-and-more", 9), "nothing shared: cut from the middle");
});

test("an active watch's state is one decision for the line and the panel", () => {
  for (const [over, answering, word, status] of [[{}, false, undefined, "● watching"], [{ rejoining: 1 }, false, "catching up", "◌ catching up"], [{ rejoining: 1 }, true, "answering…", "● answering…"]] as const) {
    const w = watch(over);
    const state = surface({ watches: [w] }, { answering: new Set(answering ? [w.key] : []) });
    const [line] = renderLine(state, plain, 120);
    if (word) assert.match(line!, new RegExp(word));
    else assert.doesNotMatch(line!, /answering|catching up/);
    assert.match(renderPanel(state, 0, plain, 80, 0).join("\n"), new RegExp(status));
  }
});

test("rows that name a person keep the end of a long channel name, where channels that share a start differ", () => {
  const named = (i: number, channelName: string) => channelWatch(i, { channelName, partner: { userId: "U9", name: "Taylor QA" } });
  const state = surface({ watches: [named(1, "release-train-2026-q3-coordination"), named(2, "release-train-2026-q4-coordination")] });
  for (const width of [40, 60, 80]) {
    const rows = renderPanel(state, 0, plain, width, 0).filter((r) => r.includes("Taylor QA"));
    assert.equal(rows.length, 2, `${width}`);
    assert.notEqual(rows[0]!.replace("›", " "), rows[1]!.replace("›", " "), `rows read apart at ${width}: ${rows.join(" | ")}`);
  }
  for (const width of [120, 200]) {
    const [line] = renderLine(state, plain, width);
    assert.match(line!, /q3/, `${width}: ${line}`);
    assert.match(line!, /q4/, `${width}: ${line}`);
  }
});
