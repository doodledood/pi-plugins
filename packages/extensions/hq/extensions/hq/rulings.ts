/**
 * What happens when the user rules.
 *
 * A ruling does four things, in this order: it becomes a durable record, it is
 * carried to the work that was waiting on it, it grades the shadow ruling that
 * predicted it, and it feeds the doctrine loop — agreement is evidence, an
 * override is a contradiction to resolve, and an uncited decision is a gap worth
 * a rule. Recording precedes routing so no work can move on an unrecorded ruling.
 */

import { applyRatifiedRule, coverageFor, loadDoctrine } from "./doctrine.ts";
import {
  allowNextProposal,
  graduationProposalCheck,
  markProposed,
  muteProposals,
  recordShadowOutcome,
} from "./graduation.ts";
import { newId } from "./io.ts";
import type { Spawner } from "./spawn.ts";
import type { HqStore } from "./store.ts";
import type {
  CoverageBucket,
  DefectRecord,
  Packet,
  PacketProposal,
  Ruling,
  RulingForm,
  RulingRouting,
} from "./types.ts";

/**
 * What the user decided, in the only four shapes that exist. `form` is a real
 * discriminant: an alternative cannot be missing its option, a custom ruling
 * cannot be missing its words, and a deferral cannot be missing its question, so
 * those states are unrepresentable rather than guarded at runtime.
 */
export type RulingRequest = { presentedGeneration?: number } & (
  | { packetId: string; form: "accept"; text?: string }
  | { packetId: string; form: "alternative"; optionId: string; text?: string }
  | { packetId: string; form: "custom"; text: string }
  | { packetId: string; form: "defer"; question: string }
);

export interface RulingDeps {
  store: HqStore;
  spawner: Spawner;
  now?: () => Date;
  /** Injected so drilling can be observed in tests without a model. */
  startDrill?: (packet: Packet, question: string) => Promise<{ spawnedSessionId: string | null }>;
}

export interface RulingResult {
  ruling: Ruling;
  packet: Packet;
  /** Follow-on packets HQ created because of this ruling. */
  proposals: Packet[];
  doctrineApplied: boolean;
  note: string;
}

/** Which option the user effectively chose, or null when they wrote their own. */
export function chosenOptionId(packet: Packet, request: RulingRequest): string | null {
  if (request.form === "accept") return packet.recommendationId;
  if (request.form === "alternative") return request.optionId;
  return null;
}

/**
 * Grades the shadow ruling. Null means there was nothing to grade — no shadow
 * ruling, or a deferral, which is not yet a decision.
 */
export function gradeShadow(packet: Packet, request: RulingRequest): boolean | null {
  if (request.form === "defer") return null;
  // Declining to decide yet is not a decision, so it grades nothing — otherwise
  // "hold and tell me more first" would read as the user overruling doctrine and
  // would queue an amendment against a rule they never disagreed with.
  if (!packet.shadowRuling?.optionId) return null;
  const chosenOption = packet.options.find(
    (option) => option.id === chosenOptionId(packet, request),
  );
  if (chosenOption?.defers) return null;
  const shadow = packet.shadowRuling;
  if (!shadow) return null;
  const chosen = chosenOptionId(packet, request);
  if (chosen === null || shadow.optionId === null) {
    // A custom ruling against a shadow that named an option is a disagreement:
    // the machinery would have done something the user did not do.
    return false;
  }
  return shadow.optionId === chosen;
}

function rulingText(packet: Packet, request: RulingRequest): string {
  if (request.form !== "defer" && request.text?.trim()) return request.text.trim();
  const chosen = chosenOptionId(packet, request);
  const option = packet.options.find((candidate) => candidate.id === chosen);
  return option ? option.label : "";
}

