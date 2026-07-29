import assert from "node:assert/strict";
import test from "node:test";
import { scanJsonDir } from "./io.ts";
import { hqPaths } from "./paths.ts";
import { SessionReporter } from "./reporter.ts";
import { KIND_ENV, MANAGED_ENV, TITLER_ENV } from "./spawn.ts";
import { parseStopRecord } from "./stops.ts";
import { dropRoot, fixedClock, makeRoot, makeStore, recordingSpawner } from "./testing.ts";
import type { SessionContextLike } from "./host.ts";

function fakeCtx(overrides: {
  sessionId?: string;
  leafId?: string | null;
  cwd?: string;
  mode?: string;
  branch?: readonly unknown[];
} = {}): SessionContextLike {
  return {
    mode: overrides.mode ?? "tui",
    cwd: overrides.cwd ?? "/work/alpha",
    sessionManager: {
      getSessionId: () => overrides.sessionId ?? "sess-a",
      getSessionFile: () => "/tmp/sess-a.jsonl",
      getLeafId: () => (overrides.leafId === undefined ? "leaf1" : overrides.leafId),
      getBranch: () => overrides.branch ?? [],
    },
  };
}

async function stopRecords(root: string) {
  const scan = await scanJsonDir(
    hqPaths(root).stops,
    parseStopRecord,
    (record) => record.stopId,
  );
  return scan.records.map((entry) => entry.record);
}

test("a session HQ did not start is left alone entirely", async () => {
  const root = await makeRoot("hq-attended");
  try {
    const store = makeStore(root);
    const { spawner, calls } = recordingSpawner();
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx: fakeCtx({
        branch: [{ message: { role: "user", content: [{ type: "text", text: "help me think" }] } }],
      }),
      env: {},
      now: fixedClock(),
    });

    assert.equal(reporter.role, "attended");
    await reporter.start();
    await reporter.onAgentStart();
    reporter.onAgentEnd([{ role: "assistant", content: "Which of these should I do?" }]);
    await reporter.onAgentSettled();

    assert.equal(await store.readSessionState("sess-a"), undefined, "not on the board");
    assert.deepEqual(await stopRecords(root), [], "no stop record");
    assert.deepEqual(calls, [], "nothing spawned, not even a titler");
  } finally {
    await dropRoot(root);
  }
});


test("sending a session off hands it to HQ, which takes it over by forking", async () => {
  const root = await makeRoot("hq-sendoff");
  try {
    const store = makeStore(root);
    const { spawner, calls } = recordingSpawner();
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx: fakeCtx(),
      env: { [TITLER_ENV]: "1" },
      now: fixedClock(),
    });
    await reporter.start();
    reporter.onAgentEnd([{ role: "assistant", content: "Done with the first pass." }]);
    await reporter.onAgentSettled();
    assert.deepEqual(await stopRecords(root), [], "nothing happens while it is the user's own");

    const handed = await reporter.handOff("carry on with the second pass");
    assert.deepEqual(handed, { ok: true });

    const stops = await stopRecords(root);
    assert.equal(stops.length, 1, "the handover itself records the stop");
    assert.equal(stops[0]?.handedOff, true);
    assert.equal(stops[0]?.mandate, "carry on with the second pass");
    assert.equal((await store.readSessionState("sess-a"))?.role, "managed");
    assert.equal(calls.length, 1, "and triage is kicked off for it");
    assert.equal(calls[0]?.kind, "triage");

    // Handing over twice is the user telling HQ something it already knows.
    assert.deepEqual(await reporter.handOff(""), {
      ok: false,
      reason: "HQ already owns this session",
    });
  } finally {
    await dropRoot(root);
  }
});

test("a managed worker's stop is recorded and triaged exactly once per stop", async () => {
  const root = await makeRoot("hq-managed");
  try {
    const store = makeStore(root);
    const { spawner, calls } = recordingSpawner();
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx: fakeCtx(),
      env: { [MANAGED_ENV]: "1", [KIND_ENV]: "worker", [TITLER_ENV]: "1" },
      now: fixedClock(),
    });

    assert.equal(reporter.role, "managed");
    await reporter.start();
    await reporter.onAgentStart();
    reporter.onAgentEnd([{ role: "assistant", content: "Blocked: retry or investigate?" }]);
    await reporter.onAgentSettled();
    // The same settle observed again — a duplicate signal, not a new stop.
    await reporter.onAgentSettled();

    const stops = await stopRecords(root);
    assert.equal(stops.length, 1);
    assert.equal(stops[0]?.status, "claimed");
    const triage = calls.filter((call) => call.kind === "triage");
    assert.equal(triage.length, 1, "one triage per stop");
    assert.equal(triage[0]?.env?.HQ_STOP_ID, stops[0]?.stopId);
    assert.equal((await store.readSessionState("sess-a"))?.state, "done");
  } finally {
    await dropRoot(root);
  }
});

test("a later stop on a different branch leaf is its own stop", async () => {
  const root = await makeRoot("hq-two-stops");
  try {
    const store = makeStore(root);
    const { spawner, calls } = recordingSpawner();
    let leaf = "leaf1";
    const ctx: SessionContextLike = {
      mode: "print",
      cwd: "/work/alpha",
      sessionManager: {
        getSessionId: () => "sess-a",
        getSessionFile: () => "/tmp/sess-a.jsonl",
        getLeafId: () => leaf,
        getBranch: () => [],
      },
    };
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx,
      env: { [MANAGED_ENV]: "1", [KIND_ENV]: "worker", [TITLER_ENV]: "1" },
      now: fixedClock(),
    });

    await reporter.start();
    await reporter.onAgentSettled();
    leaf = "leaf2";
    await reporter.onAgentSettled();

    assert.equal((await stopRecords(root)).length, 2);
    assert.equal(calls.filter((call) => call.kind === "triage").length, 2);
  } finally {
    await dropRoot(root);
  }
});

