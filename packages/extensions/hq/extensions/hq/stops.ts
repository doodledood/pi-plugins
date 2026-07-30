/**
 * Stop records: the durable handoff between "a managed session settled" and
 * "triage decided what that means".
 *
 * A stop is written to disk before triage is asked to look at it, and it is not
 * marked done until triage produced an outcome. That makes the two failure modes
 * survivable: a duplicate stop signal cannot start a second triage (the claim is
 * an exclusive-create, so only one winner exists), and a triage that crashed
 * mid-run leaves a claimed-but-unfinished record whose claimant is dead, which
 * the next sweep re-runs (AC-1.3).
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteJson,
  isPidAlive,
  materializeIfAbsent,
  pathExists,
  readJsonFile,
  scanJsonDir,
  silentReporter,
  type ErrorReporter,
} from "./io.ts";
import { assertSafeId, hqPaths } from "./paths.ts";
import {
  KINDS,
  oneOf,
  STOP_OUTCOMES,
  STOP_STATES,
  type SessionKind,
  type StopOutcome,
  type StopState,
} from "./types.ts";

export type StopStatus = "open" | "claimed" | "done";

export interface StopRecord {
  version: 1;
  stopId: string;
  sessionId: string;
  sessionFile: string | null;
  project: string;
  kind: SessionKind;
  stopState: StopState;
  preview: string;
  createdAt: string;
  status: StopStatus;
  claimedByPid: number | null;
  claimedAt: string | null;
  /**
   * Set when the user handed a live session over with /hq_send_off. HQ takes such a
   * session over by forking it, never by resuming it: the tab may still be open, and
   * two pi processes appending to one session file would corrupt both readings of it.
   */
  handedOff?: boolean;
  /** What the user said to do next when handing over, if they said anything. */
  mandate?: string | null;
  /** Set when triage produced an outcome. */
  outcome: StopOutcome | null;
  packetId: string | null;
}

export function parseStopRecord(value: unknown): StopRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return undefined;
  const stopId = typeof raw.stopId === "string" ? raw.stopId : undefined;
  const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : undefined;
  const project = typeof raw.project === "string" ? raw.project : undefined;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : undefined;
  const status = raw.status;
  if (
    !stopId || !sessionId || !project || !createdAt ||
    (status !== "open" && status !== "claimed" && status !== "done")
  ) {
    return undefined;
  }
  return {
    version: 1,
    stopId,
    sessionId,
    sessionFile: typeof raw.sessionFile === "string" ? raw.sessionFile : null,
    project,
    kind: oneOf(raw.kind, KINDS) ?? "worker",
    stopState: oneOf(raw.stopState, STOP_STATES) ?? "idle-done",
    preview: typeof raw.preview === "string" ? raw.preview : "",
    createdAt,
    status,
    claimedByPid: typeof raw.claimedByPid === "number" ? raw.claimedByPid : null,
    claimedAt: typeof raw.claimedAt === "string" ? raw.claimedAt : null,
    handedOff: raw.handedOff === true,
    mandate: typeof raw.mandate === "string" && raw.mandate.trim() ? raw.mandate : null,
    outcome: oneOf(raw.outcome, STOP_OUTCOMES) ?? null,
    packetId: typeof raw.packetId === "string" ? raw.packetId : null,
  };
}

export function stopRecordPath(root: string, stopId: string): string {
  return join(hqPaths(root).stops, `${assertSafeId(stopId, "stop id")}.json`);
}

function claimPath(root: string, stopId: string): string {
  return join(hqPaths(root).stops, `${assertSafeId(stopId, "stop id")}.claim`);
}

/**
 * A stop's identity is the session plus the branch leaf it settled on, so the
 * same settle observed twice yields one stop, while a genuinely later stop in
 * the same session yields another.
 */
export function stopIdFor(sessionId: string, leafId: string | null, sequence: number): string {
  const suffix = leafId ? leafId.replace(/[^A-Za-z0-9._-]/g, "") : `n${sequence}`;
  return `${sessionId}--${suffix || `n${sequence}`}`;
}

export async function writeStopRecord(root: string, record: StopRecord): Promise<void> {
  await atomicWriteJson(stopRecordPath(root, record.stopId), record);
}

/**
 * Writes the record only if this stop has not been seen before. A duplicate stop
 * signal must not reset a record that triage is already working on — that would
 * make the sweep treat live work as abandoned.
 */
export async function ensureStopRecord(
  root: string,
  record: StopRecord,
): Promise<{ record: StopRecord; created: boolean }> {
  const existing = await readStopRecord(root, record.stopId);
  if (existing) return { record: existing, created: false };
  await writeStopRecord(root, record);
  return { record, created: true };
}

export async function readStopRecord(
  root: string,
  stopId: string,
  onError: ErrorReporter = silentReporter,
): Promise<StopRecord | undefined> {
  return readJsonFile(stopRecordPath(root, stopId), parseStopRecord, onError);
}

