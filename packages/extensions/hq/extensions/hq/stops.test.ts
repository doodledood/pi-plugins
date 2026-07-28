import assert from "node:assert/strict";
import test from "node:test";
import { hqPaths } from "./paths.ts";
import { pathExists } from "./io.ts";
import { dropRoot, makeRoot } from "./testing.ts";
import { isPidAlive } from "./io.ts";
import {
  claimStop,
  findStopsNeedingTriage,
  finishStop,
  readStopRecord,
  reopenStop,
  stopIdFor,
  takeOverClaim,
  writeStopRecord,
  type StopRecord,
} from "./stops.ts";

function stopFixture(overrides: Partial<StopRecord> = {}): StopRecord {
  return {
    version: 1,
    stopId: "sess-a--leaf1",
    sessionId: "sess-a",
    sessionFile: "/tmp/sess-a.jsonl",
    project: "/work/alpha",
    kind: "worker",
    stopState: "stopped-with-question",
    preview: "Should I retry?",
    createdAt: "2026-07-28T12:00:00.000Z",
    status: "open",
    claimedByPid: null,
    claimedAt: null,
    outcome: null,
    packetId: null,
    ...overrides,
  };
}

test("a stop's identity is its session and the branch it settled on", () => {
  assert.equal(stopIdFor("sess-a", "leaf1", 1), "sess-a--leaf1");
  assert.equal(stopIdFor("sess-a", "leaf1", 2), "sess-a--leaf1");
  assert.notEqual(stopIdFor("sess-a", "leaf2", 2), stopIdFor("sess-a", "leaf1", 1));
  assert.equal(stopIdFor("sess-a", null, 3), "sess-a--n3");
});

test("only one claimant can win a stop, so a duplicate signal starts no second triage", async () => {
  const root = await makeRoot("hq-stops");
  try {
    const stop = stopFixture();
    await writeStopRecord(root, stop);

    const first = await claimStop(root, stop.stopId, 111, "2026-07-28T12:00:01.000Z");
    const second = await claimStop(root, stop.stopId, 222, "2026-07-28T12:00:02.000Z");
    assert.equal(first, true);
    assert.equal(second, false);

    const stored = await readStopRecord(root, stop.stopId);
    assert.equal(stored?.status, "claimed");
    assert.equal(stored?.claimedByPid, 111);
  } finally {
    await dropRoot(root);
  }
});

test("a stop whose triage never finished is found again; a finished one is not", async () => {
  const root = await makeRoot("hq-stops-sweep");
  try {
    const unclaimed = stopFixture({ stopId: "sess-a--unclaimed" });
    const dead = stopFixture({ stopId: "sess-b--dead", sessionId: "sess-b" });
    const finished = stopFixture({ stopId: "sess-c--done", sessionId: "sess-c" });
    await Promise.all([unclaimed, dead, finished].map((stop) => writeStopRecord(root, stop)));

    await claimStop(root, dead.stopId, 999_999, "2026-07-28T12:00:01.000Z");
    await claimStop(root, finished.stopId, 111, "2026-07-28T12:00:01.000Z");
    await finishStop(root, finished.stopId, "packet", "pkt-1");

    const stale = await findStopsNeedingTriage(
      root,
      undefined,
      (pid) => pid === 111,
    );
    const byId = new Map(stale.map((entry) => [entry.record.stopId, entry.reason]));
    assert.equal(byId.get("sess-a--unclaimed"), "unclaimed");
    assert.equal(byId.get("sess-b--dead"), "claimant-dead");
    assert.equal(byId.has("sess-c--done"), false);

    // Reopening clears the dead claim so the retry can win it.
    await reopenStop(root, dead.stopId);
    assert.equal(await pathExists(`${hqPaths(root).stops}/${dead.stopId}.claim`), false);
    assert.equal(await claimStop(root, dead.stopId, 222, "2026-07-28T12:05:00.000Z"), true);
  } finally {
    await dropRoot(root);
  }
});

test("a claim being handed over is not mistaken for an abandoned one", async () => {
  const root = await makeRoot("hq-claim-handover");
  try {
    const stop = stopFixture({ stopId: "sess-a--handover" });
    await writeStopRecord(root, stop);
    // The session that observed the stop claims it, then exits — which is the
    // normal path, since the triage worker it spawned is a different process.
    await claimStop(root, stop.stopId, 999_999_999, "2026-07-28T12:00:01.000Z");
    const dead = () => false;

    const duringHandover = await findStopsNeedingTriage(
      root,
      undefined,
      dead,
      new Date("2026-07-28T12:01:00.000Z"),
    );
    assert.deepEqual(duringHandover, [], "a dead claimant inside the window is handing over");

    // The triage worker takes the claim, and its own liveness now decides.
    await takeOverClaim(root, stop.stopId, process.pid, "2026-07-28T12:01:05.000Z");
    const claimed = await readStopRecord(root, stop.stopId);
    assert.equal(claimed?.claimedByPid, process.pid);
    assert.deepEqual(
      await findStopsNeedingTriage(root, undefined, isPidAlive, new Date("2026-07-28T13:00:00.000Z")),
      [],
      "a live triage is never re-run",
    );

    // Only a dead claimant past the window is abandoned work.
    const abandoned = await findStopsNeedingTriage(
      root,
      undefined,
      dead,
      new Date("2026-07-28T12:30:00.000Z"),
    );
    assert.deepEqual(abandoned.map((entry) => entry.reason), ["claimant-dead"]);
  } finally {
    await dropRoot(root);
  }
});

test("a finished stop records its outcome and the packet it produced", async () => {
  const root = await makeRoot("hq-stops-finish");
  try {
    const stop = stopFixture();
    await writeStopRecord(root, stop);
    await finishStop(root, stop.stopId, "packet", "pkt-9");
    const stored = await readStopRecord(root, stop.stopId);
    assert.equal(stored?.status, "done");
    assert.equal(stored?.outcome, "packet");
    assert.equal(stored?.packetId, "pkt-9");
  } finally {
    await dropRoot(root);
  }
});
