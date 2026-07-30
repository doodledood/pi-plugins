/**
 * Whether anyone is at the desk, and what to do about work that arrived while nobody
 * was.
 *
 * HQ's own thinking — triaging a stop, naming a session — costs model calls, and those
 * were being made whether or not the user had the seat open. A stop is cheap to record
 * and can be triaged later, so nothing is lost by waiting: the seat sweeps unfinished
 * stops when it opens. What the user gets back is a system that goes quiet when they
 * are not using it.
 *
 * The seat lives in one process and the sessions that stop live in others, so presence
 * is a file with a heartbeat rather than a variable.
 */

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { atomicWriteJson, isPidAlive } from "./io.ts";
import { hqPaths } from "./paths.ts";

/** A heartbeat older than this means the seat is gone, however it ended. */
export const SEAT_HEARTBEAT_STALE_MS = 90_000;

export interface SeatPresence {
  pid: number;
  at: string;
}

export function seatPath(root: string): string {
  return hqPaths(root).seat;
}

export async function markSeatLive(root: string, pid: number, at: Date): Promise<void> {
  await atomicWriteJson(seatPath(root), { version: 1, pid, at: at.toISOString() });
}

export async function markSeatGone(root: string): Promise<void> {
  await rm(seatPath(root), { force: true });
}

/**
 * Read synchronously: this is called on the settle path of every managed session, where
 * an await would put HQ's bookkeeping between a session finishing and its own shutdown.
 */
export function readSeat(root: string): SeatPresence | undefined {
  try {
    const raw = JSON.parse(readFileSync(seatPath(root), "utf8")) as Record<string, unknown>;
    const pid = typeof raw.pid === "number" ? raw.pid : undefined;
    const at = typeof raw.at === "string" ? raw.at : undefined;
    return pid !== undefined && at !== undefined ? { pid, at } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Both tests have to pass: a stale heartbeat catches a seat whose process is still
 * alive but has handed the seat back, and a dead pid catches one that was killed
 * without ever writing that it was leaving.
 */
export function isSeatLive(
  root: string,
  now: Date = new Date(),
  alive: (pid: number) => boolean = isPidAlive,
): boolean {
  const seat = readSeat(root);
  if (!seat) return false;
  const age = now.getTime() - new Date(seat.at).getTime();
  if (!Number.isFinite(age) || age > SEAT_HEARTBEAT_STALE_MS) return false;
  return alive(seat.pid);
}

/** Anything older than this is not a live decision any more. */
export function staleBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