/**
 * Exclusive-create claim. Exactly one caller can win a given stop, across
 * processes, without a lock file protocol or a check-then-act window.
 */
export async function claimStop(
  root: string,
  stopId: string,
  pid: number,
  at: string,
): Promise<boolean> {
  const won = await materializeIfAbsent(
    claimPath(root, stopId),
    `${JSON.stringify({ pid, at })}\n`,
  );
  if (!won) return false;
  const record = await readStopRecord(root, stopId);
  if (!record) {
    // The claim exists but no record could be read, so nothing owes an outcome
    // under this claim: release it rather than leaving a stop nobody can sweep.
    await releaseClaim(root, stopId);
    return false;
  }
  await writeStopRecord(root, { ...record, status: "claimed", claimedByPid: pid, claimedAt: at });
  return true;
}

/** The pid recorded in the claim file, when the record itself lost it. */
async function readClaimPid(root: string, stopId: string): Promise<number | undefined> {
  try {
    const { readFile } = await import("node:fs/promises");
    const parsed: unknown = JSON.parse(await readFile(claimPath(root, stopId), "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const pid = (parsed as { pid?: unknown }).pid;
      if (typeof pid === "number" && Number.isSafeInteger(pid)) return pid;
    }
  } catch {
    // No readable claim file means no claimant to trust.
  }
  return undefined;
}

export async function releaseClaim(root: string, stopId: string): Promise<void> {
  await rm(claimPath(root, stopId), { force: true });
}

export async function finishStop(
  root: string,
  stopId: string,
  outcome: StopOutcome,
  packetId: string | null,
): Promise<void> {
  const record = await readStopRecord(root, stopId);
  if (!record) return;
  await writeStopRecord(root, { ...record, status: "done", outcome, packetId });
}

export interface StaleStop {
  record: StopRecord;
  reason: "unclaimed" | "claimant-dead";
}

/**
 * How long a claim is trusted before its claimant's liveness decides.
 *
 * A stop is claimed by the session that observed it, but the process that owes
 * the outcome is the triage worker it spawns — and the observing session exits
 * within seconds. Without a grace window every in-flight triage would read as
 * abandoned and be duplicated.
 */
export const CLAIM_GRACE_MS = 10 * 60_000;

/**
 * Stops that still owe an outcome: never claimed, or claimed by a process that is
 * gone and past the grace window. The window matters because the claimant hands
 * off — the observing session claims, the triage worker it spawns takes over —
 * so a dead claimant inside the window means "handing over", not "abandoned".
 */
/** Stops of one session that triage has not finished. */
export async function openStopsForSession(
  root: string,
  sessionId: string,
  onError: ErrorReporter = silentReporter,
): Promise<StopRecord[]> {
  const scan = await scanJsonDir(hqPaths(root).stops, parseStopRecord, (r) => r.stopId, onError);
  return scan.records
    .map(({ record }) => record)
    .filter((record) => record.sessionId === sessionId && record.status !== "done");
}

export async function findStopsNeedingTriage(
  root: string,
  onError: ErrorReporter = silentReporter,
  alive: (pid: number) => boolean = isPidAlive,
  now: Date = new Date(),
): Promise<StaleStop[]> {
  const scan = await scanJsonDir(
    hqPaths(root).stops,
    parseStopRecord,
    (record) => record.stopId,
    onError,
  );
  const stale: StaleStop[] = [];
  for (const { record } of scan.records) {
    if (record.status === "done") continue;
    const claimed = await pathExists(claimPath(root, record.stopId));
    if (!claimed) {
      stale.push({ record, reason: "unclaimed" });
      continue;
    }
    // A claimed record with no claimant is a claim that died between its two
    // steps; past the grace window it is abandoned work like any other, and the
    // pid on the claim file is the last word on who held it.
    const claimant = record.claimedByPid ?? (await readClaimPid(root, record.stopId));
    const claimedAt = Date.parse(record.claimedAt ?? record.createdAt);
    if (claimant === undefined || !alive(claimant)) {
      if (now.getTime() - claimedAt < CLAIM_GRACE_MS) continue;
      stale.push({ record, reason: "claimant-dead" });
    }
  }
  return stale;
}

/** Moves the claim to the process that will actually produce the outcome. */
export async function takeOverClaim(
  root: string,
  stopId: string,
  pid: number,
  at: string,
): Promise<void> {
  const record = await readStopRecord(root, stopId);
  if (!record || record.status === "done") return;
  await writeStopRecord(root, { ...record, status: "claimed", claimedByPid: pid, claimedAt: at });
}

export async function reopenStop(root: string, stopId: string): Promise<void> {
  await releaseClaim(root, stopId);
  const record = await readStopRecord(root, stopId);
  if (!record) return;
  await writeStopRecord(root, {
    ...record,
    status: "open",
    claimedByPid: null,
    claimedAt: null,
  });
}
