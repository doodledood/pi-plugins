/**
 * Drills: answering a question about a session so the user does not have to open
 * it.
 *
 * Two tiers, and the order matters. Tier 1 reads — the packet, the session state,
 * the transcript — because most questions are answered by reading and reading is
 * cheap. Tier 2 resumes a *copy* of the source session and asks it directly, which
 * is the only way to reach reasoning that never made it into the output. The copy
 * is a real pi fork, so the original is never touched.
 *
 * Answers come back with verbatim quotes attached. That is the valve against the
 * failure that killed the previous generation of this system: a distilled answer
 * the user could not check without going to look anyway.
 */

import { appendJsonl, readJsonl } from "./io.ts";
import { hqPaths } from "./paths.ts";
import { DRILL_FORK_PROMPT, DRILL_PROMPT } from "./prompts.ts";
import type { Spawner } from "./spawn.ts";
import type { HqStore } from "./store.ts";
import { readTranscriptTail, renderTranscript, type TranscriptMessage } from "./transcript.ts";
import {
  DRILL_LOG_VERSION,
  type DrillLogEntry,
  parseDrillLogEntry,
  type Packet,
  type PacketAnnotation,
} from "./types.ts";

export const DRILL_QUESTION_ENV = "HQ_DRILL_QUESTION";
export const DRILL_TIER_ENV = "HQ_DRILL_TIER";

export interface DrillDeps {
  store: HqStore;
  spawner: Spawner;
  now?: () => Date;
}

async function logDrill(
  deps: DrillDeps,
  entry: Omit<DrillLogEntry, "version">,
): Promise<void> {
  await appendJsonl(hqPaths(deps.store.root).drillsLog, {
    version: DRILL_LOG_VERSION,
    ...entry,
  });
}

export async function readDrillLog(store: HqStore): Promise<DrillLogEntry[]> {
  return readJsonl(hqPaths(store.root).drillsLog, parseDrillLogEntry);
}

/**
 * Starts a tier-1 drill and marks the origin session as drilling, so the glance
 * shows the work against the session it is about rather than the drill worker.
 */
export async function startDrill(
  deps: DrillDeps,
  packet: Packet,
  question: string,
): Promise<{ spawnedSessionId: string | null }> {
  const now = deps.now ?? (() => new Date());
  await markOriginDrilling(deps, packet, packet.id);
  // A packet under a drill is not presentable, whichever path started the drill:
  // a deferral from the seat, or triage completing a held packet.
  if (packet.status === "pending") {
    await deps.store.updatePacket(packet.id, (current) =>
      current.status === "pending" ? { ...current, status: "drilling" } : current
    );
  }

  const spawned = await deps.spawner({
    kind: "drill",
    prompt: `${DRILL_PROMPT}

## This drill

Packet: ${packet.id}
Question: ${question}

Call the drill context tool for that packet id, then answer.`,
    cwd: packet.project,
    originSessionId: packet.sourceSessionId,
    packetId: packet.id,
    env: { [DRILL_QUESTION_ENV]: question, [DRILL_TIER_ENV]: "1" },
  });

  await logDrill(deps, {
    at: now().toISOString(),
    packetId: packet.id,
    question,
    tier: 1,
    action: "read",
    runId: spawned.runId,
  });

  return { spawnedSessionId: spawned.runId };
}

async function markOriginDrilling(
  deps: DrillDeps,
  packet: Packet,
  packetId: string | null,
): Promise<void> {
  const state = await deps.store.readSessionState(packet.sourceSessionId);
  if (!state) return;
  if (packetId) {
    await deps.store.patchSessionState(packet.sourceSessionId, {
      drillingPacketId: packetId,
      state: "drilling",
      // Remember what the row said, so clearing the marker can put it back
      // rather than leaving a finished session reading as forever-drilling.
      preDrillState: state.state,
    });
    return;
  }
  await deps.store.patchSessionState(packet.sourceSessionId, {
    drillingPacketId: null,
    state: state.preDrillState ?? (state.state === "drilling" ? "done" : state.state),
    preDrillState: null,
  });
}

export interface DrillContext {
  packet: Packet;
  question: string;
  tier: 1 | 2;
  transcript: TranscriptMessage[];
  rendered: string;
}

export async function drillContext(
  deps: DrillDeps,
  packetId: string,
  question: string,
  tier: 1 | 2,
): Promise<DrillContext | { error: string }> {
  const packet = await deps.store.readPacket(packetId);
  if (!packet) return { error: `no such packet: ${packetId}` };
  const transcript = tier === 1
    ? await readTranscriptTail(packet.sourceSessionFile, { maxMessages: 40 })
    : [];
  return {
    packet,
    question,
    tier,
    transcript,
    rendered: renderTranscript(transcript),
  };
}

