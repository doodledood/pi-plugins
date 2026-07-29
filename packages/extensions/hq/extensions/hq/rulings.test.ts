import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { loadDoctrine, seedDoctrine, seedProjectDoctrine } from "./doctrine.ts";
import { readyDomains } from "./graduation.ts";
import { atomicWriteText } from "./io.ts";
import { hqPaths, projectDoctrinePath } from "./paths.ts";
import {
  applyRuling,
  chosenOptionId,
  createDoctrineProposal,
  gradeShadow,
  recordDive,
} from "./rulings.ts";
import { HqStore } from "./store.ts";
import {
  dropRoot,
  fixedClock,
  makeRoot,
  makeStore,
  packetDraftFixture,
  recordingSpawner,
} from "./testing.ts";
import type { SpawnRequest, Spawner } from "./spawn.ts";
import type { Packet } from "./types.ts";

interface Harness {
  root: string;
  store: HqStore;
  spawner: Spawner;
  calls: SpawnRequest[];
  now: () => Date;
}

async function harness(label: string): Promise<Harness> {
  const root = await makeRoot(label);
  const now = fixedClock();
  const store = makeStore(root, now);
  await store.ensure();
  await seedDoctrine(root);
  await seedProjectDoctrine(root, "/work/alpha");
  const { spawner, calls } = recordingSpawner();
  return { root, store, spawner, calls, now };
}

async function queuePacket(h: Harness, overrides: Partial<Packet> = {}): Promise<Packet> {
  const { packet } = await h.store.createPacket({
    ...packetDraftFixture(),
    ...overrides,
  } as never);
  return packet;
}

test("choosing and grading read the packet, not the phrasing", () => {
  const packet: Packet = {
    ...packetDraftFixture(),
    version: 1,
    id: "pkt-1",
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    generation: 1,
    status: "pending",
  };
  assert.equal(chosenOptionId(packet, { packetId: "pkt-1", form: "accept" }), "retry");
  assert.equal(
    chosenOptionId(packet, { packetId: "pkt-1", form: "alternative", optionId: "investigate" }),
    "investigate",
  );
  assert.equal(chosenOptionId(packet, { packetId: "pkt-1", form: "custom", text: "do neither" }), null);

  assert.equal(gradeShadow(packet, { packetId: "pkt-1", form: "accept" }), true);
  assert.equal(
    gradeShadow(packet, { packetId: "pkt-1", form: "alternative", optionId: "investigate" }),
    false,
  );
  assert.equal(gradeShadow(packet, { packetId: "pkt-1", form: "custom", text: "neither" }), false);
  assert.equal(gradeShadow(packet, { packetId: "pkt-1", form: "defer", question: "why?" }), null);
  assert.equal(
    gradeShadow({ ...packet, shadowRuling: null }, { packetId: "pkt-1", form: "accept" }),
    null,
  );
});

test("accepting the recommendation records the ruling and resumes the waiting session", async () => {
  const h = await harness("hq-rule-accept");
  try {
    const packet = await queuePacket(h);
    const result = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: packet.id, form: "accept" },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;

    assert.equal(result.ruling.form, "accept");
    assert.equal(result.ruling.optionId, "retry");
    assert.equal(result.ruling.shadowAgreed, true);
    assert.equal(result.ruling.routing.action, "resume");

    const rulings = await h.store.listRulings();
    assert.equal(rulings.length, 1);
    assert.equal(rulings[0]?.packetGeneration, packet.generation);

    // The packet leaves the queue but stays readable for audit. (The doctrine
    // proposal this ruling produced is a new packet, so the queue is not empty.)
    const presentable = (await h.store.listPresentable()).map((p) => p.id);
    assert.equal(presentable.includes(packet.id), false);
    assert.equal((await h.store.readPacket(packet.id))?.status, "ruled");

    const continuation = h.calls.filter((call) => call.kind === "continuation");
    assert.equal(continuation.length, 1);
    assert.equal(continuation[0]?.resumeSessionFile, packet.sourceSessionFile);
    assert.match(continuation[0]?.prompt ?? "", /Retry the suite/);
    assert.equal(continuation[0]?.packetId, packet.id);
  } finally {
    await dropRoot(h.root);
  }
});

