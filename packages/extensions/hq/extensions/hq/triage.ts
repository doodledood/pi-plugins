/**
 * Stop triage: deciding what a stop means.
 *
 * The model reads the stop and proposes an outcome; this module decides whether
 * that outcome is allowed and makes it durable. The split is deliberate — the
 * rules that must hold (the reversibility ceiling, graduation, respawn limits)
 * are code, not prose in a prompt, so they hold whatever the model says.
 */

import { loadDoctrine, renderDoctrine, seedDoctrine, seedProjectDoctrine } from "./doctrine.ts";
import { ceilingDecision, shouldSampleForAudit } from "./graduation.ts";
import { startCompletionDrill, type DrillDeps } from "./drills.ts";
import type { Spawner } from "./spawn.ts";
import type { HqStore } from "./store.ts";
import { finishStop, readStopRecord, type StopRecord } from "./stops.ts";
import { readTranscriptTail, renderTranscript } from "./transcript.ts";
import type { BlastRadius, Packet, Reversibility, ShadowRuling } from "./types.ts";

/** How many times HQ will restart the same session before asking the user. */
export const MAX_RESPAWNS = 2;

export interface TriageDeps {
  store: HqStore;
  spawner: Spawner;
  now?: () => Date;
  random?: () => number;
}

export interface TriageContext {
  stop: StopRecord;
  transcript: string;
  doctrine: string;
  /** Domains already in use, so triage reuses them instead of coining new ones. */
  knownDomains: string[];
  graduatedDomains: string[];
  sourcePreview: string;
  project: string;
}

export async function triageContext(
  deps: TriageDeps,
  stopId: string,
): Promise<TriageContext | { error: string }> {
  const stop = await readStopRecord(deps.store.root, stopId);
  if (!stop) return { error: `no such stop: ${stopId}` };

  await seedDoctrine(deps.store.root);
  await seedProjectDoctrine(deps.store.root, stop.project);

  const doctrine = await loadDoctrine(deps.store.root, stop.project);
  const graduation = await deps.store.readGraduation();
  const transcript = await readTranscriptTail(stop.sessionFile, { maxMessages: 40 });

  return {
    stop,
    transcript: renderTranscript(transcript),
    doctrine: renderDoctrine(doctrine),
    knownDomains: Object.keys(graduation.domains),
    graduatedDomains: Object.entries(graduation.domains)
      .filter(([, stats]) => stats.graduated)
      .map(([domain]) => domain),
    sourcePreview: stop.preview,
    project: stop.project,
  };
}

export interface PacketDraft {
  domain: string;
  title: string;
  question: string;
  options: Array<{ id: string; label: string; price: string }>;
  recommendationId: string;
  flipCondition: string;
  blastRadius: BlastRadius;
  reversibility: Reversibility;
  doctrineCitations?: string[];
  shadowRuling?: ShadowRuling | null;
  trivial?: boolean;
  dependsOn?: string[];
}

export type TriageOutcome =
  | {
    kind: "packet";
    packet: PacketDraft;
  }
  | {
    kind: "continue";
    domain: string;
    /** The doctrine line that decides it; required, and verified against the file. */
    citation: string;
    instruction: string;
    blastRadius: BlastRadius;
    reversibility: Reversibility;
    summary: string;
  }
  | {
    kind: "close";
    domain: string;
    summary: string;
    unverified?: string;
    citation?: string;
  }
  | {
    kind: "respawn";
    domain: string;
    reason: string;
    instruction: string;
  };

export interface TriageResult {
  applied: "packet" | "continue" | "close" | "respawn";
  packetId: string | null;
  /** Present when a proposed continue or close was escalated instead. */
  escalationReason: string | null;
  note: string;
}

/**
 * Applies a proposed outcome. A proposed `continue` or `close` that fails the
 * ceiling or lacks a real doctrine citation becomes a packet, and the recorded
 * reason says which of those it was (AC-6.1, AC-6.2).
 */
