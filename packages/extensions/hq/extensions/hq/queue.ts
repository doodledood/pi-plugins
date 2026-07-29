/**
 * Presentation planning: the order and grouping the queue is shown in.
 *
 * The queue is not FIFO, because the cost being minimized is the user's context
 * switches, not a packet's wait. Packets from one project are decided together,
 * consequential ones first, cheap same-project ones batched into a single ask,
 * and anything whose decision depends on another packet is never in the same ask
 * as the packet it depends on.
 *
 * Every rule reads its numbers from the doctrine file's Meta section, so the
 * user can retune batching by editing prose (AC-5.1).
 */

import type { MetaDoctrine } from "./doctrine.ts";
import type { BlastRadius, Packet } from "./types.ts";

const BLAST_RANK: Record<BlastRadius, number> = { high: 0, medium: 1, low: 2 };

export interface PlannedBatch {
  packets: Packet[];
  /** Why these were grouped this way, so the plan can be explained and tested. */
  reason: string;
}

export interface PresentationPlan {
  batches: PlannedBatch[];
  /** Packets excluded from presentation, with the reason. */
  withheld: Array<{ packetId: string; reason: string }>;
}

function compareForPresentation(a: Packet, b: Packet): number {
  const blast = BLAST_RANK[a.blastRadius] - BLAST_RANK[b.blastRadius];
  if (blast !== 0) return blast;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}

/**
 * Orders packets so a dependency is decided before its dependent, keeping the
 * blast-then-age order everywhere the dependencies leave free.
 */
export function orderWithDependencies(packets: readonly Packet[]): Packet[] {
  const byId = new Map(packets.map((packet) => [packet.id, packet]));
  const remaining = [...packets].sort(compareForPresentation);
  const emitted = new Set<string>();
  const ordered: Packet[] = [];

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((packet) =>
      packet.dependsOn.every((id) => !byId.has(id) || emitted.has(id))
    );
    // A dependency cycle would stall the queue; fall back to the sorted order so
    // the user still sees the work rather than nothing.
    const index = readyIndex === -1 ? 0 : readyIndex;
    const next = remaining.splice(index, 1)[0];
    if (!next) break;
    ordered.push(next);
    emitted.add(next.id);
  }
  return ordered;
}

function dependencyLinked(a: Packet, b: Packet): boolean {
  return a.dependsOn.includes(b.id) || b.dependsOn.includes(a.id);
}

/**
 * Builds the plan. `presentable` should already exclude held and ruled packets;
 * anything passed in that cannot be presented is reported as withheld rather
 * than silently dropped.
 */
export function planPresentation(
  presentable: readonly Packet[],
  meta: MetaDoctrine,
): PresentationPlan {
  const withheld: PresentationPlan["withheld"] = [];
  const eligible: Packet[] = [];
  for (const packet of presentable) {
    if (packet.status === "pending") eligible.push(packet);
    else withheld.push({ packetId: packet.id, reason: `status is ${packet.status}` });
  }

  const groups = new Map<string, Packet[]>();
  for (const packet of orderWithDependencies(eligible)) {
    const group = groups.get(packet.project) ?? [];
    group.push(packet);
    groups.set(packet.project, group);
  }

  // Projects are visited in the order their oldest packet arrived, so a project
  // does not starve behind a busier one.
  const groupOrder = [...groups.entries()].sort((left, right) => {
    const oldest = (packets: Packet[]) =>
      packets.reduce((min, packet) => (packet.createdAt < min ? packet.createdAt : min), "9999");
    const compared = oldest(left[1]).localeCompare(oldest(right[1]));
    return compared !== 0 ? compared : left[0].localeCompare(right[0]);
  });

  const batches: PlannedBatch[] = [];
  for (const [project, packets] of groupOrder) {
    let current: Packet[] = [];
    let currentReason = "";

    const flush = () => {
      if (current.length === 0) return;
      batches.push({
        packets: current,
        reason: current.length === 1 ? currentReason : `batched: ${currentReason}`,
      });
      current = [];
      currentReason = "";
    };

    for (const packet of packets) {
      if (packet.blastRadius === "high") {
        flush();
        batches.push({ packets: [packet], reason: "high blast radius: decided alone" });
        continue;
      }
      const batchable = (!meta.batchTrivialOnly || packet.trivial)
        && packet.reversibility === "reversible";
      if (!batchable) {
        flush();
        batches.push({
          packets: [packet],
          reason: packet.reversibility === "one-way"
            ? "one-way decision: decided alone"
            : "not trivial: decided alone",
        });
        continue;
      }
      if (current.some((existing) => dependencyLinked(existing, packet))) {
        flush();
      }
      if (current.length >= meta.batchMax) flush();
      current.push(packet);
      currentReason = `${current.length} trivial packets in ${project}`;
    }
    flush();
  }

  return { batches, withheld };
}

/** Flattens a plan back to packet ids, which is what tests and logs compare. */
export function planIds(plan: PresentationPlan): string[][] {
  return plan.batches.map((batch) => batch.packets.map((packet) => packet.id));
}

/**
 * What the seat has not been told about yet, and what it should remember. Ids that
 * have left the queue are forgotten, so a packet that comes back — a held one that
 * was filled, a drill that returned — is announced again rather than staying silent.
 */
export function newlyArrived(
  announced: ReadonlySet<string>,
  present: readonly string[],
): { fresh: string[]; next: Set<string> } {
  const fresh = present.filter((id) => !announced.has(id));
  return { fresh, next: new Set(present) };
}