test("an uncovered ruling proposes a rule; a covered, agreed one proposes nothing", async () => {
  const h = await harness("hq-rule-coverage");
  try {
    const uncovered = await queuePacket(h);
    const first = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: uncovered.id, form: "accept" },
    );
    assert.equal("error" in first, false);
    if ("error" in first) return;
    assert.equal(first.ruling.coverage, "uncovered");
    // The rule is drafted by a worker rather than built from a template, because a
    // template can only restate the case it came from.
    const drafting = h.calls.filter((call) => call.kind === "rule");
    assert.equal(drafting.length, 1);
    assert.match(drafting[0]?.prompt ?? "", /general principle/);
    assert.deepEqual(drafting[0]?.tools, ["hq_propose_rule", "hq_skip_rule"]);
    assert.deepEqual(first.proposals, [], "nothing is queued until the draft comes back");

    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const covered = await queuePacket(h, {
      // A deciding line, because only those count as coverage.
      doctrineCitations: [doctrine.rules.find((rule) => rule.decides)?.citation ?? ""],
    });
    const second = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: covered.id, form: "accept" },
    );
    assert.equal("error" in second, false);
    if ("error" in second) return;
    assert.equal(second.ruling.coverage, "covered-agreed");
    assert.deepEqual(second.proposals, []);
    assert.equal(
      h.calls.filter((call) => call.kind === "rule").length,
      1,
      "a covered, agreed ruling needs no rule drafted",
    );
  } finally {
    await dropRoot(h.root);
  }
});

test("a covered, agreed ruling is recorded as evidence and advances the streak", async () => {
  const h = await harness("hq-rule-evidence");
  try {
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const citation = doctrine.rules.find((rule) => rule.decides)?.citation ?? "";
    const packet = await queuePacket(h, { doctrineCitations: [citation] });
    const result = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: packet.id, form: "accept" },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;

    assert.equal(result.ruling.coverage, "covered-agreed");
    assert.equal(result.ruling.shadowAgreed, true);

    // The agreement is durable, not just returned: it is the graduation ladder's input.
    const recorded = (await h.store.listRulings()).find((entry) => entry.packetId === packet.id);
    assert.ok(recorded, "the ruling is in the log");
    assert.equal(recorded?.shadowAgreed, true);
    const stats = (await h.store.readGraduation()).domains[packet.domain];
    assert.equal(stats?.agreements, 1);
    assert.equal(stats?.consecutiveAgreements, 1);
    assert.equal(stats?.graduated, false);
  } finally {
    await dropRoot(h.root);
  }
});

test("an amendment proposal generated by a ruling can actually be ratified", async () => {
  const h = await harness("hq-rule-amend-roundtrip");
  try {
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const cited = doctrine.rules.find((rule) => rule.section === "Doors");
    assert.ok(cited);
    const path = cited.scope === "global"
      ? hqPaths(h.root).doctrineGlobal
      : projectDoctrinePath(h.root, "/work/alpha");

    const packet = await queuePacket(h, { doctrineCitations: [cited.citation] });
    const overruled = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: packet.id, form: "alternative", optionId: "investigate" },
    );
    assert.equal("error" in overruled, false);
    if ("error" in overruled) return;
    // Standing in for the rule-drafting worker, which is what supplies the text.
    const amendment = await createDoctrineProposal(
      { store: h.store },
      packet,
      overruled.ruling,
      "Prefer investigating a repeated failure over retrying it when the same assertion fails twice.",
    );
    assert.ok(amendment, "the contradiction proposed an amendment");

    // The proposal must carry the rule's text, not its citation, or ratifying it
    // can never find what it is replacing.
    assert.equal(amendment.proposal?.replaces, cited.text);
    assert.equal(amendment.proposal?.scope, cited.scope);

    const ratified = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: amendment.id, form: "accept" },
    );
    assert.equal("error" in ratified, false);
    if ("error" in ratified) return;
    assert.equal(ratified.doctrineApplied, true, "ratification actually wrote the amendment");
    const text = await readFile(path, "utf8");
    assert.equal(text.includes(cited.text), false, "the amended rule is gone");
    assert.match(text, /Prefer investigating a repeated failure/, "the drafted rule replaced it");
  } finally {
    await dropRoot(h.root);
  }
});