export async function applyTriageOutcome(
  deps: TriageDeps,
  stopId: string,
  outcome: TriageOutcome,
): Promise<TriageResult | { error: string }> {
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  const stop = await readStopRecord(deps.store.root, stopId);
  if (!stop) return { error: `no such stop: ${stopId}` };
  if (stop.status === "done") return { error: `stop ${stopId} already has an outcome` };

  switch (outcome.kind) {
    case "packet":
      return applyPacketOutcome(deps, stop, outcome.packet, at, null);

    case "continue": {
      const doctrine = await loadDoctrine(deps.store.root, stop.project);
      const cited = doctrine.rules.find((rule) => rule.citation === outcome.citation)
        ?? doctrine.rules.find((rule) => outcome.citation.includes(rule.section));
      const graduated = await deps.store.isGraduated(outcome.domain);
      const decision = ceilingDecision({
        graduated,
        blastRadius: outcome.blastRadius,
        reversibility: outcome.reversibility,
        covered: Boolean(cited),
      });

      if (!decision.allowed) {
        return applyPacketOutcome(
          deps,
          stop,
          continueAsPacketDraft(outcome, decision.explanation, cited?.citation ?? null),
          at,
          decision.reason,
        );
      }

      const stats = (await deps.store.readGraduation()).domains[outcome.domain];
      const sampled = shouldSampleForAudit(doctrine.meta, stats, deps.random);
      await deps.store.appendAudit({
        at,
        sourceSessionId: stop.sessionId,
        domain: outcome.domain,
        project: stop.project,
        ruleCitation: cited?.citation ?? outcome.citation,
        action: "continue",
        summary: outcome.summary,
        sampledForReview: sampled,
      });

      if (stop.sessionFile) {
        await deps.spawner({
          kind: "continuation",
          prompt: [
            "A ruling has come back on the question you stopped for, from standing doctrine.",
            "",
            `Doctrine: ${cited?.text ?? outcome.citation}`,
            `Ruling: ${outcome.instruction}`,
            "",
            "Continue on that basis. Stop again if it does not settle what you needed.",
          ].join("\n"),
          cwd: stop.project,
          resumeSessionFile: stop.sessionFile,
          originSessionId: stop.sessionId,
        });
      }

      await finishStop(deps.store.root, stopId, "continue", null);
      return {
        applied: "continue",
        packetId: null,
        escalationReason: null,
        note: sampled
          ? "answered from doctrine; sampled for your review"
          : "answered from doctrine",
      };
    }

    case "close": {
      const doctrine = await loadDoctrine(deps.store.root, stop.project);
      const graduated = await deps.store.isGraduated(outcome.domain);
      const cited = outcome.citation
        ? doctrine.rules.find((rule) => rule.citation === outcome.citation)
        : undefined;
      const decision = ceilingDecision({
        graduated,
        blastRadius: "low",
        reversibility: "reversible",
        covered: Boolean(cited),
      });

      if (!decision.allowed) {
        // A finished piece of work the user has not seen is still a decision.
        return applyPacketOutcome(deps, stop, closeAsPacketDraft(outcome), at, decision.reason);
      }

      const stats = (await deps.store.readGraduation()).domains[outcome.domain];
      await deps.store.appendAudit({
        at,
        sourceSessionId: stop.sessionId,
        domain: outcome.domain,
        project: stop.project,
        ruleCitation: cited?.citation ?? "(none)",
        action: "close",
        summary: outcome.summary,
        sampledForReview: shouldSampleForAudit(doctrine.meta, stats, deps.random),
      });
      await finishStop(deps.store.root, stopId, "close", null);
      return {
        applied: "close",
        packetId: null,
        escalationReason: null,
        note: "closed and recorded for audit",
      };
    }

    case "respawn": {
      const respawns = await countRespawns(deps, stop.sessionId);
      if (respawns >= MAX_RESPAWNS) {
        return applyPacketOutcome(
          deps,
          stop,
          respawnAsPacketDraft(outcome, respawns),
          at,
          "respawn-limit",
        );
      }
      if (!stop.sessionFile) {
        return applyPacketOutcome(
          deps,
          stop,
          respawnAsPacketDraft(outcome, respawns),
          at,
          "no-session-file",
        );
      }
      await deps.spawner({
        kind: "continuation",
        prompt: [
          "You stopped before finishing. Pick the work back up from where it stalled.",
          "",
          `What you were doing: ${outcome.reason}`,
          `Next step: ${outcome.instruction}`,
          "",
          "If you cannot make progress without a decision, stop and say exactly what you need.",
        ].join("\n"),
        cwd: stop.project,
        resumeSessionFile: stop.sessionFile,
        originSessionId: stop.sessionId,
      });
      await finishStop(deps.store.root, stopId, "respawn", null);
      return {
        applied: "respawn",
        packetId: null,
        escalationReason: null,
        note: `respawned (${respawns + 1}/${MAX_RESPAWNS})`,
      };
    }
  }
}

