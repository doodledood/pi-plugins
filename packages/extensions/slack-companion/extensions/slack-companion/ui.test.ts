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

/** A panel's items, each as its rows' text (the pointer blanked), so tests can tell items apart. */
function itemBlocks(rows: string[]): string[] {
  const body = rows.slice(1, -1).map((r) => r.replace("›", " ")).filter((r) => !/stop watching|esc close|resume ·|watch again|show all|approve ·/.test(r) && r.replace(/[│ ]/g, "") !== "");
  return body.join("\n").split(/\n(?=│ {3}\S)/);
}

/** A panel's text with every space, frame mark and row status removed: a name wrapped over rows is still found whole. */
const joined = (rows: string[]) => rows.map((r) => r.replace(/ {2}[●○◐◌×·] [^│]*/, "")).join("").replace(/[│\s]/g, "");

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

test("a request taller than the panel scrolls inside itself, keeps its header in view, and cannot be approved before every line of it was shown", () => {
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
  for (let i = 0; i < 3; i += 1) {
    panel.handleInput(" "); // a page at a time, each painted
    const frame = panel.render(80).join("\n");
    // The frame that first shows the last row already offers approval, so it does not also ask to read on.
    if (/Finally:/.test(frame)) assert.doesNotMatch(frame, /read all to approve/, `the hint is gone once approvable:\n${frame}`);
  }
  rendered = panel.render(80).join("\n");
  assert.match(rendered, /Finally: drop the old results table\./);
  assert.doesNotMatch(rendered, /read all to approve/, "no hint at the end of a request already read");
  assert.match(rendered, /◐ waiting for your OK · 31 min ago[\s\S]*from Robin Colleague \(DM\)/, "who asked stays in view at the end");
  assert.match(rendered, /a approve · d deny/);
  panel.handleInput(DOWN); // held once at the end
  const held = panel.render(80).join("\n");
  assert.match(held, /Finally: drop/);
  assert.doesNotMatch(held, /read all to approve/);
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

test("the panel orders by need: requests, paused, unseen stops, agent posts, answering, the rest; ended ones newest first", () => {
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
  assert.ok(seen.size < 6, "keys handled before a paint show nothing");
  for (let i = 0; i < 6; i += 1) {
    panel.handleInput("\u001b[A");
    panel.render(80);
  }
  for (let i = 0; i < 6; i += 1) {
    panel.handleInput(DOWN);
    panel.render(80);
  }
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
  assert.equal(layoutPanel(state, { selected: 0, offset: 0, allEnded: false, read: new Set() }, plain, 80, 0, 40).selectedAllSeen, true);
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

test("when the line is very narrow, every count shows that fits, each with its noun: waiting first, the live watches last, and the word slack before a count", () => {
  const engine = { watches: [channelWatch(1), channelWatch(4), channelWatch(5), channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" }), channelWatch(3, { status: "error", endedAt: 5 }), channelWatch(6, { agentPostsWaiting: 2 })], approvals: [approval(), approval({ id: "a2" })] };
  const counts = ["2 waiting", "1 stopped", "1 paused", "2 agent posts", "3 watching"];
  const fitsWith = (lead: string, k: number, width: number) => visibleWidth(`${lead}${counts.slice(0, k).join(" · ")}  alt+s`) <= width;
  for (let width = 21; width <= 80; width += 1) {
    const [line] = renderLine(surface(engine), plain, width);
    assert.ok(visibleWidth(line!) <= width, `fits ${width}`);
    assert.doesNotMatch(line!, /\+\d(?! \w)|· \d+ agent(?! post)/, `every count has its noun at ${width}: ${line}`);
    const present = counts.map((c) => line!.includes(c));
    const shown = present.filter(Boolean).length;
    assert.deepEqual(present, counts.map((_, i) => i < shown), `kept in order at ${width}: ${line}`);
    if (fitsWith(" ● ", 1, width)) assert.ok(shown >= 1, `the waiting count at ${width}: ${line}`);
    // As many counts as fit: one more would not, even without "slack".
    if (shown < counts.length) assert.equal(fitsWith(" ● ", shown + 1, width), false, `another count fits at ${width}: ${line}`);
    // "slack" goes only where keeping it would cost a count; a bare dot takes no separator.
    if (!line!.includes("slack")) assert.equal(fitsWith(" ● slack · ", shown, width), false, `slack kept where it fits at ${width}: ${line}`);
    assert.doesNotMatch(line!, /● ·/, `no separator after a bare dot at ${width}: ${line}`);
  }
  assert.match(renderLine(surface({ watches: [channelWatch(1), channelWatch(4), channelWatch(5), channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" })], approvals: [approval()] }), plain, 43)[0]!, /^ ● 1 waiting · 1 paused · 3 watching {2}alt\+s$/, "every watch counted, the word slack given up first, at 43");
});

test("a paused watch is counted once: as paused, not also as watching", () => {
  const engine = { watches: [channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" })] };
  for (let width = 40; width <= 120; width += 1) {
    const [line] = renderLine(surface(engine), plain, width);
    assert.equal(/1 watching/.test(line!), false, `at ${width}: ${line}`);
    assert.match(line!, /paused/);
  }
});

test("a DM row keeps the name whole before the snippet, and a wrapped label keeps its color and weight to the end", () => {
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
    assert.equal(channelRow.includes("\u001b[0m"), false, `a wrapped channel label keeps its paint at ${width}`);
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
  const [line] = renderLine(state, plain, 160);
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
  for (const width of [24, 30, 40, 48, 60, 80]) {
    const rows = renderPanel(state, 0, plain, width, 0);
    const blocks = itemBlocks(rows);
    assert.equal(blocks.length, 2, `${width}`);
    assert.notEqual(blocks[0], blocks[1], `two items read apart at ${width}:\n${rows.join("\n")}`);
    assert.ok(joined(rows).includes("#release-train-2026-q4-coordination"), `the channel is never cut at ${width}`);
  }
});
test("channels that share a long start read apart: their names are never cut, and the first words take what is left", () => {
  const fresh = (key: string, channelId: string, channelName: string, over: Partial<WatchState> = {}) =>
    watch({ key, conversation: { kind: "thread", channelId, threadTs: key.split("/")[1]! }, channelName, partner: undefined, context: [{ ts: key.split("/")[1]!, userId: "U0", userName: "Dana Owner", text: "Deploy is blocked on the migration, anyone?", agentFooter: true, origin: "this session" }], ...over });
  for (const rejoining of [undefined, 1]) {
    const state = surface({ watches: [fresh("C0Q3/1.000001", "C0Q3", "release-train-2026-q3", { rejoining }), fresh("C0Q4/1.000001", "C0Q4", "release-train-2026-q4", { rejoining })] });
    const wide = renderPanel(state, 0, plain, 80, 0).join("\n");
    assert.match(wide, /#release-train-2026-q3 "Deploy/, `whole at 80: ${wide}`);
    for (const width of [24, 40, 48, 60]) {
      const rows = renderPanel(state, 0, plain, width, 0);
      assert.ok(joined(rows).includes("#release-train-2026-q3") && joined(rows).includes("#release-train-2026-q4"), `${width}:\n${rows.join("\n")}`);
      assert.match(rows.join("\n"), /"Depl/, `the first words still show at ${width}`);
    }
    const [line] = renderLine(state, plain, 160);
    assert.match(line!, /#release-train-2026-q3/);
    assert.match(line!, /#release-train-2026-q4/);
  }
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

test("rows that name a person never cut the person or the channel: a long channel goes to rows of its own", () => {
  const named = (i: number, channelName: string) => channelWatch(i, { channelName, partner: { userId: "U9", name: "Taylor QA" } });
  const state = surface({ watches: [named(1, "release-train-2026-q3-coordination"), named(2, "release-train-2026-q4-coordination")] });
  for (const width of [24, 28, 30, 34, 40, 60, 80]) {
    const rows = renderPanel(state, 0, plain, width, 0);
    const blocks = itemBlocks(rows);
    assert.equal(blocks.length, 2, `${width}`);
    assert.notEqual(blocks[0], blocks[1], `items read apart at ${width}:\n${rows.join("\n")}`);
    for (const name of ["TaylorQA", "#release-train-2026-q3-coordination", "#release-train-2026-q4-coordination"]) assert.ok(joined(rows).includes(name), `${name} at ${width}:\n${rows.join("\n")}`);
    assert.ok(!blocks.join("").includes("…"), `nothing cut at ${width}:\n${rows.join("\n")}`);
  }
  const line = renderLine(state, plain, 200)[0] ?? "";
  assert.match(line, /q3-coordination/, line);
  assert.match(line, /q4-coordination/, line);
});
test("threads with different people in one short channel read apart in a narrow panel, and a short channel stays beside the person", () => {
  const two = surface({ watches: [channelWatch(1, { channelName: "eng", conversation: { kind: "thread", channelId: "C1", threadTs: "1.0" } }), channelWatch(2, { channelName: "eng", conversation: { kind: "thread", channelId: "C1", threadTs: "2.0" }, partner: { userId: "U9", name: "Robin Colleague" } })] });
  for (const width of [24, 28, 30, 34, 40]) {
    const blocks = itemBlocks(renderPanel(two, 0, plain, width, 0));
    assert.equal(blocks.length, 2, `${width}`);
    assert.notEqual(blocks[0], blocks[1], `${width}: ${blocks.join(" | ")}`);
  }
  const general = surface({ watches: [channelWatch(1, { channelName: "general", partner: { userId: "U9", name: "Robin Colleague" }, status: "paused" })] });
  assert.match(renderPanel(general, 0, plain, 40, 0).join("\n"), /Robin Colleague #general/, "the whole name fits beside a short channel");
});
test("the panel's latest post skips this session's helper replies as well as main's", () => {
  const w = watch({ partner: { userId: "U1", name: "Robin Colleague" }, context: [
    { ts: "1.000001", userId: "U1", userName: "Robin Colleague", text: "is staging down?", agentFooter: false, origin: "person" },
    { ts: "1.000002", userId: "U0", userName: "Dana Owner", text: "Checking now.", agentFooter: true, origin: "helper" },
  ] });
  const panel = renderPanel(surface({ watches: [w] }), 0, plain, 100, 0).join("\n");
  assert.match(panel, /Robin Colleague: is staging down\?/);
  assert.doesNotMatch(panel, /Checking now/);
});

test("a conversation where agent posts wait is never folded into 'watching': the line counts it in warning, and the panel lists it right after the paused", () => {
  const colored: Paint = { fg: (c, t) => `<${c}>${t}</${c}>`, bold: (t) => t };
  const agentWatch = channelWatch(9, { channelName: "general", partner: { userId: "U9", name: "Casey Ops" }, agentPostsWaiting: 1, lastActivityAt: 1 });
  const others = [1, 2, 3, 4, 5].map((i) => channelWatch(i, { lastActivityAt: 10 + i }));
  const state = surface({ watches: [...others, agentWatch] }, { answering: new Set([others[0]!.key, agentWatch.key]) });
  assert.match(renderLine(state, plain, 50)[0]!, / 5 watching · 1 agent post /, "counted on its own, not in 'watching'");
  assert.match(renderLine(state, plain, 100)[0]!, /Casey Ops #general agent post waits/, "named first: it outranks the answering one");
  assert.doesNotMatch(renderLine(state, plain, 100)[0]!, /6 watching/);
  assert.match(renderLine(state, colored, 40)[0]!, /<warning>●<\/warning>/, "the dot says something waits");
  // The panel: paused, then unseen stops, then where agent posts wait (once, though answering too), then answering.
  const paused = channelWatch(7, { status: "paused", lastActivityAt: 0 });
  const stop = channelWatch(8, { status: "error", reason: "x", endedAt: 5, lastActivityAt: 0 });
  const panelState = surface({ watches: [...others, agentWatch, paused, stop] }, { answering: new Set([others[0]!.key, agentWatch.key]) });
  const heads = renderPanel(panelState, 0, plain, 80, 0, 80).filter((r) => /Person \d|Casey Ops/.test(r) && /●|○|◐|×/.test(r));
  assert.deepEqual(heads.slice(0, 4).map((r) => /Person 7|Person 8|Casey Ops|Person 1/.exec(r)?.[0]), ["Person 7", "Person 8", "Casey Ops", "Person 1"], heads.join(" | "));
  assert.equal(heads.filter((r) => r.includes("Casey Ops")).length, 1, "listed once");
  assert.match(heads.find((r) => r.includes("Casey Ops"))!, /◐ agent post/);
});

test("the agent post that waits shows its words in the panel at every width", () => {
  const w = channelWatch(9, { channelName: "general", partner: { userId: "U9", name: "Casey Ops" }, agentPostsWaiting: 1, context: [
    { ts: "1.000001", userId: "U9", userName: "Casey Ops", text: "🤖 Can you approve the rollback window for tonight?", agentFooter: true, origin: "someone's agent" },
  ] });
  for (const width of [40, 56, 80]) {
    const panel = renderPanel(surface({ watches: [w] }), 0, plain, width, 0, 40).join("\n");
    assert.match(panel, /1 agent post since you wrote/, `${width}`);
    assert.match(panel.replace(/[│\n ]+/g, " "), /Can you approve the/, `${width}: ${panel}`);
  }
});

/** Wider than the panel's inner width at 80 cells (76) and than the line's room at 120. */
const HUGE_NAME = "Quillfeatheringtonshaw-Brambleworth Ottoline Vandermolen-Achterberg Okonkwo-Lindqvist de Haan";

test("a person's name is never cut: the panel names everyone whole at any width, wrapping a name wider than its row", () => {
  const agent = (userId: string, userName: string) => ({ ts: "1.000001", userId, userName, text: "🤖 please approve the rollout", agentFooter: true, origin: "someone's agent" as const });
  const person = (userId: string, userName: string) => ({ ts: "1.000002", userId, userName, text: "is staging down for everyone?", agentFooter: false, origin: "person" as const });
  const long = "alerts-prod-payments";
  const pairs: Array<[string, string]> = [["Daniel Fischer", "Daniel Fogarty"], ["Daniel Fox Smith", "Daniel Ray Smith"], ["Robin Colleague", "Robert Smith"], ["Alexandra Montgomery-Fitzgerald", "Maximiliano Fernández-Oyarzábal"], [HUGE_NAME, "Robin Colleague"]];
  for (const [a, b] of pairs) {
    const states = [
      surface({ watches: [
        channelWatch(1, { channelName: long, conversation: { kind: "thread", channelId: "C1", threadTs: "1.0" }, partner: { userId: "U1", name: a }, agentPostsWaiting: 1, context: [agent("U2", b)] }),
        channelWatch(2, { channelName: long, conversation: { kind: "thread", channelId: "C1", threadTs: "2.0" }, partner: { userId: "U2", name: b }, context: [person("U1", a)] }),
      ] }),
      surface({ watches: [
        watch({ key: "D1/1.0", conversation: { kind: "thread", channelId: "D1", threadTs: "1.0" }, partner: { userId: "U1", name: a } }),
        watch({ key: "D2/1.0", conversation: { kind: "dm-top", channelId: "D2" }, partner: { userId: "U2", name: b } }),
      ] }, { answering: new Set(["D1/1.0", "D2/1.0"]) }),
    ];
    for (const state of states) {
      for (let width = 24; width <= 80; width += 1) {
        const rows = renderPanel(state, 0, plain, width, 0, 60);
        const blocks = itemBlocks(rows);
        assert.notEqual(blocks[0], blocks[1], `${width}:\n${rows.join("\n")}`);
        for (const name of [a, b]) assert.ok(joined(rows).includes(name.replace(/\s/g, "")), `${name} whole at ${width}:\n${rows.join("\n")}`);
        assert.ok(rows.every((r) => visibleWidth(r) <= width), `${width}`);
      }
    }
  }
});
test("a paused watch stays paused on the line and in the panel even with agent posts waiting, and a DM with one paused thread reads paused", () => {
  const paused = channelWatch(1, { status: "paused", reason: "sent 5 messages without you", agentPostsWaiting: 1, partner: { userId: "U1", name: "Robin Colleague" } });
  const state = surface({ watches: [paused] });
  assert.match(renderLine(state, plain, 100)[0]!, /Robin Colleague #team-1 paused/);
  const panel = renderPanel(state, 0, plain, 80, 0).join("\n");
  assert.match(panel, /○ paused/);
  assert.match(panel, /1 agent post since you wrote/);
  const dm = surface({ watches: [
    watch({ key: "D1/top", conversation: { kind: "dm-top", channelId: "D1" }, partner: { userId: "U1", name: "Robin Colleague" }, lastActivityAt: 5 }),
    watch({ key: "D1/1.0", conversation: { kind: "thread", channelId: "D1", threadTs: "1.0" }, partner: { userId: "U1", name: "Robin Colleague" }, status: "paused", lastActivityAt: 1 }),
  ] });
  assert.match(renderLine(dm, plain, 100)[0]!, /Robin Colleague paused/);
});

test("the line counts agent posts in posts: named and unnamed alike", () => {
  const many = channelWatch(9, { channelName: "general", partner: { userId: "U9", name: "Casey Ops" }, agentPostsWaiting: 12 });
  assert.match(renderLine(surface({ watches: [many] }), plain, 40)[0]!, /12 agent posts/);
  const two = channelWatch(8, { channelName: "eval", partner: { userId: "U8", name: "Sam Teammate" }, agentPostsWaiting: 3, lastActivityAt: 0 });
  const others = [1, 2, 3].map((i) => channelWatch(i, { lastActivityAt: 10 + i }));
  const line = renderLine(surface({ watches: [many, two, ...others] }), plain, 90)[0]!;
  if (/12 agent posts wait/.test(line) && !/3 agent posts wait/.test(line)) assert.match(line, /\+3 agent posts/, line);
  assert.doesNotMatch(line, / 2 agent posts/, "never a count of conversations called posts");
});

test("the narrowest line keeps the agent-post count beside a pause, in tight words", () => {
  const paused = channelWatch(1, { status: "paused", lastActivityAt: 2 });
  const agents = [channelWatch(2, { agentPostsWaiting: 2, lastActivityAt: 1 }), channelWatch(3, { agentPostsWaiting: 1, lastActivityAt: 0 })];
  const state = surface({ watches: [paused, ...agents] });
  for (const width of [38, 40, 42, 44]) {
    const line = renderLine(state, plain, width)[0]!;
    assert.match(line, /1 paused/, `${width}: ${line}`);
    assert.match(line, /3 agent/, `${width}: ${line}`);
  }
});

test("'their agent' names a post by the row's own person, whose name the row always shows; anyone else's agent post is named by its poster", () => {
  const post = (userId: string, userName: string) => ({ ts: "1.000001", userId, userName, text: "🤖 which migration id?", agentFooter: true, origin: "someone's agent" as const });
  for (const width of [24, 30, 36, 44, 80]) {
    const own = channelWatch(1, { channelName: "alerts-prod-payments-eu", partner: { userId: "U1", name: "Robin Colleague" }, agentPostsWaiting: 1, context: [post("U1", "Robin Colleague")] });
    const ownPanel = renderPanel(surface({ watches: [own] }), 0, plain, width, 0);
    assert.match(flat(ownPanel), /their agent: which/, `${width}`);
    assert.ok(joined(ownPanel).includes("RobinColleague"), `${width}`);
    const other = channelWatch(2, { channelName: "general", partner: { userId: "U2", name: "Ana" }, agentPostsWaiting: 1, context: [post("U3", "Robin Colleague")] });
    const otherPanel = renderPanel(surface({ watches: [other] }), 0, plain, width, 0);
    assert.doesNotMatch(flat(otherPanel), /their agent/, `${width}`);
    assert.match(flat(otherPanel), /Robin Colleague \(agent\): which/, `${width}`);
  }
});
test("a long poster name leaves room for the agent post's words", () => {
  const w = channelWatch(1, { channelName: "release-train-2026-q4-coordination", partner: { userId: "U1", name: "Alexandra Montgomery-Fitzgerald" }, agentPostsWaiting: 1, context: [
    { ts: "1.000001", userId: "U9", userName: "Maximiliano Fernández-Oyarzábal", text: "🤖 Done; all green. Shall I promote the build?", agentFooter: true, origin: "someone's agent" },
  ] });
  for (const width of [30, 36, 40, 48]) {
    const panel = renderPanel(surface({ watches: [w] }), 0, plain, width, 0, 40).join("\n").replace(/[│\n ]+/g, " ");
    assert.match(panel, /Done;/, `${width}: ${panel}`);
  }
});

test("two agent posts from look-alike people never make two items read the same, in channels or DMs", () => {
  const post = (userId: string, userName: string) => ({ ts: "1.000001", userId, userName, text: "🤖 please approve the rollout", agentFooter: true, origin: "someone's agent" as const });
  const pairs: Array<[string, string]> = [["Robin Cole", "Robin Colleague"], ["Daniel Fox Smith", "Daniel Ray Smith"], ["Alexandra Montgomery", "Alexandra Monroe"]];
  for (const [a, b] of pairs) {
    const inChannel = surface({ watches: [
      channelWatch(1, { channelName: "general", conversation: { kind: "thread", channelId: "C1", threadTs: "1.0" }, partner: { userId: "U1", name: a }, agentPostsWaiting: 1, context: [post("U1", a)] }),
      channelWatch(2, { channelName: "general", conversation: { kind: "thread", channelId: "C1", threadTs: "2.0" }, partner: { userId: "U2", name: b }, agentPostsWaiting: 1, context: [post("U2", b)] }),
    ] });
    const dms = surface({ watches: [
      watch({ key: "D1/1.0", conversation: { kind: "thread", channelId: "D1", threadTs: "1.0" }, partner: { userId: "U1", name: a }, agentPostsWaiting: 1, context: [post("U1", a)] }),
      watch({ key: "D2/1.0", conversation: { kind: "thread", channelId: "D2", threadTs: "1.0" }, partner: { userId: "U2", name: b }, agentPostsWaiting: 1, context: [post("U2", b)] }),
    ] });
    for (const [state, widths] of [[inChannel, [24, 28, 30, 33, 40]], [dms, [24, 30, 40, 44, 50]]] as const) {
      for (const width of widths) {
        const rows = renderPanel(state, 0, plain, width, 0, 40).map((r) => r.replace("›", " ")).filter((r) => r.startsWith("│") && !/esc|stop watching/.test(r) && r.replace(/[│ ]/g, "") !== "");
        const blocks = rows.join("\n").split(/\n(?=│ {3}\S)/);
        assert.equal(blocks.length, 2, `${a}/${b} at ${width}:\n${rows.join("\n")}`);
        assert.equal(new Set(blocks).size, blocks.length, `${a}/${b} at ${width}:\n${rows.join("\n")}`);
      }
    }
  }
});

test("a long poster name is never cut: it wraps onto rows of its own when it cannot share one, and the post's words still show", () => {
  const text = "is staging down for everyone, or only for the payments team this morning?";
  for (const width of [24, 30, 40, 60]) {
    for (const origin of ["someone's agent", "person"] as const) {
      const w = channelWatch(1, { channelName: "general", partner: { userId: "U1", name: "Ana" }, agentPostsWaiting: origin === "person" ? 0 : 1, context: [
        { ts: "1.000001", userId: "U9", userName: "Maximiliano Fernández-Oyarzábal", text: origin === "person" ? text : `🤖 ${text}`, agentFooter: origin !== "person", origin },
      ] });
      const rows = renderPanel(surface({ watches: [w] }), 0, plain, width, 0, 60);
      assert.ok(joined(rows).includes("MaximilianoFernández-Oyarzábal"), `${origin} at ${width}:\n${rows.join("\n")}`);
      assert.match(flat(rows), /: is st/, `${origin} at ${width}:\n${rows.join("\n")}`);
    }
  }
});
test("a request names who asked whole, wrapped when long, and its head rows stay pinned", () => {
  const long = approval({ label: "Maximiliano Fernández-Oyarzábal's thread in #release-train-2026-q4-coordination", requester: "Maximiliano Fernández-Oyarzábal" });
  for (const width of [30, 40, 60]) {
    const rows = renderPanel(surface({ approvals: [long] }), 0, plain, width, 0);
    assert.ok(joined(rows).includes("fromMaximilianoFernández-Oyarzábalin#release-train-2026-q4-coordination"), `${width}:\n${rows.join("\n")}`);
  }
});

test("the line names a person whole or not at all: one too long for its room folds into the count", () => {
  const states = [
    { watches: [watch({ partner: { userId: "U1", name: HUGE_NAME } })] },
    { watches: [channelWatch(1, { partner: { userId: "U1", name: HUGE_NAME } }), watch({ key: "D2/1.0", conversation: { kind: "dm-top", channelId: "D2" } })], approvals: [approval()] },
  ];
  const first = HUGE_NAME.split(" ")[0]!;
  for (const engine of states) for (let width = 40; width <= 220; width += 1) {
    const [line] = renderLine(surface(engine), plain, width);
    assert.ok(visibleWidth(line!) <= width, `fits ${width}`);
    if (line!.includes(first.slice(0, 4))) assert.ok(line!.includes(HUGE_NAME), `whole when shown, at ${width}: ${line}`);
    else assert.match(line!, /\d+ watching/, `folded into the count, at ${width}: ${line}`);
    if (engine.approvals) assert.match(line!, /1 waiting/, `the waiting count stays, at ${width}`);
  }
  assert.ok(renderLine(surface(states[0]!), plain, 200)[0]!.includes(HUGE_NAME), "shown whole where it fits");
});

test("in a narrow panel the keys wrap by whole keys, so esc close always shows, and the panel stays in its rows", () => {
  const states = [
    surface({ watches: [watch(), channelWatch(2, { status: "paused", reason: "r", pause: "sendLimit" })] }),
    surface({ watches: [watch()], approvals: [approval({ text: "short" })] }),
  ];
  for (const state of states) for (const selected of [0, 1]) for (let width = 24; width <= 80; width += 1) for (const maxRows of [12, 40]) {
    const rows = renderPanel(state, selected, plain, width, 0, maxRows);
    assert.ok(rows.length <= maxRows, `${rows.length} rows within ${maxRows} at ${width}`);
    assert.ok(rows.every((r) => visibleWidth(r) <= width), `fits ${width}`);
    const keys = rows.slice(rows.findLastIndex((r) => r.replace(/[│ ]/g, "") === "") + 1, -1).join(" ");
    assert.equal(keys.includes("…"), false, `no key cut at ${width}:\n${rows.join("\n")}`);
    assert.match(keys, /esc close/, `esc close at ${width}:\n${rows.join("\n")}`);
  }
});

/** Many people asking at once, with long names, in a long channel: a "from" of several rows. */
function crowdedRequest(text: string): Approval {
  const requester = ["Alexandra Montgomery-Fitzgerald", "Bartholomew Quillfeather", "Maximiliano Fernández-Oyarzábal", "Robin Colleague", "Daniel Fox Smith"].join(", ");
  return approval({ requester, label: `Alexandra Montgomery-Fitzgerald's thread in #data-platform-incidents-emea`, text });
}

test("a request is approvable only after every line of it was within the panel's rows, however long who asked is, and the panel keeps its rows", () => {
  const text = [...Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`), "Last: zebra."].join("\n");
  for (const width of [24, 28, 32, 40, 60]) for (let maxRows = 3; maxRows <= 24; maxRows += 1) {
    const actions: PanelAction[] = [];
    const panel = new Panel(() => surface({ approvals: [crowdedRequest(text)] }), plain, (a) => actions.push(a), () => {}, undefined, () => maxRows);
    let seenEnd = false;
    for (let press = 0; press < 80 && !actions.length; press += 1) {
      const lines = panel.render(width);
      if (maxRows >= 10) assert.ok(lines.length <= maxRows, `${lines.length} rows > ${maxRows} at ${width}`);
      // Only what the overlay shows counts as seen: its first maxRows rows.
      if (lines.slice(0, maxRows).some((l) => l.includes("zebra"))) seenEnd = true;
      if (maxRows >= 12) assert.ok(joined(lines).includes("◐waitingforyourOK"), `the head whole, never cut by the frame, at ${width}:\n${lines.join("\n")}`);
      panel.handleInput("a");
      if (actions.length) assert.ok(seenEnd, `approved at ${width}×${maxRows} before the last line was on screen`);
      panel.handleInput(" ");
    }
    if (maxRows >= 12) assert.equal(actions[0]?.kind, "approve", `approvable once read, at ${width}×${maxRows}`);
  }
});

test("who asked stays in view while a request scrolls, as far as the panel's rows allow", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`).join("\n");
  const view = { selected: 0, offset: 0, allEnded: false, read: new Set<string>() };
  for (const width of [30, 40, 60]) {
    const top = layoutPanel(surface({ approvals: [crowdedRequest(text)] }), view, plain, width, 0, 30).lines;
    const from = top.filter((l) => /from|Fitzgerald|Quillfeather|Oyarzábal|Colleague|Smith|#data-platform/.test(l));
    for (const offset of [5, 20, 999]) {
      const lines = layoutPanel(surface({ approvals: [crowdedRequest(text)] }), { ...view, offset }, plain, width, 0, 30).lines;
      for (const row of from) assert.ok(lines.includes(row), `"${row}" pinned at ${width}, offset ${offset}`);
    }
  }
});

test("a poster's name never ends a row with \u2026: when the row leaves too little for words, the name takes a row of its own", () => {
  const names = ["Alex Montgomery", "Robert Leeeeee", "Daniel Foxworth", "Maximiliano Fernández-Oyarzábal"];
  for (const name of names) for (let width = 24; width <= 60; width += 1) {
    const state = surface({ watches: [channelWatch(1, { channelName: "general", partner: { userId: "U9", name: "Ana" }, context: [{ ts: "1.000002", userId: "U2", userName: name, text: "is staging down for everyone?", agentFooter: false, origin: "person" }] })] });
    const rows = renderPanel(state, 0, plain, width, 0, 40);
    assert.equal(rows.some((r) => r.includes(`${name}\u2026`) || r.includes(`${name.split(" ").at(-1)}\u2026`)), false, `${name} at ${width}:\n${rows.join("\n")}`);
    assert.ok(joined(rows).includes(`${name.replace(/\s/g, "")}:`), `the colon follows the whole name at ${width}:\n${rows.join("\n")}`);
    assert.ok(rows.some((r) => /is( |$)|staging/.test(r.replace(/[│]/g, ""))), `some of the post's words show at ${width}:\n${rows.join("\n")}`);
  }
});

test("a name breaks inside a word only when the word is wider than a row: it starts below the status instead", () => {
  const names = ["Alexandra Montgomery", "Bartholomew Quillfeather", "Robin Colleague", "Ana\u00a0Mariangela López-Gutiérrez", HUGE_NAME];
  for (const name of names) for (let width = 24; width <= 80; width += 1) {
    const rest = width - 4 - 2 - 3;
    for (const state of [
      surface({ watches: [watch({ partner: { userId: "U1", name } })] }, { answering: new Set() }),
      surface({ watches: [watch({ partner: { userId: "U1", name }, rejoining: 0 } as Partial<WatchState>)] }),
      surface({ watches: [channelWatch(1, { channelName: "alerts-prod-payments", partner: { userId: "U1", name } })] }),
    ]) {
      const rows = renderPanel(state, 0, plain, width, 0, 40);
      for (const word of name.split(" ").filter((w) => visibleWidth(w) <= rest)) assert.ok(rows.some((r) => r.includes(word)), `"${word}" whole on one row at ${width}:\n${rows.join("\n")}`);
      assert.ok(rows.some((r) => /[●◌] (watching|catching up)( |│)/.test(r)), `the status whole at ${width}:\n${rows.join("\n")}`);
    }
  }
});

test("a narrow DM row tells its top level from its thread, and keeps its status whole", () => {
  const thread = watch({ key: "D1/1.0", context: [{ ts: "1.000001", userId: "U0", userName: "Owner", text: "Can you check the deploy?", agentFooter: false, origin: "this session" }] });
  const top = watch({ key: "D1", conversation: { kind: "dm-top", channelId: "D1" } });
  for (let width = 24; width <= 60; width += 1) {
    const rows = renderPanel(surface({ watches: [top, thread] }), 0, plain, width, 0, 40);
    const blocks = itemBlocks(rows);
    assert.equal(blocks.length, 2, `${width}:\n${rows.join("\n")}`);
    assert.match(blocks[0]!.replace(/[│\s]+/g, " "), /top level/, `top level at ${width}:\n${rows.join("\n")}`);
    // On a row of its own, the kind keeps the thread's first words.
    assert.match(blocks[1]!.replace(/[│\s]+/g, " "), blocks[1]!.split("\n").length > 1 ? /thread "Can/ : /thread/, `thread at ${width}:\n${rows.join("\n")}`);
    assert.equal(rows.filter((r) => /● watching( |│)/.test(r)).length, 2, `both statuses whole at ${width}:\n${rows.join("\n")}`);
  }
});

test("the line skips a label too long for it and still names the shorter ones after it", () => {
  const long = channelWatch(1, { channelName: "proj-payments-reconciliation-migration-emea", partner: { userId: "U1", name: "Alexandra Okonkwo-Lindqvist" }, lastActivityAt: 9 });
  const short = watch({ key: "D2/1.0", conversation: { kind: "thread", channelId: "D2", threadTs: "1.0" }, partner: { userId: "U2", name: "Bo Li" }, lastNote: "replied: Checked the logs", lastActivityAt: 1 });
  for (let width = 70; width <= 110; width += 1) {
    const [line] = renderLine(surface({ watches: [long, short] }, { answering: new Set([long.key]) }), plain, width);
    assert.match(line!, /Bo Li – /, `the short one named at ${width}: ${line}`);
    if (!line!.includes("Alexandra")) assert.match(line!, /\+1 watching/, `the long one counted at ${width}: ${line}`);
  }
});

test("on the line, a fresh thread's first words give way before its whole channel folds", () => {
  const fresh = (i: number) => channelWatch(i, { channelName: `release-train-2026-q${i}`, partner: undefined, context: [{ ts: "1.0", userId: "U0", userName: "Owner", text: "Deploy checklist for the train, please review before noon", agentFooter: false, origin: "this session" }] });
  for (let width = 70; width <= 100; width += 1) {
    const [line] = renderLine(surface({ watches: [fresh(3), fresh(4)] }), plain, width);
    assert.match(line!, /#release-train-2026-q\d/, `a channel named at ${width}: ${line}`);
    assert.equal(/#release-train-2026-q\d…|q\d "[^"]*$/.test(line!), false, `whole, never cut at ${width}: ${line}`);
  }
});

test("a request entered from below before it was read starts at its top, and is approvable only once every row of it was on screen", () => {
  const text = [...Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`), "Last: zebra."].join("\n");
  for (const [width, maxRows] of [[80, 8], [60, 8], [40, 10], [32, 12]] as const) {
    const engine: EngineState = { ...emptyState(), watches: [watch()] };
    const actions: PanelAction[] = [];
    const panel = new Panel(() => surface(engine), plain, (a) => actions.push(a), () => {}, undefined, () => maxRows);
    panel.render(width);
    engine.approvals = [crowdedRequest(text)]; // arrives above the selected watch
    panel.render(width);
    panel.handleInput("\u001b[A");
    const lines = panel.render(width);
    assert.ok(joined(lines.slice(0, maxRows)).includes("fromAlexandra"), `who asked on screen first at ${width}×${maxRows}:\n${lines.join("\n")}`);
    panel.handleInput("a");
    assert.deepEqual(actions, [], `not approvable on entry at ${width}×${maxRows}`);
  }
  // Rows seen at another width count for nothing: the layout changed.
  const state = surface({ approvals: [crowdedRequest(text)] });
  const view = { selected: 0, offset: 999, allEnded: false, read: new Set<string>() };
  const atEnd = layoutPanel(state, view, plain, 40, 0, 12);
  assert.equal(atEnd.selectedAllSeen, false, "the end alone is not all of it");
  const all = new Set(Array.from({ length: atEnd.selectedSeen.count }, (_, i) => i));
  assert.equal(layoutPanel(state, { ...view, progress: new Map([["a1", { width: 40, count: atEnd.selectedSeen.count, rows: all }]]) }, plain, 40, 0, 12).selectedAllSeen, true, "every row seen at this layout");
  assert.equal(layoutPanel(state, { ...view, progress: new Map([["a1", { width: 60, count: atEnd.selectedSeen.count, rows: all }]]) }, plain, 40, 0, 12).selectedAllSeen, false, "rows seen at another width");
});

test("who asked is pinned whole or scrolls whole, and the window keeps its rows in a short panel", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`).join("\n");
  for (const above of [false, true]) for (let width = 24; width <= 80; width += 4) for (let maxRows = 8; maxRows <= 30; maxRows += 1) {
    const approvals = above ? [approval({ id: "a0", text: "short" }), crowdedRequest(text)] : [crowdedRequest(text)];
    const view = { selected: above ? 1 : 0, offset: 0, allEnded: false, read: new Set<string>() };
    const top = layoutPanel(surface({ approvals }), view, plain, width, 0, maxRows).lines;
    const first = top.findIndex((l) => /from Alexandra/.test(l));
    const body = top.findIndex((l) => /Step 1:/.test(l));
    const from = top.slice(first, body >= 0 ? body : undefined).filter((l) => l.startsWith("│") && !/↓|esc close|approve|deny/.test(l) && l.replace(/[│ ]/g, ""));
    const end = layoutPanel(surface({ approvals }), { ...view, offset: 999 }, plain, width, 0, maxRows);
    const pinned = from.filter((row) => end.lines.includes(row)).length;
    assert.ok(pinned === 0 || pinned === from.length, `${pinned} of ${from.length} "from" rows pinned at ${width}×${maxRows}, above ${above}:\n${end.lines.join("\n")}`);
    if (maxRows >= 12) assert.ok(end.pageRows >= 3, `a window of ${end.pageRows} rows at ${width}×${maxRows}`);
    if (maxRows >= 10) assert.ok(end.lines.length <= maxRows, `${end.lines.length} rows within ${maxRows} at ${width}, above ${above}`);
    if (width <= 30 && maxRows >= 30) assert.ok(joined(end.lines).includes("◐waitingforyourOK"), `the head pinned at ${width}`);
  }
});

test("a tall watch keeps its whole name in view while it scrolls, where the panel has room", () => {
  const activity = Array.from({ length: 3 }, (_, i) => ({ at: i, text: `replied in the thread with a long note number ${i + 1} that wraps nowhere` }));
  const tall = watch({ partner: { userId: "U1", name: "Maximiliano Fernández-Oyarzábal" }, activity, agentPostsWaiting: 1, context: [{ ts: "1.000002", userId: "U1", userName: "Maximiliano Fernández-Oyarzábal", text: "🤖 which migration id should the run use for the shard, and when?", agentFooter: true, origin: "someone's agent" }] });
  for (const width of [26, 30]) {
    const view = { selected: 0, offset: 999, allEnded: false, read: new Set<string>() };
    const end = layoutPanel(surface({ watches: [tall] }), view, plain, width, 0, 16);
    assert.ok(end.pageRows > 0, `tall at ${width}`);
    assert.ok(joined(end.lines).includes("MaximilianoFernández-Oyarzábal"), `the name in view at the end, at ${width}:\n${end.lines.join("\n")}`);
  }
  // In a shorter panel the name scrolls whole: never its first word pinned and the rest scrolled away.
  const channel = { ...tall, key: "C1/1.0", conversation: { kind: "thread" as const, channelId: "C1", threadTs: "1.0" }, channelName: "data-platform-incidents-emea" };
  for (const w of [tall, channel]) for (let width = 24; width <= 80; width += 2) for (let maxRows = 8; maxRows <= 16; maxRows += 1) {
    const end = layoutPanel(surface({ watches: [w] }), { selected: 0, offset: 999, allEnded: false, read: new Set<string>() }, plain, width, 0, maxRows);
    const text = joined(end.lines);
    if (text.includes("Maximiliano")) assert.ok(text.includes("MaximilianoFernández-Oyarzábal"), `part of the name at ${width}×${maxRows}:\n${end.lines.join("\n")}`);
  }
});

test("on the line, first words never cost another conversation its name, and no two named conversations read the same", () => {
  const fresh = (i: number, channelName: string, text: string, conversation?: WatchState["conversation"]) => channelWatch(i, { channelName, partner: undefined, lastActivityAt: 10 - i, context: [{ ts: "1.0", userId: "U0", userName: "Owner", text, agentFooter: false, origin: "this session" }], ...(conversation ? { conversation, key: `${conversation.channelId}/x${i}` } : {}) });
  const words = "Deploy checklist for the train, please review before noon";
  const apart = [fresh(1, "release-train-2026-q3", words), fresh(2, "release-train-2026-q4", words), channelWatch(3, { channelName: "general", partner: { userId: "U3", name: "Robin Colleague" }, lastActivityAt: 0 })];
  const alike = [fresh(1, "alerts", "Rollback plan for the payments service"), fresh(2, "alerts", "Is staging down for everyone?")];
  const sameWords = [fresh(1, "general", words), fresh(2, "general", words)];
  const dm = (text: string) => [fresh(1, "", text, { kind: "thread", channelId: "D7", threadTs: "1.0" })];
  const labels = (line: string) => line.replace(/ {2,}alt\+s.*$/, "").split(" · ").slice(1).map((part) => part.split(/ – | (?=catching up|answering|paused)/)[0]!);
  for (let width = 30; width <= 200; width += 1) {
    const line = renderLine(surface({ watches: apart }), plain, width)[0]!;
    // Words beside a name while a conversation folds: without them, the next one still would not fit.
    if (line.includes('"') && /\+\d watching/.test(line)) {
      const left = line.split(/ {2,}alt\+s/)[0]!.replace(/ "[^"]*"/, "");
      const next = /q4/.test(line) ? "Robin Colleague #general – watching" : "#release-train-2026-q4 – watching";
      assert.ok(visibleWidth(`${left} · ${next}  alt+s`) > width, `words cost a name at ${width}: ${line}`);
    }
    for (const state of [alike, sameWords]) {
      const shown = renderLine(surface({ watches: state }), plain, width)[0]!;
      const named = labels(shown).filter((l) => l.startsWith("#"));
      assert.equal(new Set(named).size, named.length, `two alike at ${width}: ${shown}`);
      // A twin folded into the count leaves the other its bare name, where that fits.
      if (visibleWidth(" ● slack · #alerts – watching · +1 watching  alt+s") <= width && state === alike) assert.match(shown, /#alerts/, `named where it fits at ${width}: ${shown}`);
    }
  }
  assert.match(renderLine(surface({ watches: apart }), plain, 200)[0]!, /#release-train-2026-q3 "Deploy/, "first words where there is room");
  for (let width = 60; width <= 120; width += 1) assert.match(renderLine(surface({ watches: dm("Can you check the flaky deploy?") }), plain, width)[0]!, /DM "Can you check t…" – watching/, `a fresh DM by its first words at ${width}`);
  for (let width = 38; width <= 120; width += 1) assert.match(renderLine(surface({ watches: dm("ok?") }), plain, width)[0]!, /DM "ok\?"/, `short first words are the shortest name, at ${width}`);
});

test("only what Pi paints counts as seen: keys that arrive together before a paint never make a request approvable", () => {
  const text = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1}.`).join("\n");
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface({ approvals: [approval({ text })] }), plain, (a) => actions.push(a), () => {}, undefined, () => 20);
  panel.render(80);
  for (let i = 0; i < 6; i += 1) panel.handleInput(" "); // one burst, then one paint
  panel.handleInput("a");
  assert.deepEqual(actions, [], "approved from rows never painted");
  const end = panel.render(80).join("\n");
  assert.match(end, /Step 40/);
  assert.match(end, /↑ read all to approve/, "the end says how to go on");
  assert.match(end, /↑↓ move/);
  panel.handleInput("a");
  assert.deepEqual(actions, [], "the end alone is not all of it");
});

test("a request half read when the panel's width changes starts again at its top, and is approvable once read at the new width", () => {
  const text = Array.from({ length: 30 }, (_, i) => `Step ${i + 1}: migrate shard ${i + 1} of the results table.`).join("\n");
  const actions: PanelAction[] = [];
  const panel = new Panel(() => surface({ approvals: [crowdedRequest(text)] }), plain, (a) => actions.push(a), () => {}, undefined, () => 14);
  panel.render(60);
  for (let i = 0; i < 2; i += 1) {
    panel.handleInput(" ");
    panel.render(60);
  }
  const resized = panel.render(50);
  assert.ok(joined(resized.slice(0, 14)).includes("fromAlexandra"), `back at the top:\n${resized.join("\n")}`);
  let presses = 0;
  while (!actions.length && presses < 60) {
    panel.handleInput("a");
    panel.handleInput(" ");
    panel.render(50);
    presses += 1;
  }
  assert.equal(actions[0]?.kind, "approve", "approvable once read through at the new width");
  assert.ok(panel.render(50).join("\n").includes("Step 30"));
});

test("when every label of a conversation is already shown, the line counts it and never throws", () => {
  const fresh = (i: number, channelId: string, text: string, channelName?: string) =>
    channelWatch(i, { key: `${channelId}/1.00000${i}`, conversation: { kind: "thread", channelId, threadTs: `1.00000${i}` }, ...(channelName ? { channelName } : {}), partner: undefined, lastActivityAt: 10 - i, context: [{ ts: `1.00000${i}`, userId: "U0", userName: "Owner", text, agentFooter: false, origin: "this session" }] });
  const dms = [1, 2, 3].map((i) => fresh(i, `D${i}`, `Can you review the PR #${i}?`));
  const threads = [1, 2, 3].map((i) => fresh(i, "C0GEN", `Can you review the PR #${i}?`, "general"));
  for (const watches of [dms, threads]) {
    for (let width = 20; width <= 200; width += 1) {
      const [line] = renderLine(surface({ watches }), plain, width);
      assert.ok(visibleWidth(line!) <= width, `fits ${width}`);
      const left = line!.split(/ {2,}alt\+s/)[0]!;
      const named = (left.match(/ – watching/g) ?? []).length;
      const counted = Number(/(\d+) watching/.exec(left.replace(/ – watching/g, ""))?.[1] ?? 0);
      if (named + counted > 0) assert.equal(named + counted, 3, `every watch named or counted at ${width}: ${line}`);
    }
  }
  assert.match(renderLine(surface({ watches: dms }), plain, 120)[0]!, /a direct message – watching · DM "Can you review…" – watching · \+1 watching/, "the third reads like the second, so it is counted");
  assert.match(renderLine(surface({ watches: threads }), plain, 120)[0]!, /#general – watching · #general "Can you review…" – watching · \+1 watching/);
});