test("the ruling is in the log before the work is allowed to continue", async () => {
  const h = await harness("hq-rule-order");
  try {
    const packet = await queuePacket(h);
    const seenAtSpawn: string[] = [];
    const result = await applyRuling(
      {
        store: h.store,
        now: h.now,
        spawner: async (request) => {
          // What the log holds at the moment the continuation is created. The rule
          // drafter is spawned too; this is about the work resuming.
          if (request.kind !== "continuation") {
            return { runId: "run-rule", pid: 2, logPath: "/dev/null", argv: [] };
          }
          const rulings = await h.store.listRulings();
          seenAtSpawn.push(...rulings.map((ruling) => `${ruling.id}:${ruling.routing.action}`));
          return { runId: "run-x", pid: 1, logPath: "/dev/null", argv: [], ...(request ? {} : {}) };
        },
      },
      { packetId: packet.id, form: "accept" },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;

    assert.equal(seenAtSpawn.length, 1, "the ruling was already durable when the work resumed");
    assert.equal(seenAtSpawn[0]?.startsWith(result.ruling.id), true);

    // The final record is the one that knows where the ruling was carried.
    const latest = (await h.store.listRulings()).filter((r) => r.id === result.ruling.id);
    assert.equal(latest.length, 1, "readers resolve the two appends to one ruling");
    assert.equal(latest[0]?.routing.spawnedRunId, "run-x");
  } finally {
    await dropRoot(h.root);
  }
});

test("a shadow ruling with no ruling or no reasoning is as good as none", async () => {
  const h = await harness("hq-rule-hollow-shadow");
  try {
    const { violations, packet } = await h.store.createPacket({
      ...packetDraftFixture(),
      shadowRuling: { optionId: "retry", text: "", rationale: "", doctrineCitations: [] },
    } as never);
    // Presence alone grades as nothing, so the bar reads substance.
    assert.equal(packet.status, "held");
    assert.deepEqual(violations.map((violation) => violation.field), ["shadowRuling"]);
  } finally {
    await dropRoot(h.root);
  }
});

test("a decision packet with no shadow ruling is held rather than shown", async () => {
  const h = await harness("hq-rule-shadowless");
  try {
    const { violations, packet } = await h.store.createPacket({
      ...packetDraftFixture(),
      shadowRuling: null,
    } as never);
    assert.equal(packet.status, "held");
    assert.deepEqual(violations.map((violation) => violation.field), ["shadowRuling"]);
    assert.deepEqual(await h.store.listPresentable(), []);
  } finally {
    await dropRoot(h.root);
  }
});

test("overruling a cited rule proposes an amendment and leaves the rule alone until ratified", async () => {
  const h = await harness("hq-rule-contradicts");
  try {
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const citation = doctrine.rules.find((rule) => rule.decides)?.citation ?? "";
    const before = await readFile(hqPaths(h.root).doctrineGlobal, "utf8");

    const packet = await queuePacket(h, { doctrineCitations: [citation] });
    const result = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: packet.id, form: "alternative", optionId: "investigate" },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;

    assert.equal(result.ruling.shadowAgreed, false);
    assert.equal(result.ruling.coverage, "contradicts");
    const proposed = await createDoctrineProposal({ store: h.store }, packet, result.ruling, "Prefer investigating a repeated failure over retrying it when the same assertion fails twice.");
    assert.equal(proposed?.proposal?.kind, "amendment");
    assert.equal(
      await readFile(hqPaths(h.root).doctrineGlobal, "utf8"),
      before,
      "doctrine is untouched until the amendment is ratified",
    );
  } finally {
    await dropRoot(h.root);
  }
});

test("ratifying a proposal writes the rule; rejecting leaves doctrine byte-identical", async () => {
  const h = await harness("hq-rule-ratify");
  try {
    const packet = await queuePacket(h);
    const first = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: packet.id, form: "accept" },
    );
    assert.equal("error" in first, false);
    if ("error" in first) return;
    const proposal = await createDoctrineProposal({ store: h.store }, packet, first.ruling, "Prefer investigating a repeated failure over retrying it when the same assertion fails twice.");
    assert.ok(proposal);

    const projectPath = projectDoctrinePath(h.root, "/work/alpha");
    const beforeReject = await readFile(projectPath, "utf8");
    const rejected = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: proposal.id, form: "alternative", optionId: "reject" },
    );
    assert.equal("error" in rejected, false);
    if ("error" in rejected) return;
    assert.equal(rejected.doctrineApplied, false);
    assert.equal(await readFile(projectPath, "utf8"), beforeReject);

    // A second proposal, ratified this time.
    const another = await queuePacket(h);
    const second = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: another.id, form: "accept" },
    );
    assert.equal("error" in second, false);
    if ("error" in second) return;
    const ratifiable = await createDoctrineProposal(
      { store: h.store },
      another,
      second.ruling,
      "Treat a suite that fails the same way twice as broken rather than flaky.",
    );
    assert.ok(ratifiable);
    const ratified = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: ratifiable.id, form: "accept" },
    );
    assert.equal("error" in ratified, false);
    if ("error" in ratified) return;
    assert.equal(ratified.doctrineApplied, true);
    assert.match(await readFile(projectPath, "utf8"), /fails the same way twice/);

    // Ratifying doctrine never routes work anywhere.
    assert.equal(ratified.ruling.routing.action, "none");
  } finally {
    await dropRoot(h.root);
  }
});

