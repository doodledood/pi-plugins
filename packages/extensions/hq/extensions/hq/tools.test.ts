import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { seedDoctrine } from "./doctrine.ts";
import { HqStore } from "./store.ts";
import {
  dropRoot,
  fixedClock,
  makeRoot,
  makeStore,
  packetDraftFixture,
  recordingSpawner,
} from "./testing.ts";
import { buildAskRows, registerHqTools, toTriageOutcome, type ToolDeps } from "./tools.ts";
import type { Packet } from "./types.ts";
import type { SpawnRequest } from "./spawn.ts";

interface Harness {
  root: string;
  store: HqStore;
  tools: Map<string, ToolDefinition>;
  calls: SpawnRequest[];
  deps: ToolDeps;
  selects: string[];
  inputs: string[];
  /** Queued answers for ctx.ui.select, in order. */
  answers: Array<string | undefined>;
  /** Queued answers for ctx.ui.input, in order. */
  typed: Array<string | undefined>;
  ctx: ExtensionContext;
}

async function harness(label: string, options: { seatActive?: boolean; env?: NodeJS.ProcessEnv; maxWorkers?: number } = {}): Promise<Harness> {
  const root = await makeRoot(label);
  const now = fixedClock();
  const store = makeStore(root, now);
  await store.ensure();
  await seedDoctrine(root);
  const { spawner, calls } = recordingSpawner();

  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;

  const selects: string[] = [];
  const inputs: string[] = [];
  const answers: Array<string | undefined> = [];
  const typed: Array<string | undefined> = [];

  const deps: ToolDeps = {
    store,
    spawner,
    now,
    isSeatActive: () => options.seatActive ?? true,
    defaultCwd: () => "/work/alpha",
    doneToday: async () => 0,
    maxConcurrentWorkers: options.maxWorkers ?? 10,
    env: options.env ?? {},
  };
  registerHqTools(pi, deps);

  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: "/work/alpha",
    ui: {
      select: async (title: string) => {
        selects.push(title);
        return answers.shift();
      },
      input: async (title: string) => {
        inputs.push(title);
        return typed.shift();
      },
      notify: () => {},
      confirm: async () => true,
    },
  } as unknown as ExtensionContext;

  return { root, store, tools, calls, deps, selects, inputs, answers, typed, ctx };
}

let queued = 0;

async function queue(h: Harness, overrides: Partial<Packet> = {}): Promise<Packet> {
  // Each call is a distinct question; identical ones are deduplicated by the store.
  queued += 1;
  const { packet } = await h.store.createPacket({
    ...packetDraftFixture({ title: `decide ${queued}`, question: `what about ${queued}?` }),
    ...overrides,
  } as never);
  return packet;
}

async function ask(h: Harness, packetIds: string[]): Promise<string> {
  const tool = h.tools.get("hq_ask");
  assert.ok(tool);
  const result = await tool.execute("call", { packetIds } as never, undefined, undefined, h.ctx);
  return result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
}

test("the ask rows put the recommendation first and carry the ruling each one means", async () => {
  const h = await harness("hq-tools-rows");
  try {
    const packet = await queue(h);
    const rows = buildAskRows(packet);
    assert.match(rows[0]?.label ?? "", /^1\) Retry the suite \(recommended\)/);
    assert.match(rows[0]?.label ?? "", /eight minutes of CI/);
    assert.deepEqual(rows[0]?.intent, {
      kind: "ruling",
      request: { packetId: packet.id, form: "accept" },
    });
    assert.match(rows[1]?.label ?? "", /^2\) Investigate the flake now — an hour of work/);
    assert.deepEqual(rows[1]?.intent, {
      kind: "ruling",
      request: { packetId: packet.id, form: "alternative", optionId: "investigate" },
    });
    assert.deepEqual(
      rows.slice(2).map((row) => row.intent.kind),
      ["needs-question", "needs-words", "dive"],
    );
    // Every row is distinguishable even if the model wrote identical labels.
    assert.equal(new Set(rows.map((row) => row.label)).size, rows.length);
    assert.match(rows[2]?.label ?? "", /Ask first/);
    assert.match(rows[3]?.label ?? "", /own words/);
    assert.match(rows[4]?.label ?? "", /had to open the session/);
  } finally {
    await dropRoot(h.root);
  }
});