export async function applyRuling(
  deps: RulingDeps,
  request: RulingRequest,
): Promise<RulingResult | { error: string }> {
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  const packet = await deps.store.readPacket(request.packetId);
  if (!packet) return { error: `no such packet: ${request.packetId}` };
  if (packet.status === "ruled") return { error: `packet ${packet.id} already has a ruling` };
  // The packet may have been drilled or patched between being shown and being
  // answered. Answering the version the user did not see is worse than asking again.
  if (
    request.presentedGeneration !== undefined &&
    request.presentedGeneration !== packet.generation
  ) {
    return {
      error:
        `packet ${packet.id} changed since it was shown (generation ${request.presentedGeneration} → ${packet.generation}); present it again`,
    };
  }
  if (request.form === "alternative" && !packet.options.some((o) => o.id === request.optionId)) {
    return { error: `option ${request.optionId} is not on packet ${packet.id}` };
  }
  if (request.form === "defer" && !request.question.trim()) {
    return { error: "a deferral needs a question to drill" };
  }
  if (request.form === "custom" && !request.text.trim()) {
    return { error: "a ruling in your own words needs the words" };
  }

  const shadowAgreed = gradeShadow(packet, request);
  const coverage: CoverageBucket = coverageFor({
    citations: packet.doctrineCitations,
    shadowAgreed,
    // Only a line that can decide counts as coverage; the continue and close paths
    // already refuse to act on a Taste, so counting one here would advance the
    // authority ladder on a rule that can never answer a stop.
    doctrine: await loadDoctrine(deps.store.root, packet.project),
  });

  // --- deferral: hand off to a drill and leave the packet in the queue --------
  if (request.form === "defer") {
    const question = request.question.trim();
    const drill = deps.startDrill
      ? await deps.startDrill(packet, question)
      : { spawnedSessionId: null };
    // The drill marks the packet itself; this covers the case where drilling was
    // stubbed or could not start, so a deferred packet is never left presentable.
    const afterDrill = await deps.store.readPacket(packet.id);
    const updated = afterDrill?.status === "drilling"
      ? afterDrill
      : await deps.store.updatePacket(packet.id, (current) => ({ ...current, status: "drilling" }));
    const ruling = buildRuling({
      at,
      packet,
      request,
      coverage,
      shadowAgreed,
      routing: {
        action: "drill",
        sessionFile: packet.sourceSessionFile,
        spawnedSessionId: drill.spawnedSessionId,
        note: `drilling: ${question}`,
      },
    });
    await deps.store.recordRuling(ruling);
    return {
      ruling,
      packet: updated ?? packet,
      proposals: [],
      doctrineApplied: false,
      note: "deferred to a drill; the packet returns annotated",
    };
  }

  // --- a proposal packet: ratification is the act ----------------------------
  let doctrineApplied = false;
  if (packet.proposal) {
    const outcome = await applyProposalRuling(deps, packet, packet.proposal, request);
    if ("error" in outcome) return outcome;
    doctrineApplied = outcome.applied;
  }

  // Record before routing: a continuation that starts on an unrecorded ruling
  // would re-ask the user the same question and lose the shadow grading. The
  // spawned session's id is not known until after routing, so it lands in a
  // second append of the same ruling id, which readers resolve last-wins.
  const pending = buildRuling({
    at,
    packet,
    request,
    coverage,
    shadowAgreed,
    routing: {
      action: packet.proposal ? "none" : packet.sourceSessionFile ? "resume" : "none",
      sessionFile: packet.sourceSessionFile,
      spawnedSessionId: null,
      note: "recorded; routing pending",
    },
  });
  await deps.store.recordRuling(pending, { archive: false });

  const routing = await routeRuling(deps, packet, request, at);
  const ruling: Ruling = { ...pending, routing };
  await deps.store.recordRuling(ruling);

  const proposals: Packet[] = [];
  // Graduation is measured per domain; HQ's own doctrine packets are excluded so
  // ratifying rules can never earn authority over ratifying rules.
  if (!packet.proposal) {
    const stats = await recordShadowOutcome(deps.store, {
      domain: packet.domain,
      agreed: shadowAgreed,
      at,
    });
    const doctrine = await loadDoctrine(deps.store.root, packet.project);
    const check = graduationProposalCheck(stats, doctrine.meta, at);
    if (check.propose) {
      proposals.push(await createGraduationProposal(deps, packet, check.reason));
      await markProposed(deps.store, packet.domain, at);
    }
    const doctrineProposal = await createDoctrineProposal(deps, packet, ruling);
    if (doctrineProposal) proposals.push(doctrineProposal);
  }

  return {
    ruling,
    packet,
    proposals,
    doctrineApplied,
    note: routing.note,
  };
}