test("a packet that changed since it was shown is not answered blindly", async () => {
  const h = await harness("hq-rule-stale-generation");
  try {
    const packet = await queuePacket(h);
    // A drill annotates it between presentation and the click.
    await h.store.updatePacket(packet.id, (current) => ({
      ...current,
      annotations: [
        ...current.annotations,
        { at: "2026-07-28T12:05:00.000Z", question: "q", answer: "a", quotes: [], tier: 1 as const },
      ],
    }));

    const stale = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: packet.id, form: "accept", presentedGeneration: packet.generation },
    );
    assert.equal("error" in stale, true, "the ruling is refused rather than applied to a changed packet");
    if ("error" in stale) assert.match(stale.error, /changed since it was shown/);
    assert.deepEqual(await h.store.listRulings(), []);

    // Presented again at its current generation, it rules normally and records it.
    const fresh = await h.store.readPacket(packet.id);
    const ok = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: packet.id, form: "accept", presentedGeneration: fresh?.generation },
    );
    assert.equal("error" in ok, false);
    if ("error" in ok) return;
    assert.equal(ok.ruling.packetGeneration, fresh?.generation);
  } finally {
    await dropRoot(h.root);
  }
});

test("declining to decide yet is not graded as overruling doctrine", async () => {
  const h = await harness("hq-rule-hold");
  try {
    const doctrine = await loadDoctrine(h.root, "/work/alpha");
    const citation = doctrine.rules.find((rule) => rule.decides)?.citation ?? "";
    const packet = await queuePacket(h, {
      doctrineCitations: [citation],
      options: [
        { id: "as-proposed", label: "Do what doctrine implies", price: "what the rule says" },
        { id: "hold", label: "Hold and tell me more first", price: "the work waits", defers: true },
      ],
      recommendationId: "as-proposed",
      shadowRuling: {
        optionId: "as-proposed",
        text: "proceed",
        rationale: "doctrine covers it",
        doctrineCitations: [citation],
      },
    });

    const result = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      { packetId: packet.id, form: "alternative", optionId: "hold" },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.ruling.shadowAgreed, null, "asking to look first grades nothing");
    assert.notEqual(result.ruling.coverage, "contradicts");
    assert.equal(
      result.proposals.some((proposal) => proposal.proposal?.kind === "amendment"),
      false,
      "and it cannot manufacture an amendment against a rule the user never disputed",
    );
  } finally {
    await dropRoot(h.root);
  }
});

test("a deferral drills and leaves the packet in the queue", async () => {
  const h = await harness("hq-rule-defer");
  try {
    const packet = await queuePacket(h);
    const drilled: string[] = [];
    const result = await applyRuling(
      {
        store: h.store,
        spawner: h.spawner,
        now: h.now,
        startDrill: async (target, question) => {
          drilled.push(`${target.id}:${question}`);
          return { spawnedRunId: "drill-1" };
        },
      },
      { packetId: packet.id, form: "defer", question: "what did the log actually say?" },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;

    assert.deepEqual(drilled, [`${packet.id}:what did the log actually say?`]);
    assert.equal(result.ruling.routing.action, "drill");
    assert.equal(result.ruling.shadowAgreed, null, "a deferral is not a decision to grade");
    assert.equal((await h.store.readPacket(packet.id))?.status, "drilling");
    assert.deepEqual(await h.store.listPresentable(), [], "it is not presentable while drilling");
    assert.equal(h.calls.filter((call) => call.kind === "continuation").length, 0);

    const rulings = await h.store.listRulings();
    assert.equal(rulings.length, 1);
    assert.equal(rulings[0]?.question, "what did the log actually say?");
  } finally {
    await dropRoot(h.root);
  }
});

test("a ruling in one's own words is recorded and carried as written", async () => {
  const h = await harness("hq-rule-custom");
  try {
    const packet = await queuePacket(h);
    const result = await applyRuling(
      { store: h.store, spawner: h.spawner, now: h.now },
      {
        packetId: packet.id,
        form: "custom",
        text: "Skip the suite for now and open an issue for the flake.",
      },
    );
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.ruling.optionId, null);
    assert.match(result.ruling.text, /open an issue/);
    const continuation = h.calls.find((call) => call.kind === "continuation");
    assert.match(continuation?.prompt ?? "", /open an issue/);
  } finally {
    await dropRoot(h.root);
  }
});