async function applyPacketOutcome(
  deps: TriageDeps,
  stop: StopRecord,
  draft: PacketDraft,
  at: string,
  escalationReason: string | null,
): Promise<TriageResult> {
  const { packet, violations } = await deps.store.createPacket({
    sourceSessionId: stop.sessionId,
    sourceSessionFile: stop.sessionFile,
    project: stop.project,
    domain: draft.domain,
    title: draft.title,
    question: draft.question,
    options: draft.options,
    recommendationId: draft.recommendationId,
    flipCondition: draft.flipCondition,
    blastRadius: draft.blastRadius,
    reversibility: draft.reversibility,
    dependsOn: draft.dependsOn ?? [],
    doctrineCitations: draft.doctrineCitations ?? [],
    shadowRuling: draft.shadowRuling ?? null,
    annotations: [],
    trivial: draft.trivial ?? false,
    proposal: null,
  });

  // A packet that misses the bar is a question for the machinery: drill it rather
  // than let it reach the user under-specified (INV-G11).
  if (violations.length > 0) {
    const drillDeps: DrillDeps = { store: deps.store, spawner: deps.spawner, ...(deps.now ? { now: deps.now } : {}) };
    await startCompletionDrill(drillDeps, packet, violations);
  }

  await finishStop(deps.store.root, stop.stopId, "packet", packet.id);
  void at;
  return {
    applied: "packet",
    packetId: packet.id,
    escalationReason,
    note: violations.length > 0
      ? `packet held and drilled: ${violations.map((v) => v.field).join(", ")}`
      : "packet queued",
  };
}

/** Builds the packet a rejected `continue` becomes, keeping the reason visible. */
function continueAsPacketDraft(
  outcome: Extract<TriageOutcome, { kind: "continue" }>,
  explanation: string,
  citation: string | null,
): PacketDraft {
  return {
    domain: outcome.domain,
    title: outcome.summary.slice(0, 72) || `decision in ${outcome.domain}`,
    question: `${outcome.summary} — proceed as doctrine suggests, or differently?`,
    options: [
      {
        id: "as-proposed",
        label: outcome.instruction,
        price: `what doctrine implies here; ${explanation}`,
      },
      {
        id: "hold",
        label: "Hold and tell me more first",
        price: "the work waits until you have looked",
      },
    ],
    recommendationId: "as-proposed",
    flipCondition: `if ${explanation}, the doctrine reading is not enough on its own`,
    blastRadius: outcome.blastRadius,
    reversibility: outcome.reversibility,
    doctrineCitations: citation ? [citation] : [],
    shadowRuling: {
      optionId: "as-proposed",
      text: outcome.instruction,
      rationale: `doctrine reading: ${outcome.citation}`,
      doctrineCitations: citation ? [citation] : [],
    },
    trivial: false,
  };
}

function closeAsPacketDraft(outcome: Extract<TriageOutcome, { kind: "close" }>): PacketDraft {
  return {
    domain: outcome.domain,
    title: `finished: ${outcome.summary.slice(0, 60)}`,
    question: `This work is finished. Accept it as done, or is there a follow-up?`,
    options: [
      {
        id: "accept",
        label: "Accept as done",
        price: outcome.unverified
          ? `unverified: ${outcome.unverified}`
          : "nothing further happens on this thread",
      },
      {
        id: "follow-up",
        label: "There is a follow-up — I will say what",
        price: "the session is resumed with your instruction",
      },
    ],
    recommendationId: "accept",
    flipCondition: outcome.unverified
      ? `if ${outcome.unverified} matters, it needs checking before accepting`
      : "if the result was not what you asked for, a follow-up is right",
    blastRadius: "low",
    reversibility: "reversible",
    shadowRuling: {
      optionId: "accept",
      text: "accept as done",
      rationale: "the work completed without open questions",
      doctrineCitations: [],
    },
    trivial: true,
  };
}

