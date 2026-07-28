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
import type { SessionKind, StopState } from "./types.ts";

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
  /** Set when triage produced an outcome. */
  outcome: string | null;
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
    kind: (raw.kind as SessionKind) ?? "worker",
    stopState: (raw.stopState as StopState) ?? "idle-done",
    preview: typeof raw.preview === "string" ? raw.preview : "",
    createdAt,
    status,
    claimedByPid: typeof raw.claimedByPid === "number" ? raw.claimedByPid : null,
    claimedAt: typeof raw.claimedAt === "string" ? raw.claimedAt : null,
    outcome: typeof raw.outcome === "string" ? raw.outcome : null,
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
  if (record) {
    await writeStopRecord(root, { ...record, status: "claimed", claimedByPid: pid, claimedAt: at });
  }
  return true;
}

export async function releaseClaim(root: string, stopId: string): Promise<void> {
  await rm(claimPath(root, stopId), { force: true });
}

export async function finishStop(
  root: string,
  stopId: string,
  outcome: string,
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
 * Stops that still owe an outcome: never claimed, or claimed by a process that
 * is gone. This is the backstop that makes a missed hook or a crashed triage
 * recoverable rather than lost.
 */
export async function findStopsNeedingTriage(
  root: string,
  onError: ErrorReporter = silentReporter,
  alive: (pid: number) => boolean = isPidAlive,
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
    if (record.claimedByPid !== null && !alive(record.claimedByPid)) {
      stale.push({ record, reason: "claimant-dead" });
    }
  }
  return stale;
}

/** Clears a dead claim so the stop can be retried. */
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