test("nonsense rulings are refused rather than half-applied", async () => {
  const h = await harness("hq-rule-refuse");
  try {
    const packet = await queuePacket(h);
    const deps = { store: h.store, spawner: h.spawner, now: h.now };

    assert.deepEqual(
      await applyRuling(deps, { packetId: "nope", form: "accept" }),
      { error: "no such packet: nope" },
    );
    assert.equal(
      "error" in (await applyRuling(deps, {
        packetId: packet.id,
        form: "alternative",
        optionId: "invented",
      })),
      true,
    );
    // The type now makes an incomplete ruling unrepresentable; the runtime guard
    // stays for callers that arrive without it, so it is exercised through a cast.
    assert.equal(
      "error" in (await applyRuling(deps, { packetId: packet.id, form: "defer", question: "  " })),
      true,
    );
    assert.equal(
      "error" in (await applyRuling(deps, { packetId: packet.id, form: "custom", text: "" })),
      true,
    );

    await applyRuling(deps, { packetId: packet.id, form: "accept" });
    assert.equal("error" in (await applyRuling(deps, { packetId: packet.id, form: "accept" })), true);
    assert.equal((await h.store.listRulings()).length, 1, "a refused ruling records nothing");
  } finally {
    await dropRoot(h.root);
  }
});

test("crossing the threshold shows readiness; only the command grants it", async () => {
  const h = await harness("hq-rule-graduation");
  try {
    // Retune the thresholds the way the user would: by editing the file.
    const path = hqPaths(h.root).doctrineGlobal;
    const doctrineText = await readFile(path, "utf8");
    await atomicWriteText(
      path,
      doctrineText.replace(/graduation-consecutive-agreements: \d+/, "graduation-consecutive-agreements: 1")
        .replace(/graduation-min-days: \d+/, "graduation-min-days: 0"),
    );
    const deps = { store: h.store, spawner: h.spawner, now: h.now };

    const packet = await queuePacket(h, {});
    const result = await applyRuling(deps, { packetId: packet.id, form: "accept" });
    assert.equal("error" in result, false);
    if ("error" in result) return;

    // Nothing is queued about graduation itself: such a packet would spend one of
    // the user's decisions on something that by construction changes nothing. The
    // doctrine proposal this uncovered ruling earns is a different thing.
    assert.deepEqual(result.proposals, [], "the rule this implies is drafted, not templated");
    assert.equal(
      h.calls.filter((call) => call.kind === "rule").length,
      1,
      "and a drafting worker was asked for it",
    );

    const doctrine = await loadDoctrine(h.root, packet.project);
    const ready = readyDomains(await h.store.readGraduation(), doctrine.meta, new Date(h.now()));
    assert.deepEqual(ready, [packet.domain], "the card is told the domain is ready");
    assert.equal(await h.store.isGraduated(packet.domain), false, "and nothing was granted");
  } finally {
    await dropRoot(h.root);
  }
});

test("a dive is recorded as a packet-format defect", async () => {
  const h = await harness("hq-rule-defect");
  try {
    await recordDive(h.store, {
      packetId: "pkt-1",
      missing: "which test failed",
      ruling: "investigate",
      at: "2026-07-28T12:30:00.000Z",
    });
    const defects = await h.store.readDefects();
    assert.equal(defects.length, 1);
    assert.equal(defects[0]?.packetId, "pkt-1");
    assert.equal(defects[0]?.missing, "which test failed");
  } finally {
    await dropRoot(h.root);
  }
});