test("choosing the recommendation records an accept and resumes the work", async () => {
  const h = await harness("hq-tools-accept");
  try {
    const packet = await queue(h);
    h.answers.push(buildAskRows(packet)[0]?.label);
    const report = await ask(h, [packet.id]);
    assert.match(report, /ruled \(accept/);

    const rulings = await h.store.listRulings();
    assert.equal(rulings.length, 1);
    assert.equal(rulings[0]?.form, "accept");
    assert.equal(rulings[0]?.optionId, "retry");
    assert.equal(h.calls.filter((call) => call.kind === "continuation").length, 1);
  } finally {
    await dropRoot(h.root);
  }
});

test("an option whose label starts with the recommendation's is still recorded as itself", async () => {
  const h = await harness("hq-tools-prefix");
  try {
    // Labels are model-authored; a refinement of the recommended option is ordinary.
    const packet = await queue(h, {
      options: [
        { id: "retry", label: "Retry the suite", price: "eight minutes of CI" },
        {
          id: "retry-after-fix",
          label: "Retry the suite after fixing the fixture",
          price: "twenty minutes, and the fixture stops flaking",
        },
      ],
      recommendationId: "retry",
    } as Partial<Packet>);

    const rows = buildAskRows(packet);
    h.answers.push(rows[1]?.label);
    await ask(h, [packet.id]);

    const ruling = (await h.store.listRulings())[0];
    assert.equal(ruling?.form, "alternative", "the prefix must not swallow the alternative");
    assert.equal(ruling?.optionId, "retry-after-fix");
    assert.equal(ruling?.shadowAgreed, false, "the shadow ruling picked the other option");
    const continuation = h.calls.find((call) => call.kind === "continuation");
    assert.match(continuation?.prompt ?? "", /after fixing the fixture/);
  } finally {
    await dropRoot(h.root);
  }
});

test("deferring one packet does not block the next one in the same ask", async () => {
  const h = await harness("hq-tools-defer");
  try {
    const first = await queue(h);
    const second = await queue(h);

    h.answers.push("Decide them one at a time"); // the batch ask comes first
    h.answers.push(buildAskRows(first)[2]?.label); // "Ask first"
    h.typed.push("what did the failure log actually say?");
    h.answers.push(buildAskRows(second)[0]?.label); // accept the second

    const report = await ask(h, [first.id, second.id]);
    const lines = report.split("\n");
    assert.equal(lines.length, 2, "both packets were handled in one cycle");
    assert.match(lines[0] ?? "", /deferred to a drill/);
    assert.match(lines[1] ?? "", /ruled \(accept/);

    assert.equal((await h.store.readPacket(first.id))?.status, "drilling");
    assert.equal((await h.store.readPacket(second.id))?.status, "ruled");
    assert.equal(h.calls.filter((call) => call.kind === "drill").length, 1);
  } finally {
    await dropRoot(h.root);
  }
});

test("a dive is logged with the ruling the user gave once they had looked", async () => {
  const h = await harness("hq-tools-dive");
  try {
    const packet = await queue(h);
    const rows = buildAskRows(packet);
    h.answers.push(rows[4]?.label); // the dive row
    h.typed.push("which test actually failed");
    h.answers.push(rows[1]?.label); // then an alternative

    await ask(h, [packet.id]);

    const defects = await h.store.readDefects();
    assert.equal(defects.length, 1);
    assert.equal(defects[0]?.packetId, packet.id);
    assert.equal(defects[0]?.missing, "which test actually failed");
    assert.match(defects[0]?.ruling ?? "", /Investigate/, "the defect names what was decided");
    assert.equal((await h.store.listRulings())[0]?.form, "alternative");
  } finally {
    await dropRoot(h.root);
  }
});

test("abandoning the dialog leaves the packet pending and records nothing", async () => {
  const h = await harness("hq-tools-escape");
  try {
    const packet = await queue(h);
    h.answers.push(undefined);
    const report = await ask(h, [packet.id]);
    assert.match(report, /left pending/);
    assert.deepEqual(await h.store.listRulings(), []);
    assert.equal((await h.store.readPacket(packet.id))?.status, "pending");
  } finally {
    await dropRoot(h.root);
  }
});

test("a blank deferral question leaves the packet pending, and a dive is still logged", async () => {
  const h = await harness("hq-tools-blank");
  try {
    const packet = await queue(h);
    const rows = buildAskRows(packet);
    h.answers.push(rows[4]?.label); // dive
    h.typed.push("the failing assertion");
    h.answers.push(rows[2]?.label); // then defer
    h.typed.push("   "); // but type nothing

    const report = await ask(h, [packet.id]);
    assert.match(report, /left pending/);
    assert.deepEqual(await h.store.listRulings(), []);
    const defects = await h.store.readDefects();
    assert.equal(defects.length, 1, "the dive is the signal worth keeping either way");
    assert.equal(defects[0]?.ruling, "(left pending)");
  } finally {
    await dropRoot(h.root);
  }
});

test("a held packet is never presented, even if its id is passed straight to the ask", async () => {
  const h = await harness("hq-tools-held");
  try {
    const held = await queue(h, { flipCondition: "TBD" } as Partial<Packet>);
    const report = await ask(h, [held.id]);
    assert.match(report, /held, not presentable/);
    assert.deepEqual(h.selects, [], "nothing was put to the user");
  } finally {
    await dropRoot(h.root);
  }
});

test("the seat's tools refuse a worker session and an unseated session", async () => {
  const worker = await harness("hq-tools-worker", { env: { HQ_MANAGED: "1", HQ_KIND: "worker" } });
  const unseated = await harness("hq-tools-unseated", { seatActive: false });
  try {
    for (const h of [worker, unseated]) {
      const tool = h.tools.get("hq_queue_plan");
      assert.ok(tool);
      const result = await tool.execute("call", {} as never, undefined, undefined, h.ctx);
      const body = result.content.map((part) => ("text" in part ? part.text : "")).join(" ");
      assert.match(body, /Refused/);
    }
  } finally {
    await dropRoot(worker.root);
    await dropRoot(unseated.root);
  }
});

test("the delegate cap counts only workers that are actually alive", async () => {
  const h = await harness("hq-tools-cap", { maxWorkers: 1 });
  try {
    const { sessionStateFixture } = await import("./testing.ts");
    // A worker that died without publishing must not hold its slot forever.
    await h.store.publishSessionState(
      sessionStateFixture({ sessionId: "dead", pid: 999_999_999, state: "running" }),
    );
    const tool = h.tools.get("hq_delegate");
    assert.ok(tool);
    const first = await tool.execute(
      "call",
      { task: "do a thing" } as never,
      undefined,
      undefined,
      h.ctx,
    );
    assert.match(
      first.content.map((part) => ("text" in part ? part.text : "")).join(" "),
      /Delegated/,
    );

    await h.store.publishSessionState(
      sessionStateFixture({ sessionId: "alive", pid: process.pid, state: "running" }),
    );
    const second = await tool.execute(
      "call",
      { task: "and another" } as never,
      undefined,
      undefined,
      h.ctx,
    );
    assert.match(
      second.content.map((part) => ("text" in part ? part.text : "")).join(" "),
      /already running/,
    );
  } finally {
    await dropRoot(h.root);
  }
});

test("the seat can drill a packet without waiting for the answer", async () => {
  const h = await harness("hq-tools-drill");
  try {
    const packet = await queue(h);
    const tool = h.tools.get("hq_drill");
    assert.ok(tool, "the seat has a drill tool, as its prompt promises");
    const result = await tool.execute(
      "call",
      { packetId: packet.id, question: "what did the log say?" } as never,
      undefined,
      undefined,
      h.ctx,
    );
    assert.match(
      result.content.map((part) => ("text" in part ? part.text : "")).join(" "),
      /Drilling/,
    );
    assert.equal((await h.store.readPacket(packet.id))?.status, "drilling");
    assert.equal(h.calls.filter((call) => call.kind === "drill").length, 1);
  } finally {
    await dropRoot(h.root);
  }
});

test("a triage submission missing its required parts is refused, not half-applied", () => {
  const stopId = "sess-a--leaf1";
  assert.deepEqual(toTriageOutcome({ stopId, outcome: "packet" }), {
    error: "a packet outcome needs the packet",
  });
  assert.equal(
    "error" in toTriageOutcome({ stopId, outcome: "continue", domain: "d", instruction: "i" }),
    true,
  );
  assert.equal("error" in toTriageOutcome({ stopId, outcome: "close", domain: "d" }), true);
  assert.equal(
    "error" in toTriageOutcome({ stopId, outcome: "respawn", domain: "d", reason: "r" }),
    true,
  );

  const complete = toTriageOutcome({
    stopId,
    outcome: "continue",
    domain: "ci-flake",
    citation: "global.md § Doors L4",
    instruction: "retry once",
  });
  assert.equal("outcome" in complete, true);
  if (!("outcome" in complete)) return;
  assert.equal(complete.outcome.kind, "continue");
  if (complete.outcome.kind !== "continue") return;
  assert.equal(complete.outcome.summary, "retry once", "summary falls back to the instruction");
  // Undeclared consequences fail closed, so an unstated continue reaches the user.
  assert.equal(complete.outcome.blastRadius, "high");
  assert.equal(complete.outcome.reversibility, "one-way");
});

test("a close and a respawn construct their outcomes with what they were given", () => {
  const stopId = "sess-a--leaf1";
  const closed = toTriageOutcome({
    stopId,
    outcome: "close",
    domain: "routine-fix",
    summary: "fixed the parser test",
    unverified: "the slow suite was not run",
  });
  assert.equal("outcome" in closed, true);
  if (!("outcome" in closed) || closed.outcome.kind !== "close") return;
  assert.equal(closed.outcome.summary, "fixed the parser test");
  assert.equal(closed.outcome.unverified, "the slow suite was not run");

  const respawned = toTriageOutcome({
    stopId,
    outcome: "respawn",
    domain: "stalled",
    reason: "the build died",
    instruction: "run it again",
  });
  assert.equal("outcome" in respawned, true);
  if (!("outcome" in respawned) || respawned.outcome.kind !== "respawn") return;
  assert.equal(respawned.outcome.reason, "the build died");
  assert.equal(respawned.outcome.instruction, "run it again");
});

test("worker tools answer to the environment they were spawned with", async () => {
  const h = await harness("hq-tools-audience", {
    env: { HQ_MANAGED: "1", HQ_KIND: "drill", HQ_DRILL_QUESTION: "what failed?", HQ_PACKET_ID: "" },
  });
  try {
    const packet = await queue(h);
    h.deps.env.HQ_PACKET_ID = packet.id;
    const context = h.tools.get("hq_drill_context");
    assert.ok(context);
    const result = await context.execute(
      "call",
      { packetId: packet.id } as never,
      undefined,
      undefined,
      h.ctx,
    );
    const body = result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
    assert.match(body, /Question: what failed\?/);
    assert.match(body, /Tier: 1 \(reading\)/);
  } finally {
    await dropRoot(h.root);
  }
});

test("a batch is put as one ask, and accepting all rules every packet in it", async () => {
  const h = await harness("hq-tools-batch");
  try {
    const first = await queue(h);
    const second = await queue(h);
    const third = await queue(h);

    h.answers.push("Accept all 3 recommendations");
    const report = await ask(h, [first.id, second.id, third.id]);

    assert.equal(h.selects.length, 1, "three packets cost the user one dialog");
    assert.match(h.selects[0] ?? "", /3 decisions in/);
    assert.equal(report.split("\n").length, 3);
    for (const packet of [first, second, third]) {
      assert.equal((await h.store.readPacket(packet.id))?.status, "ruled");
    }
    assert.equal((await h.store.listRulings()).length, 3);
  } finally {
    await dropRoot(h.root);
  }
});

test("declining the batch falls through to deciding them one at a time", async () => {
  const h = await harness("hq-tools-batch-decline");
  try {
    const first = await queue(h);
    const second = await queue(h);
    h.answers.push("Decide them one at a time");
    h.answers.push(buildAskRows(first)[0]?.label);
    h.answers.push(buildAskRows(second)[1]?.label);

    await ask(h, [first.id, second.id]);
    assert.equal(h.selects.length, 3, "the batch ask plus one per packet");
    const rulings = await h.store.listRulings();
    assert.deepEqual(rulings.map((ruling) => ruling.form).sort(), ["accept", "alternative"]);
  } finally {
    await dropRoot(h.root);
  }
});

test("a worker that is still booting still counts against the cap", async () => {
  const h = await harness("hq-tools-cap-burst", { maxWorkers: 1 });
  try {
    const { sessionStateFixture } = await import("./testing.ts");
    // A freshly spawned worker publishes "idle" before it starts working.
    await h.store.publishSessionState(
      sessionStateFixture({ sessionId: "booting", pid: process.pid, state: "idle" }),
    );
    const tool = h.tools.get("hq_delegate");
    assert.ok(tool);
    const result = await tool.execute(
      "call",
      { task: "one more thing" } as never,
      undefined,
      undefined,
      h.ctx,
    );
    assert.match(
      result.content.map((part) => ("text" in part ? part.text : "")).join(" "),
      /already running/,
      "a burst of delegations cannot walk past the cap",
    );
  } finally {
    await dropRoot(h.root);
  }
});

test("the defect tool records a reported dive", async () => {
  const h = await harness("hq-tools-defect-tool");
  try {
    const packet = await queue(h);
    const tool = h.tools.get("hq_defect");
    assert.ok(tool);
    await tool.execute(
      "call",
      { packetId: packet.id, missing: "which test failed", ruling: "investigated it" } as never,
      undefined,
      undefined,
      h.ctx,
    );
    const defects = await h.store.readDefects();
    assert.equal(defects.length, 1);
    assert.equal(defects[0]?.missing, "which test failed");
    assert.equal(defects[0]?.ruling, "investigated it");
  } finally {
    await dropRoot(h.root);
  }
});

test("the titler writes only the title, leaving the session's own fields alone", async () => {
  const h = await harness("hq-tools-title", { env: { HQ_MANAGED: "1", HQ_KIND: "titler" } });
  try {
    const { sessionStateFixture } = await import("./testing.ts");
    await h.store.publishSessionState(
      sessionStateFixture({ sessionId: "sess-a", state: "running", drillingPacketIds: ["pkt-x"] }),
    );
    const tool = h.tools.get("hq_set_title");
    assert.ok(tool);
    await tool.execute(
      "call",
      { sessionId: "sess-a", title: "migrate the eval runner" } as never,
      undefined,
      undefined,
      h.ctx,
    );

    const state = await h.store.readSessionState("sess-a");
    assert.equal(state?.title, "migrate the eval runner");
    assert.equal(state?.state, "running", "the lifecycle field is untouched");
    assert.deepEqual(state?.drillingPacketIds, ["pkt-x"], "and so is the drill marker");

    const missing = await tool.execute(
      "call",
      { sessionId: "nobody", title: "x" } as never,
      undefined,
      undefined,
      h.ctx,
    );
    assert.match(
      missing.content.map((part) => ("text" in part ? part.text : "")).join(" "),
      /no such session/,
    );
  } finally {
    await dropRoot(h.root);
  }
});