export interface DrillSubmission {
  packetId: string;
  question: string;
  tier: 1 | 2;
  answer: string;
  quotes: Array<{ text: string; attribution: string }>;
  /** Tier 1 only: reading could not answer it; escalate to the copy. */
  insufficient?: boolean;
  /**
   * Fields the drill learned well enough to fill in. Used by completion drills:
   * a held packet becomes presentable when its gaps are filled, and the bar is
   * re-checked on write either way.
   */
  patch?: PacketPatch;
}

/** The only packet fields a drill may rewrite — never the status or the ruling. */
export type PacketPatch = Partial<
  Pick<
    Packet,
    | "question"
    | "options"
    | "recommendationId"
    | "flipCondition"
    | "blastRadius"
    | "reversibility"
    | "title"
    | "domain"
    | "trivial"
    | "shadowRuling"
  >
>;

export type DrillOutcome =
  | { kind: "escalated"; runId: string | null }
  | { kind: "annotated"; packet: Packet }
  | { kind: "unanswered"; packet: Packet }
  | { error: string };

/**
 * Applies a drill's result. Tier 1 may escalate once; anything else annotates the
 * packet and returns it to the queue, which is what the seat will pick up next
 * cycle.
 */
export async function submitDrillResult(
  deps: DrillDeps,
  submission: DrillSubmission,
): Promise<DrillOutcome> {
  const now = deps.now ?? (() => new Date());
  const at = now().toISOString();
  const packet = await deps.store.readPacket(submission.packetId);
  if (!packet) return { error: `no such packet: ${submission.packetId}` };

  if (submission.insufficient && submission.tier === 1) {
    if (!packet.sourceSessionFile) {
      // No file means no fork is possible; return the honest gap instead.
      return finishWithAnnotation(deps, packet, {
        at,
        question: submission.question,
        answer: `${submission.answer}\n\n(Reading could not answer this, and the source session was ephemeral, so it could not be asked directly.)`,
        quotes: submission.quotes,
        tier: 1,
      }, "unanswered");
    }
    const spawned = await deps.spawner({
      kind: "drill",
      prompt: DRILL_FORK_PROMPT(submission.question, packet.id),
      cwd: packet.project,
      forkSessionFile: packet.sourceSessionFile,
      originSessionId: packet.sourceSessionId,
      packetId: packet.id,
      env: { [DRILL_QUESTION_ENV]: submission.question, [DRILL_TIER_ENV]: "2" },
    });
    await logDrill(deps, {
      at,
      packetId: packet.id,
      question: submission.question,
      tier: 2,
      action: "fork",
      runId: spawned.runId,
    });
    return { kind: "escalated", runId: spawned.runId };
  }

  return finishWithAnnotation(deps, packet, {
    at,
    question: submission.question,
    answer: submission.answer,
    quotes: submission.quotes,
    tier: submission.tier,
  }, submission.answer.trim() ? "annotated" : "unanswered", submission.patch);
}

async function finishWithAnnotation(
  deps: DrillDeps,
  packet: Packet,
  annotation: PacketAnnotation,
  kind: "annotated" | "unanswered",
  patch?: PacketPatch,
): Promise<DrillOutcome> {
  const updated = await deps.store.updatePacket(packet.id, (current) => ({
    ...current,
    ...(patch ?? {}),
    // A drilling packet returns to the queue; a held one is promoted only if the
    // patch actually cleared the bar, which the store re-checks on write.
    status: current.status === "drilling" ? "pending" : current.status,
    annotations: [...current.annotations, annotation],
  }));
  await markOriginDrilling(deps, packet, null);
  await logDrill(deps, {
    at: annotation.at,
    packetId: packet.id,
    question: annotation.question,
    tier: annotation.tier,
    action: kind === "annotated" ? "answered" : "gave-up",
    runId: null,
  });
  const result = updated ?? packet;
  return kind === "annotated"
    ? { kind: "annotated", packet: result }
    : { kind: "unanswered", packet: result };
}

/**
 * Starts a drill aimed at completing a held packet. A packet that misses the bar
 * is a question for the machinery, not for the user.
 */
export async function startCompletionDrill(
  deps: DrillDeps,
  packet: Packet,
  violations: readonly { field: string; reason: string }[],
): Promise<{ spawnedSessionId: string | null }> {
  const missing = violations.map((violation) => `${violation.field} (${violation.reason})`).join("; ");
  return startDrill(
    deps,
    packet,
    `This packet cannot be shown to the user yet because it misses the bar: ${missing}. Read the source session and supply what is missing, quoting the evidence.`,
  );
}
