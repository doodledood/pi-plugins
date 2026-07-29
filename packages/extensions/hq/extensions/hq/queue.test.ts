import assert from "node:assert/strict";
import test from "node:test";
import { META_DEFAULTS, type MetaDoctrine } from "./doctrine.ts";
import { orderWithDependencies, planIds, planPresentation, newlyArrived } from "./queue.ts";
import { packetDraftFixture } from "./testing.ts";
import type { BlastRadius, Packet, Reversibility } from "./types.ts";

function packet(
  id: string,
  overrides: {
    project?: string;
    blastRadius?: BlastRadius;
    reversibility?: Reversibility;
    trivial?: boolean;
    createdAt?: string;
    dependsOn?: string[];
    status?: Packet["status"];
    annotations?: Packet["annotations"];
  } = {},
): Packet {
  const draft = packetDraftFixture();
  return {
    ...draft,
    version: 1,
    id,
    createdAt: overrides.createdAt ?? "2026-07-28T12:00:00.000Z",
    updatedAt: overrides.createdAt ?? "2026-07-28T12:00:00.000Z",
    generation: 1,
    status: overrides.status ?? "pending",
    project: overrides.project ?? "/work/alpha",
    blastRadius: overrides.blastRadius ?? "low",
    reversibility: overrides.reversibility ?? "reversible",
    trivial: overrides.trivial ?? true,
    dependsOn: overrides.dependsOn ?? [],
    annotations: overrides.annotations ?? [],
  };
}

const meta: MetaDoctrine = { ...META_DEFAULTS };

test("a dependency is always decided before the packet that depends on it", () => {
  const ordered = orderWithDependencies([
    packet("b", { dependsOn: ["a"], createdAt: "2026-07-28T11:00:00.000Z" }),
    packet("a", { createdAt: "2026-07-28T12:00:00.000Z" }),
  ]);
  assert.deepEqual(ordered.map((p) => p.id), ["a", "b"]);
});

test("a dependency cycle still shows the work instead of stalling the queue", () => {
  const ordered = orderWithDependencies([
    packet("a", { dependsOn: ["b"] }),
    packet("b", { dependsOn: ["a"] }),
  ]);
  assert.equal(ordered.length, 2);
});

test("a mixed queue is grouped by project, blast-ordered, and batched to the cap", () => {
  const packets = [
    packet("alpha-high", { blastRadius: "high", createdAt: "2026-07-28T12:05:00.000Z" }),
    packet("alpha-1", { createdAt: "2026-07-28T12:01:00.000Z" }),
    packet("alpha-2", { createdAt: "2026-07-28T12:02:00.000Z" }),
    packet("alpha-3", { createdAt: "2026-07-28T12:03:00.000Z" }),
    packet("alpha-4", { createdAt: "2026-07-28T12:04:00.000Z" }),
    packet("alpha-5", { createdAt: "2026-07-28T12:06:00.000Z" }),
    packet("beta-1", { project: "/work/beta", createdAt: "2026-07-28T12:10:00.000Z" }),
    packet("beta-2", { project: "/work/beta", createdAt: "2026-07-28T12:11:00.000Z" }),
    packet("dep-first", { project: "/work/beta", createdAt: "2026-07-28T12:12:00.000Z" }),
    packet("dep-second", {
      project: "/work/beta",
      createdAt: "2026-07-28T12:13:00.000Z",
      dependsOn: ["dep-first"],
    }),
    packet("held", { status: "held" }),
  ];

  const plan = planPresentation(packets, meta);
  const ids = planIds(plan);

  // Projects stay together, in the order their oldest packet arrived.
  const flat = ids.flat();
  const alphaLast = flat.lastIndexOf("alpha-5");
  const betaFirst = flat.indexOf("beta-1");
  assert.equal(alphaLast < betaFirst, true, "alpha is finished before beta starts");

  // The high-blast packet is decided alone and first within its project.
  assert.deepEqual(ids[0], ["alpha-high"]);
  assert.match(plan.batches[0]?.reason ?? "", /high blast/);

  // Batches never exceed the cap.
  for (const batch of ids) assert.equal(batch.length <= meta.batchMax, true);

  // Dependent packets are never in the same ask.
  const together = ids.find(
    (batch) => batch.includes("dep-first") && batch.includes("dep-second"),
  );
  assert.equal(together, undefined);
  assert.equal(flat.indexOf("dep-first") < flat.indexOf("dep-second"), true);

  // A held packet is reported as withheld rather than quietly dropped.
  assert.deepEqual(plan.withheld, [{ packetId: "held", reason: "status is held" }]);
});