test("internal workers are neither published nor triaged", async () => {
  const root = await makeRoot("hq-internal");
  try {
    const store = makeStore(root);
    const { spawner, calls } = recordingSpawner();
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx: fakeCtx({ sessionId: "sess-triage" }),
      env: { [MANAGED_ENV]: "1", [KIND_ENV]: "triage" },
      now: fixedClock(),
    });

    await reporter.start();
    await reporter.onAgentStart();
    await reporter.onAgentSettled();

    assert.deepEqual(await stopRecords(root), [], "triage stops do not cascade into more triage");
    assert.deepEqual(calls, []);
  } finally {
    await dropRoot(root);
  }
});

test("a session asks for a title once, from its first user message", async () => {
  const root = await makeRoot("hq-title");
  try {
    const store = makeStore(root);
    const { spawner, calls } = recordingSpawner();
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx: fakeCtx({
        branch: [{ message: { role: "user", content: [{ type: "text", text: "migrate the eval runner" }] } }],
      }),
      env: { [MANAGED_ENV]: "1", [KIND_ENV]: "worker" },
      now: fixedClock(),
      titleModel: "fast-model",
    });

    await reporter.start();
    await reporter.onAgentStart();
    await reporter.onAgentStart();

    const titlers = calls.filter((call) => call.kind === "titler");
    assert.equal(titlers.length, 1);
    assert.equal(titlers[0]?.model, "fast-model");
    assert.deepEqual(titlers[0]?.tools, ["hq_set_title"]);
    assert.match(titlers[0]?.prompt ?? "", /migrate the eval runner/);
  } finally {
    await dropRoot(root);
  }
});

test("a drill in flight stays visible on the session it is about", async () => {
  const root = await makeRoot("hq-drill-row");
  try {
    const store = makeStore(root);
    const { spawner } = recordingSpawner();
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx: fakeCtx(),
      env: { [MANAGED_ENV]: "1", [KIND_ENV]: "worker", [TITLER_ENV]: "1" },
      now: fixedClock(),
    });
    await reporter.start();

    const state = await store.readSessionState("sess-a");
    assert.ok(state);
    await store.publishSessionState({ ...state, drillingPacketIds: ["pkt-1"] });

    await reporter.onAgentStart();
    assert.deepEqual(
      (await store.readSessionState("sess-a"))?.drillingPacketIds,
      ["pkt-1"],
      "a publish does not wipe the drill markers",
    );
  } finally {
    await dropRoot(root);
  }
});

test("a title set by the titler survives the session's next publish", async () => {
  const root = await makeRoot("hq-title-keep");
  try {
    const store = makeStore(root);
    const { spawner } = recordingSpawner();
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx: fakeCtx(),
      env: { [MANAGED_ENV]: "1", [KIND_ENV]: "worker", [TITLER_ENV]: "1" },
      now: fixedClock(),
    });
    await reporter.start();

    // The titler is a separate process; it owns only the title field.
    await store.patchSessionState("sess-a", { title: "migrate the eval runner" });

    await reporter.onAgentStart();
    await reporter.onAgentSettled();
    await reporter.onShutdown();

    assert.equal(
      (await store.readSessionState("sess-a"))?.title,
      "migrate the eval runner",
      "the reporter must not write its own null over the titler's value",
    );
  } finally {
    await dropRoot(root);
  }
});

test("a triage or drill worker never appears on the board", async () => {
  const root = await makeRoot("hq-internal-rows");
  try {
    const store = makeStore(root);
    const { spawner } = recordingSpawner();
    for (const kind of ["triage", "drill"] as const) {
      const reporter = new SessionReporter({
        store,
        spawner,
        ctx: fakeCtx({ sessionId: `sess-${kind}` }),
        env: { [MANAGED_ENV]: "1", [KIND_ENV]: kind },
        now: fixedClock(),
      });
      await reporter.start();
      await reporter.onAgentStart();
      await reporter.onAgentSettled();
    }
    assert.deepEqual(await store.listFleet(), [], "plumbing is not work on the glance");
  } finally {
    await dropRoot(root);
  }
});

test("a run that died on an error is recorded as a death, not as finished work", async () => {
  const root = await makeRoot("hq-error-stop");
  try {
    const store = makeStore(root);
    const { spawner } = recordingSpawner();
    const reporter = new SessionReporter({
      store,
      spawner,
      ctx: fakeCtx(),
      env: { [MANAGED_ENV]: "1", [KIND_ENV]: "worker", [TITLER_ENV]: "1" },
      now: fixedClock(),
    });
    await reporter.start();
    // A provider error is a terminal outcome, and its text will not end in "?".
    reporter.onAgentEnd([
      { role: "assistant", content: "The request failed after retries.", stopReason: "error" },
    ]);
    assert.equal(reporter.classifyStop(), "aborted");
    await reporter.onAgentSettled();

    const state = await store.readSessionState("sess-a");
    assert.equal(state?.stopState, "aborted", "the board shows it failed, not done");
  } finally {
    await dropRoot(root);
  }
});
