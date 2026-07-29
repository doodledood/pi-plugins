/**
 * The presentation plan over a queue that exists on disk, with the batching
 * numbers parsed from a real doctrine file rather than from META_DEFAULTS.
 *
 * queue.test.ts covers the planning rules with a literal MetaDoctrine. This file
 * covers the path the user actually has: a seeded doctrine markdown file, edited
 * as prose, governing how the queue is presented.
 */

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { loadDoctrine, META_DEFAULTS, seedDoctrine } from "./doctrine.ts";
import { hqPaths } from "./paths.ts";
import { planIds, planPresentation } from "./queue.ts";
import { HqStore } from "./store.ts";
import { dropRoot, makeRoot, packetDraftFixture } from "./testing.ts";
import type { Packet } from "./types.ts";

const DRILL_ANNOTATION = {
  at: "2026-07-28T13:00:00.000Z",
  question: "what did the worker already try?",
  answer: "it retried the suite twice and both runs failed on the same test",
  quotes: [{ text: "retrying the integration suite", attribution: "sess-a" }],
  tier: 1 as const,
};

/**
 * Seeds a queue with everything the ordering rules speak to: three projects, a
 * high-blast packet, a dependent pair, more trivial same-project packets than
 * the batch cap, and a drill that comes back annotated.
 */
async function seedQueue(root: string): Promise<HqStore> {
  // One minute per packet, in creation order, so ages are deterministic.
  let tick = 0;
  const store = new HqStore({
    root,
    now: () => new Date(Date.parse("2026-07-28T12:00:00.000Z") + 60_000 * tick++),
  });
  await store.ensure();

  const add = async (
    id: string,
    overrides: Partial<Parameters<typeof packetDraftFixture>[0]> = {},
  ) => {
    // Distinct questions, so the store's deduplication treats them as distinct.
    const { violations } = await store.createPacket({
      id,
      ...packetDraftFixture({ title: `decide ${id}`, question: `what about ${id}?`, ...overrides }),
    });
    assert.deepEqual(violations, [], `${id} must clear the packet bar to be presentable`);
  };

  await add("alpha-1");
  await add("alpha-2");
  await add("alpha-3");
  await add("alpha-4");
  await add("alpha-5");
  await add("alpha-high", { blastRadius: "high" });
  await add("beta-1", { project: "/work/beta" });
  await add("beta-dep-base", { project: "/work/beta" });
  await add("beta-dep-follow", { project: "/work/beta", dependsOn: ["beta-dep-base"] });
  await add("gamma-1", { project: "/work/gamma" });
  await add("gamma-drilled", { project: "/work/gamma" });

  // The drill return: annotated after the fact, exactly as a drill answer lands.
  const returned = await store.updatePacket("gamma-drilled", (packet: Packet) => ({
    ...packet,
    annotations: [DRILL_ANNOTATION],
  }));
  assert.equal(returned?.annotations.length, 1);
  assert.equal(returned?.status, "pending", "an annotated drill return is presentable again");
  return store;
}

test("the queue on disk is presented by the rules, with the numbers read from doctrine", async () => {
  const root = await makeRoot("hq-queue-doctrine");
  try {
    const store = await seedQueue(root);
    await seedDoctrine(root);
    const fileText = await readFile(hqPaths(root).doctrineGlobal, "utf8");
    const doctrine = await loadDoctrine(root, "/work/alpha", (message, error) => {
      throw new Error(`${message}: ${String(error)}`);
    });
    const meta = doctrine.meta;
    // The cap under test has to be the file's number, not the compiled default.
    assert.match(fileText, new RegExp(`^-\\s+batch-max:\\s+${meta.batchMax}\\b`, "m"));

    const presentable = await store.listPresentable();
    assert.equal(presentable.length, 11);
    const plan = planPresentation(presentable, meta);
    const ids = planIds(plan);
    const flat = ids.flat();

    // Project grouping: each project is one contiguous run and no batch mixes projects.
    const projectOf = new Map(presentable.map((packet) => [packet.id, packet.project]));
    const runs: string[] = [];
    for (const id of flat) {
      const project = projectOf.get(id) ?? "?";
      if (runs[runs.length - 1] !== project) runs.push(project);
    }
    assert.deepEqual(runs, ["/work/alpha", "/work/beta", "/work/gamma"]);
    for (const batch of plan.batches) {
      assert.equal(new Set(batch.packets.map((packet) => packet.project)).size, 1);
    }

    // High blast: alone, and first in its project.
    assert.deepEqual(ids[0], ["alpha-high"]);
    assert.match(plan.batches[0]?.reason ?? "", /high blast/);

    // Dependents: never in one ask, dependency decided first.
    assert.equal(
      ids.find((batch) => batch.includes("beta-dep-base") && batch.includes("beta-dep-follow")),
      undefined,
    );
    assert.equal(flat.indexOf("beta-dep-base") < flat.indexOf("beta-dep-follow"), true);

    // Batch cap: from the file, and the overflowing trivial run splits at it.
    for (const batch of ids) assert.equal(batch.length <= meta.batchMax, true);
    assert.deepEqual(
      ids.filter((batch) => batch.every((id) => /^alpha-[1-5]$/.test(id))),
      [["alpha-1", "alpha-2", "alpha-3", "alpha-4"], ["alpha-5"]],
    );

    // Drill return: rejoins its project group instead of being appended last.
    assert.deepEqual(flat.filter((id) => id.startsWith("gamma")), ["gamma-1", "gamma-drilled"]);
    assert.equal(
      plan.batches
        .find((batch) => batch.packets.some((packet) => packet.id === "gamma-drilled"))
        ?.packets.some((packet) => packet.id === "gamma-1"),
      true,
    );
    assert.deepEqual(plan.withheld, []);
  } finally {
    await dropRoot(root);
  }
});

test("editing the doctrine file regroups the plan", async () => {
  const root = await makeRoot("hq-queue-doctrine-edit");
  try {
    const store = await seedQueue(root);
    await seedDoctrine(root);
    const path = hqPaths(root).doctrineGlobal;
    const presentable = await store.listPresentable();

    const before = planIds(planPresentation(presentable, (await loadDoctrine(root, undefined)).meta));

    // Edit as a user would: change the number, keep the range hint beside it.
    const seeded = await readFile(path, "utf8");
    const edited = seeded.replace(/^(-\s+batch-max:\s+)4/m, "$12");
    assert.notEqual(edited, seeded, "the doctrine edit must actually apply");
    await writeFile(path, edited, "utf8");

    const meta = (await loadDoctrine(root, undefined)).meta;
    assert.equal(meta.batchMax, 2, "the edited file is what sets the new cap");
    assert.notEqual(meta.batchMax, META_DEFAULTS.batchMax);

    const after = planIds(planPresentation(presentable, meta));
    assert.notDeepEqual(after, before);
    for (const batch of after) assert.equal(batch.length <= 2, true);
    assert.deepEqual(
      after.filter((batch) => batch.every((id) => /^alpha-[1-5]$/.test(id))),
      [["alpha-1", "alpha-2"], ["alpha-3", "alpha-4"], ["alpha-5"]],
    );
    assert.deepEqual(after.flat(), before.flat(), "same packets, only the grouping changed");
  } finally {
    await dropRoot(root);
  }
});