test("changing a Meta value changes the plan", () => {
  const packets = [
    packet("a", { createdAt: "2026-07-28T12:01:00.000Z" }),
    packet("b", { createdAt: "2026-07-28T12:02:00.000Z" }),
    packet("c", { createdAt: "2026-07-28T12:03:00.000Z" }),
  ];
  assert.deepEqual(planIds(planPresentation(packets, meta)), [["a", "b", "c"]]);
  assert.deepEqual(
    planIds(planPresentation(packets, { ...meta, batchMax: 2 })),
    [["a", "b"], ["c"]],
  );
  assert.deepEqual(
    planIds(planPresentation(packets, { ...meta, batchMax: 1 })),
    [["a"], ["b"], ["c"]],
  );
});

test("a non-trivial or one-way packet is decided alone", () => {
  const packets = [
    packet("trivial-1"),
    packet("weighty", { trivial: false, createdAt: "2026-07-28T12:01:00.000Z" }),
    packet("one-way", { reversibility: "one-way", createdAt: "2026-07-28T12:02:00.000Z" }),
    packet("trivial-2", { createdAt: "2026-07-28T12:03:00.000Z" }),
  ];
  const plan = planPresentation(packets, meta);
  const solo = plan.batches.filter((batch) => batch.packets.length === 1).map((batch) =>
    batch.packets[0]?.id
  );
  assert.equal(solo.includes("weighty"), true);
  assert.equal(solo.includes("one-way"), true);
  assert.match(
    plan.batches.find((batch) => batch.packets[0]?.id === "one-way")?.reason ?? "",
    /one-way/,
  );
});

test("batching trivial packets can be turned off entirely from Meta", () => {
  const packets = [packet("a"), packet("b", { createdAt: "2026-07-28T12:01:00.000Z" })];
  const plan = planPresentation(packets, { ...meta, batchTrivialOnly: true, batchMax: 4 });
  assert.deepEqual(planIds(plan), [["a", "b"]]);

  const nonTrivial = [
    packet("a", { trivial: false }),
    packet("b", { trivial: false, createdAt: "2026-07-28T12:01:00.000Z" }),
  ];
  assert.deepEqual(planIds(planPresentation(nonTrivial, meta)), [["a"], ["b"]]);
});

test("an annotated drill return rejoins its project group rather than going last", () => {
  const packets = [
    packet("alpha-1", { createdAt: "2026-07-28T12:01:00.000Z" }),
    packet("beta-1", { project: "/work/beta", createdAt: "2026-07-28T12:02:00.000Z" }),
    packet("alpha-returned", {
      createdAt: "2026-07-28T12:03:00.000Z",
      annotations: [
        {
          at: "2026-07-28T12:30:00.000Z",
          question: "what did it try?",
          answer: "it retried twice",
          quotes: [{ text: "retrying", attribution: "sess-a" }],
          tier: 1,
        },
      ],
    }),
  ];
  const flat = planIds(planPresentation(packets, meta)).flat();
  assert.deepEqual(flat, ["alpha-1", "alpha-returned", "beta-1"]);
});

test("the seat is told about work once, and again if it comes back", () => {
  const first = newlyArrived(new Set(), ["a", "b"]);
  assert.deepEqual(first.fresh, ["a", "b"]);

  // Nothing new: a seated session is not nudged every ten seconds forever.
  assert.deepEqual(newlyArrived(first.next, ["a", "b"]).fresh, []);

  // Ruling on one leaves the other silent, and a returning packet speaks again.
  const afterRuling = newlyArrived(first.next, ["b"]);
  assert.deepEqual(afterRuling.fresh, []);
  assert.deepEqual(newlyArrived(afterRuling.next, ["b", "a"]).fresh, ["a"]);
});
