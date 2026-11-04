// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md: one line above the editor with
// the watches and the waiting count, and a panel that shows each request's full text.
import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyState, type Approval, type EngineState, type WatchState } from "./engine.ts";
import { Panel, renderLine, renderPanel, type Paint, type PanelAction, type SurfaceState } from "./ui.ts";

const plain: Paint = { fg: (_c, t) => t, bold: (t) => t };

function watch(over: Partial<WatchState> = {}): WatchState {
  return {
    key: "D1/1.000001", conversation: { kind: "thread", channelId: "D1", threadTs: "1.000001" }, label: "DM with Robin Colleague · thread",
    startedBy: "send", status: "active", point: { checkpoint: "1.000001", seen: [] }, ownPosts: [], context: [], inbox: [],
    sendsWithoutOwner: 0, lastActivityAt: 0, agentLineSent: true, spend: { day: "2026-11-04", usd: 0 }, ...over,
  };
}

function approval(over: Partial<Approval> = {}): Approval {
  return { id: "a1", watchKey: "D1/1.000001", requester: "Robin Colleague", text: "Rerun the eval on the new KB docs,\nthen drop the old results table", at: 0, status: "pending", ...over };
}

function surface(engine: Partial<EngineState>, over: Partial<SurfaceState> = {}): SurfaceState {
  return { enabled: true, engine: { ...emptyState(), ...engine }, panelKey: "alt+s", ...over };
}

test("no line when off or nothing is watched; a problem shows instead of watches", () => {
  assert.deepEqual(renderLine(surface({}, { enabled: false }), plain, 120), []);
  assert.deepEqual(renderLine(surface({}), plain, 120), []);
  assert.match(renderLine(surface({}, { problem: "pi-mcp-adapter is not installed" }), plain, 120)[0]!, /pi-mcp-adapter is not installed/);
});

test("the line names the watch, what the helper last did, and how many approvals wait", () => {
  const [line] = renderLine(surface({ watches: [watch({ lastNote: "replied: Checked" })], approvals: [approval()] }), plain, 200);
  assert.match(line!, /slack · DM with Robin Colleague · thread replied: Checked · 1 waiting for you · alt\+s/);
  const [paused] = renderLine(surface({ watches: [watch({ status: "paused", reason: "sent 5 messages without you" })] }), plain, 200);
  assert.match(paused!, /paused \(sent 5 messages without you\)/);
  const [stopped] = renderLine(surface({ watches: [watch({ status: "error", reason: "slack_read_thread failed" })] }), plain, 200);
  assert.match(stopped!, /stopped: DM with Robin Colleague · thread — slack_read_thread failed/);
  assert.equal(visibleWidth(renderLine(surface({ watches: [watch({ lastNote: "x".repeat(400) })] }), plain, 60)[0]!) <= 60, true, "one line, cut to width");
});

test("the panel lists approvals first with their full text, then watches, with the keys that apply", () => {
  const lines = renderPanel(surface({ watches: [watch({ lastNote: "asked you to approve" })], approvals: [approval()] }), 0, plain, 100);
  const text = lines.join("\n");
  assert.match(text, /◐ waiting for your OK · Robin Colleague · DM with Robin Colleague · thread/);
  assert.match(text, /Rerun the eval on the new KB docs,\n.*then drop the old results table/);
  assert.match(text, /a approve · d deny/);
  assert.ok(text.indexOf("waiting for your OK") < text.indexOf("● watching"));
  assert.match(renderPanel(surface({}, { enabled: false }), 0, plain, 100).join("\n"), /\/slack on turns it on/);
  assert.match(renderPanel(surface({}), 0, plain, 100).join("\n"), /Nothing watched yet/);
});

test("panel keys map to owner actions only", () => {
  const actions: PanelAction[] = [];
  let closed = false;
  const state = surface({ watches: [watch({ status: "paused", reason: "r" })], approvals: [approval()] });
  const panel = new Panel(() => state, plain, (a) => actions.push(a), () => { closed = true; });
  panel.handleInput("a");
  panel.handleInput("\u001b[B");
  panel.handleInput("r");
  panel.handleInput("s");
  panel.handleInput("\u001b");
  assert.deepEqual(actions, [{ kind: "approve", id: "a1" }, { kind: "resume", key: "D1/1.000001" }, { kind: "stop", key: "D1/1.000001" }]);
  assert.equal(closed, true);
});
