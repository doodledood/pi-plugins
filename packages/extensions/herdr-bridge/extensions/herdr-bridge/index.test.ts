import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeHerdr } from "./fake-herdr.ts";
import { Herdr } from "./herdr.ts";
import { ENDED_ENTRY, PHASE_ENTRY, STARTED_ENTRY, type BridgeApi, createHerdrBridge, quietIntervalFrom } from "./index.ts";
import { WAKEUP_TYPE } from "./messages.ts";

const HERDR_ENV = { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" };

class FakePi {
  handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  tools: any[] = [];
  messages: { message: any; options: any }[] = [];
  entries: { type: string; customType: string; data: any }[] = [];
  emitted: { channel: string; data: any }[] = [];
  events = { emit: (channel: string, data: unknown) => void this.emitted.push({ channel, data }) };
  on(event: string, handler: (event: any, ctx: any) => unknown) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  registerTool(tool: any) {
    this.tools.push(tool);
  }
  sendMessage(message: any, options?: any) {
    this.messages.push({ message, options });
  }
  appendEntry(customType: string, data?: unknown) {
    this.entries.push({ type: "custom", customType, data });
  }
  async fire(event: string, payload: any = {}, ctx: any = {}) {
    for (const handler of this.handlers.get(event) ?? []) await handler(payload, ctx);
  }
}

class Clock {
  t = 0;
  timers: { fn: () => void; ms: number }[] = [];
  now = () => this.t;
  setInterval = (fn: () => void, ms: number) => {
    const timer = { fn, ms };
    this.timers.push(timer);
    return timer;
  };
  clearInterval = (handle: unknown) => {
    this.timers = this.timers.filter((t) => t !== handle);
  };
  async tick(ms: number) {
    this.t += ms;
    for (const timer of [...this.timers]) timer.fn();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function setup(env: NodeJS.ProcessEnv = HERDR_ENV, fake = new FakeHerdr()) {
  const clock = new Clock();
  const pi = new FakePi();
  const bridgeEnv = { HERDR_BRIDGE_QUIET_INTERVAL_MS: "60000", ...env };
  createHerdrBridge({ herdr: new Herdr(fake.run), env: bridgeEnv, now: clock.now, setInterval: clock.setInterval, clearInterval: clock.clearInterval })(pi as unknown as BridgeApi);
  return { fake, clock, pi };
}

/** A branch holding one started session, so a gated-off bridge would have something to poll. */
const STARTED = [{ type: "custom", customType: STARTED_ENTRY, data: { name: "w", paneId: "w1:p2" } }];

const tui = (entries: any[] = [], cwd = "/") => ({ mode: "tui", cwd, sessionManager: { getBranch: () => entries } });

test("outside the primary interactive Pi of a Herdr pane it registers nothing, emits nothing, runs nothing", async () => {
  const conditions: [string, NodeJS.ProcessEnv, any][] = [
    ["no HERDR_ENV", { HERDR_PANE_ID: "w1:p1" }, tui(STARTED)],
    ["print mode", HERDR_ENV, { ...tui(STARTED), mode: "print" }],
    ["json mode", HERDR_ENV, { ...tui(STARTED), mode: "json" }],
    ["rpc mode", HERDR_ENV, { ...tui(STARTED), mode: "rpc" }],
    // In-process children bind no terminal UI: pi-subagents calls bindExtensions({}) and panel
    // panelists never bind, so Pi reports its default mode, print.
    ["pi-subagents subagent", HERDR_ENV, { ...tui(STARTED), mode: "print" }],
    ["panel panelist", HERDR_ENV, { ...tui(STARTED), mode: "print" }],
  ];
  for (const [label, env, ctx] of conditions) {
    const { fake, clock, pi } = setup(env);
    await pi.fire("session_start", { reason: "startup" }, ctx);
    await pi.fire("ui_prompt_start", { title: "Pick" });
    await clock.tick(10_000);
    assert.equal(pi.tools.length, 0, `${label}: no tools`);
    assert.equal(pi.emitted.length, 0, `${label}: no events`);
    assert.equal(clock.timers.length, 0, `${label}: no timers`);
    assert.equal(fake.commands.length, 0, `${label}: no herdr command`);
    await pi.fire("session_shutdown");
  }

  // A BTW aside binds the terminal UI too, but runs in the primary session's process.
  const primary = setup();
  await primary.pi.fire("session_start", {}, tui());
  const btw = setup();
  await btw.pi.fire("session_start", {}, tui(STARTED));
  await btw.pi.fire("ui_prompt_start", { title: "Pick" });
  await btw.clock.tick(10_000);
  assert.equal(btw.pi.tools.length, 0, "btw child: no tools");
  assert.equal(btw.pi.emitted.length, 0, "btw child: no events");
  assert.equal(btw.clock.timers.length, 0, "btw child: no timers");
  assert.equal(btw.fake.commands.length, 0, "btw child: no herdr command");
  assert.equal(primary.pi.tools.length, 1, "the primary session has the tool");
  await primary.pi.fire("session_shutdown");
  await btw.pi.fire("session_shutdown");
});

test("after the primary session shuts down (a reload), the next runtime takes over", async () => {
  const first = setup();
  await first.pi.fire("session_start", {}, tui());
  await first.pi.fire("session_shutdown");
  const second = setup();
  await second.pi.fire("session_start", {}, tui());
  assert.equal(second.pi.tools.length, 1);
  await second.pi.fire("session_shutdown");
});

test("a dialog marks the session blocked in Herdr until it closes, labelled with its title", async () => {
  const { pi } = setup();
  await pi.fire("session_start", {}, tui());
  await pi.fire("ui_prompt_start", { kind: "select", title: "Pick a topic" });
  await pi.fire("ui_prompt_end", { kind: "select" });
  await pi.fire("ui_prompt_start", { kind: "custom" });
  assert.deepEqual(pi.emitted, [
    { channel: "herdr:blocked", data: { active: true, label: "Pick a topic" } },
    { channel: "herdr:blocked", data: { active: false } },
    { channel: "herdr:blocked", data: { active: true, label: "waiting for an answer" } },
  ]);
  await pi.fire("session_shutdown");
});

// Holds docs/adr/20261028-host-pi-in-herdr-and-ship-a-bridge.md — weakening this test reverses that decision.
test("a started session wakes its starter on each change, and the package closes and types nothing", async () => {
  const { fake, clock, pi } = setup();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "herdr-bridge-index-")));
  await pi.fire("session_start", {}, tui([], dir));
  const tool = pi.tools[0];
  assert.equal(tool.name, "start_agent_session");
  const result = await tool.execute("call-1", { folder: dir, name: "worker", prompt: "do it" });
  assert.match(result.content[0].text, /Started Pi session "worker"/);
  assert.equal(pi.entries.filter((e) => e.customType === STARTED_ENTRY).length, 1);
  const worker = fake.panes.find((p) => p.agent?.name === "worker")!;

  worker.agent!.status = "working";
  await clock.tick(2_000);
  assert.equal(pi.messages.length, 0, "starting work wakes nobody");

  worker.agent!.status = "idle";
  worker.agent!.completionSeq = 1;
  await clock.tick(2_000);
  worker.agent!.status = "done";
  await clock.tick(2_000);
  assert.equal(pi.messages.length, 1, "one finished wake-up; done after idle adds none");
  assert.match(pi.messages[0]!.message.content, /finished a turn/);
  assert.deepEqual(pi.messages[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(pi.messages[0]!.message.customType, WAKEUP_TYPE);

  worker.agent!.status = "blocked";
  fake.screens.set("worker", "\n\nWhich topic?\n1. Software\n2. Insurance\n3. Type something.\n\n");
  await clock.tick(2_000);
  const blocked = pi.messages[1]!.message.content as string;
  assert.match(blocked, /waiting at a question/);
  assert.match(blocked, /Which topic\?\n1\. Software\n2\. Insurance/);
  assert.match(blocked, /herdr agent send-keys worker N/);
  assert.match(blocked, /Bring a call that needs the person to them/);

  worker.agent!.status = "working";
  await clock.tick(2_000);
  await clock.tick(60_000);
  assert.match(pi.messages[2]!.message.content, /working for 1 minutes with no change/);

  fake.panes = fake.panes.filter((p) => p !== worker);
  await clock.tick(2_000);
  assert.match(pi.messages[3]!.message.content, /has exited or its pane closed/);
  assert.equal(pi.entries.filter((e) => e.customType === ENDED_ENTRY).length, 1);
  assert.equal(clock.timers.length, 0, "polling stops once nothing is tracked");
  assert.ok(pi.entries.some((e) => e.customType === PHASE_ENTRY));

  const writes = fake.writes().map((c) => `${c[0]} ${c[1]}`);
  assert.deepEqual(writes, ["workspace create", "agent start", "agent prompt"], "only the start sequence; nothing closed, typed or answered");
  await pi.fire("session_shutdown");
});

test("a reload or resume picks the started sessions up again from the session's own entries", async () => {
  const { fake, clock, pi } = setup();
  fake.workspaces.push({ workspaceId: "w1", label: "x" });
  fake.panes.push({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/", agent: { name: "alive", kind: "pi", status: "working", completionSeq: 3 } });
  const entries = [
    { type: "custom", customType: STARTED_ENTRY, data: { name: "alive", paneId: "w1:p2", completionSeq: 2 } },
    { type: "custom", customType: PHASE_ENTRY, data: { paneId: "w1:p2", phase: "working", completionSeq: 3 } },
    { type: "custom", customType: STARTED_ENTRY, data: { name: "exited", paneId: "w1:p9", completionSeq: 0 } },
    { type: "custom", customType: STARTED_ENTRY, data: { name: "old", paneId: "w1:p8" } },
    { type: "custom", customType: ENDED_ENTRY, data: { paneId: "w1:p8" } },
  ];
  await pi.fire("session_start", { reason: "reload" }, tui(entries));
  await clock.tick(2_000);
  assert.equal(pi.messages.length, 1, "the session that exited while it was down is reported once; the ended one is not");
  assert.match(pi.messages[0]!.message.content, /`exited`.*has exited/);
  fake.panes[0]!.agent!.status = "idle";
  fake.panes[0]!.agent!.completionSeq = 4;
  await clock.tick(2_000);
  assert.match(pi.messages[1]!.message.content, /`alive`.*finished a turn/);
  await pi.fire("session_shutdown");
});

test("a poller that keeps failing wakes the session once to say so, and keeps trying", async () => {
  const { fake, clock, pi } = setup();
  await pi.fire("session_start", {}, tui(STARTED));
  fake.failures.set("agent list", { code: "server_unreachable", message: "no server" });
  for (let i = 0; i < 6; i++) await clock.tick(2_000);
  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0]!.message.content, /cannot read Herdr.*no server/);
  assert.deepEqual(pi.messages[0]!.options, { triggerTurn: true, deliverAs: "followUp" }, "an idle orchestrator must hear it");
  assert.equal(clock.timers.length, 1, "still polling");
  await pi.fire("session_shutdown");
  assert.equal(clock.timers.length, 0, "shutdown stops polling");
});

test("Herdr output that changed shape fails loudly instead of reporting every session gone", async () => {
  const fake = new FakeHerdr();
  fake.panes.push({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/", agent: { name: "w", kind: "pi", status: "working" } });
  const { clock, pi } = setup(HERDR_ENV, fake);
  await pi.fire("session_start", {}, tui(STARTED));
  fake.brokenAgentList = true;
  for (let i = 0; i < 3; i++) await clock.tick(2_000);
  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0]!.message.content, /returned no agents list.*changed shape/);
  assert.ok(!pi.entries.some((e) => e.customType === ENDED_ENTRY), "nothing is recorded as gone");
  await pi.fire("session_shutdown");
});

test("a finish already reported is not reported again after a reload", async () => {
  const fake = new FakeHerdr();
  fake.panes.push({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/", agent: { name: "w", kind: "pi", status: "working", completionSeq: 1 } });
  const first = setup(HERDR_ENV, fake);
  await first.pi.fire("session_start", {}, tui([{ type: "custom", customType: STARTED_ENTRY, data: { name: "w", paneId: "w1:p2", completionSeq: 1 } }]));
  fake.panes[0]!.agent!.status = "idle";
  fake.panes[0]!.agent!.completionSeq = 2;
  await first.clock.tick(2_000);
  assert.equal(first.pi.messages.length, 1, "the finish is reported once");
  const kept = [{ type: "custom", customType: STARTED_ENTRY, data: { name: "w", paneId: "w1:p2", completionSeq: 1 } }, ...first.pi.entries];
  await first.pi.fire("session_shutdown");

  const reloaded = setup(HERDR_ENV, fake);
  await reloaded.pi.fire("session_start", { reason: "reload" }, tui(kept));
  await reloaded.clock.tick(2_000);
  await reloaded.clock.tick(2_000);
  assert.equal(reloaded.pi.messages.length, 0, "the reloaded bridge picks up where it was and repeats nothing");
  await reloaded.pi.fire("session_shutdown");
});

test("a waiting session whose screen cannot be read still wakes, with the command to read it", async () => {
  const fake = new FakeHerdr();
  fake.panes.push({ paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/", agent: { name: "w", kind: "pi", status: "working" } });
  const { clock, pi } = setup(HERDR_ENV, fake);
  await pi.fire("session_start", {}, tui(STARTED));
  fake.failures.set("agent read", { code: "agent_not_found", message: "gone" });
  fake.panes[0]!.agent!.status = "blocked";
  await clock.tick(2_000);
  assert.equal(pi.messages.length, 1);
  assert.match(pi.messages[0]!.message.content, /screen could not be read; read it with `herdr agent read w --source visible`/);
  assert.match(pi.messages[0]!.message.content, /herdr agent send-keys w N/);
  await pi.fire("session_shutdown");
});


test("the quiet interval is ten minutes unless set to a positive number of ms", () => {
  assert.equal(quietIntervalFrom({}), 10 * 60_000);
  assert.equal(quietIntervalFrom({ HERDR_BRIDGE_QUIET_INTERVAL_MS: "8000" }), 8000);
  for (const bad of ["-5", "0", "soon"]) assert.equal(quietIntervalFrom({ HERDR_BRIDGE_QUIET_INTERVAL_MS: bad }), 10 * 60_000, bad);
});