function buildRuling(input: {
  at: string;
  packet: Packet;
  request: RulingRequest;
  coverage: CoverageBucket;
  shadowAgreed: boolean | null;
  routing: RulingRouting;
}): Ruling {
  return {
    version: 1,
    id: newId("rul", new Date(input.at)),
    at: input.at,
    packetId: input.packet.id,
    packetGeneration: input.request.presentedGeneration ?? input.packet.generation,
    domain: input.packet.domain,
    project: input.packet.project,
    form: input.request.form,
    optionId: chosenOptionId(input.packet, input.request),
    text: rulingText(input.packet, input.request),
    question: input.request.form === "defer" ? input.request.question.trim() : null,
    coverage: input.coverage,
    shadowAgreed: input.shadowAgreed,
    routing: input.routing,
  };
}

/**
 * Carries the ruling to the waiting work by resuming the source session with it.
 * HQ does not perform the decided action itself — the worker does, inside its own
 * permission envelope (INV-G9).
 */
async function routeRuling(
  deps: RulingDeps,
  packet: Packet,
  request: RulingRequest,
  at: string,
): Promise<RulingRouting> {
  if (packet.proposal) {
    return {
      action: "none",
      sessionFile: null,
      spawnedSessionId: null,
      note: "HQ's own doctrine: nothing to carry",
    };
  }
  if (!packet.sourceSessionFile) {
    return {
      action: "none",
      sessionFile: null,
      spawnedSessionId: null,
      note: "source session was ephemeral; ruling recorded only",
    };
  }

  const chosen = chosenOptionId(packet, request);
  const option = packet.options.find((candidate) => candidate.id === chosen);
  const words = request.form === "defer" ? undefined : request.text?.trim();
  const decision = [
    `A ruling has come back on the question you stopped for.`,
    ``,
    `Question: ${packet.question}`,
    `Ruling: ${option ? option.label : rulingText(packet, request)}`,
    words ? `In the user's words: ${words}` : "",
    ``,
    `Continue the work on that basis. If the ruling does not settle something you`,
    `need, stop again and say exactly what is missing.`,
  ].filter((line) => line !== "").join("\n");

  const spawned = await deps.spawner({
    kind: "continuation",
    prompt: decision,
    cwd: packet.project,
    resumeSessionFile: packet.sourceSessionFile,
    originSessionId: packet.sourceSessionId,
    packetId: packet.id,
  });

  return {
    action: "resume",
    sessionFile: packet.sourceSessionFile,
    spawnedSessionId: spawned.runId,
    note: `resumed ${packet.sourceSessionId} at ${at}`,
  };
}

async function applyProposalRuling(
  deps: RulingDeps,
  packet: Packet,
  proposal: PacketProposal,
  request: RulingRequest,
): Promise<{ applied: boolean } | { error: string }> {
  // A graduation proposal is informational: only the user's command can flip a
  // domain, so ruling on the packet never changes authority (INV-G8).
  if (proposal.kind === "graduation") {
    // Both options leave authority untouched, so what distinguishes them is whether
    // HQ raises the domain again. The proposal is already stamped as sent, so
    // stamping it again would have made "stop proposing" and "not yet" identical.
    if (proposal.domain) {
      if (chosenOptionId(packet, request) === "reject") {
        await muteProposals(deps.store, proposal.domain);
      } else {
        await allowNextProposal(deps.store, proposal.domain);
      }
    }
    return { applied: false };
  }

  const chosen = chosenOptionId(packet, request);
  const ratifying = chosen === "ratify" || (request.form === "custom" && !!request.text.trim());
  if (!ratifying) return { applied: false };

  const ruleText = request.form === "custom" && request.text.trim()
    ? request.text.trim()
    : proposal.ruleText;

  const result = await applyRatifiedRule({
    root: deps.store.root,
    scope: proposal.scope,
    project: packet.project,
    section: proposal.section,
    ruleText,
    ...(proposal.replaces ? { replaces: proposal.replaces } : {}),
  });
  if (!result.applied) return { error: result.reason ?? "could not apply the ratified rule" };
  return { applied: true };
}