function respawnAsPacketDraft(
  outcome: Extract<TriageOutcome, { kind: "respawn" }>,
  respawns: number,
): PacketDraft {
  return {
    domain: outcome.domain,
    title: `stuck: ${outcome.reason.slice(0, 60)}`,
    question:
      `This session has died ${respawns} time${respawns === 1 ? "" : "s"} and wants restarting again. Restart it, or stop and look?`,
    options: [
      {
        id: "restart",
        label: `Restart once more: ${outcome.instruction}`,
        price: "it may die the same way again",
      },
      {
        id: "abandon",
        label: "Leave it stopped for now",
        price: "the work stays where it is until you pick it up",
      },
    ],
    recommendationId: "abandon",
    flipCondition: "if the cause of death was transient (a flaky command, a timeout), restarting is right",
    blastRadius: "low",
    reversibility: "reversible",
    shadowRuling: {
      optionId: "abandon",
      text: "leave it stopped",
      rationale: "repeated deaths in the same place are rarely fixed by another restart",
      doctrineCitations: [],
    },
    trivial: false,
  };
}

/** Counts finished stops for a session that ended in a respawn. */
export async function countRespawns(deps: TriageDeps, sessionId: string): Promise<number> {
  const { scanJsonDir } = await import("./io.ts");
  const { parseStopRecord } = await import("./stops.ts");
  const { hqPaths } = await import("./paths.ts");
  const scan = await scanJsonDir(
    hqPaths(deps.store.root).stops,
    parseStopRecord,
    (record) => record.stopId,
  );
  return scan.records.filter(
    (entry) => entry.record.sessionId === sessionId && entry.record.outcome === "respawn",
  ).length;
}

/** The queue sweep: re-runs triage for stops that still owe an outcome. */
export async function sweepStops(deps: TriageDeps): Promise<{ retried: string[] }> {
  const { findStopsNeedingTriage, claimStop, reopenStop } = await import("./stops.ts");
  const { TRIAGE_KICKOFF } = await import("./prompts.ts");
  const now = deps.now ?? (() => new Date());
  const stale = await findStopsNeedingTriage(deps.store.root);
  const retried: string[] = [];

  for (const { record, reason } of stale) {
    if (reason === "claimant-dead") await reopenStop(deps.store.root, record.stopId);
    const at = now().toISOString();
    const won = await claimStop(deps.store.root, record.stopId, process.pid, at);
    if (!won) continue;
    await deps.spawner({
      kind: "triage",
      prompt: TRIAGE_KICKOFF(record.stopId),
      cwd: record.project,
      env: { HQ_STOP_ID: record.stopId },
    });
    retried.push(record.stopId);
  }
  return { retried };
}

/** Convenience for a packet's presentable form in a prompt or a log line. */
export function describePacket(packet: Packet): string {
  const recommended = packet.options.find((option) => option.id === packet.recommendationId);
  return [
    `${packet.title} (${packet.domain}, ${packet.blastRadius} blast, ${packet.reversibility})`,
    packet.question,
    ...packet.options.map(
      (option) =>
        `- ${option.id === packet.recommendationId ? "[recommended] " : ""}${option.label} — ${option.price}`,
    ),
    `Flips if: ${packet.flipCondition}`,
    recommended ? `Recommended: ${recommended.label}` : "",
    ...packet.annotations.map(
      (annotation) =>
        `Drilled: ${annotation.question}\n${annotation.answer}${
          annotation.quotes.length > 0
            ? `\n${annotation.quotes.map((quote) => `  > ${quote.text} — ${quote.attribution}`).join("\n")}`
            : ""
        }`,
    ),
  ].filter((line) => line !== "").join("\n");
}