async function createDoctrineProposal(
  deps: RulingDeps,
  packet: Packet,
  ruling: Ruling,
): Promise<Packet | undefined> {
  if (ruling.coverage === "covered-agreed") return undefined;

  // An amendment must carry the rule it replaces as *text*, because that is what
  // the ratifier matches on; a citation string would never be found in the file.
  // When the cited rule cannot be resolved, this becomes a new rule instead of an
  // amendment that could never be applied.
  const doctrine = await loadDoctrine(deps.store.root, packet.project);
  const citedRule = packet.doctrineCitations[0]
    ? doctrine.rules.find((rule) => rule.citation === packet.doctrineCitations[0])
    : undefined;
  const amendment = ruling.coverage === "contradicts" && citedRule !== undefined;
  const ruleText = amendment
    ? `In ${packet.domain}: ${ruling.text || "the user's ruling"} — this overrides the earlier rule for this case.`
    : `In ${packet.domain}: ${ruling.text || "the user's ruling"}.`;

  const { packet: created } = await deps.store.createPacket({
    sourceSessionId: packet.sourceSessionId,
    sourceSessionFile: packet.sourceSessionFile,
    project: packet.project,
    domain: "hq-doctrine",
    title: amendment
      ? `amend doctrine for ${packet.domain}`
      : `add a doctrine rule for ${packet.domain}`,
    question: amendment
      ? `Your ruling went against the doctrine line HQ cited. Should the rule change to match?`
      : `Nothing in doctrine decided this. Should this become a rule?`,
    options: [
      {
        id: "ratify",
        label: `Ratify: "${ruleText}"`,
        price: "HQ will cite this rule next time; you can edit or delete the line later",
      },
      {
        id: "reject",
        label: "Leave doctrine as it is",
        price: "the same decision reaches you again next time",
      },
    ],
    recommendationId: "ratify",
    flipCondition:
      "if the ruling was specific to this case rather than a general rule, rejecting is right",
    blastRadius: "low",
    reversibility: "reversible",
    dependsOn: [],
    doctrineCitations: packet.doctrineCitations,
    shadowRuling: {
      optionId: "ratify",
      text: "ratify",
      rationale: amendment
        ? "a ruling that contradicts a cited rule usually means the rule is wrong or too broad"
        : "an uncovered ruling is the raw material doctrine is made of",
      doctrineCitations: [],
    },
    annotations: [],
    trivial: true,
    proposal: {
      kind: amendment ? "amendment" : "new-rule",
      // An amendment must be written into the file the cited rule lives in.
      scope: amendment ? (citedRule?.scope ?? "global") : packet.project ? "project" : "global",
      section: citedRule?.section ?? "Precedents",
      ruleText,
      replaces: amendment ? (citedRule?.text ?? null) : null,
      domain: packet.domain,
    },
  });
  return created;
}

async function createGraduationProposal(
  deps: RulingDeps,
  packet: Packet,
  reason: string,
): Promise<Packet> {
  const { packet: created } = await deps.store.createPacket({
    sourceSessionId: packet.sourceSessionId,
    sourceSessionFile: packet.sourceSessionFile,
    project: packet.project,
    domain: "hq-doctrine",
    title: `graduation earned in ${packet.domain}`,
    question:
      `HQ has matched your rulings in "${packet.domain}" (${reason}). Do you want to grant it that domain?`,
    options: [
      {
        id: "acknowledge",
        label: `Noted — I will run /hq_graduate ${packet.domain} when I want it`,
        price: "nothing changes until you run the command",
      },
      {
        id: "reject",
        label: "Stop proposing this domain for now",
        price: "HQ stops raising it; the streak keeps building and you can still run the command",
      },
    ],
    recommendationId: "acknowledge",
    flipCondition:
      "if the agreements came from easy cases rather than representative ones, keep deciding these yourself",
    blastRadius: "low",
    reversibility: "reversible",
    dependsOn: [],
    doctrineCitations: [],
    shadowRuling: null,
    annotations: [],
    trivial: true,
    proposal: {
      kind: "graduation",
      scope: "global",
      section: "Precedents",
      ruleText: reason,
      replaces: null,
      domain: packet.domain,
    },
  });
  return created;
}

/**
 * Records that the user had to open a session to decide. This is the telemetry on
 * HQ's central bet, so it is captured from a signal rather than a form.
 */
export async function recordDive(
  store: HqStore,
  input: { packetId: string; missing: string; ruling: string; at?: string },
): Promise<DefectRecord> {
  const record: DefectRecord = {
    version: 1,
    at: input.at ?? new Date().toISOString(),
    packetId: input.packetId,
    missing: input.missing,
    ruling: input.ruling,
  };
  await store.appendDefect(record);
  return record;
}
