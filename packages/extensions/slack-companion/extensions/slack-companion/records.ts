// What a helper or a triage call cost, written where session-tree cost accounting finds it.
// Holds docs/adr/20261104-run-slack-helpers-in-memory.md: a helper's file holds only its own
// entries, linked to the parent session, never a copy of main.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@earendil-works/pi-coding-agent";

export const HELPER_SESSION_KIND = "slack-companion";
export const COST_RECORD_TYPE = "pi-cost-record";

export function helperRecordDir(parentSessionFile: string): string {
  return join(parentSessionFile.replace(/\.jsonl$/, ""), HELPER_SESSION_KIND);
}

/** Write a helper's own entries; returns the path, or undefined when the parent has no session file. */
export function writeHelperRecord(parentSessionFile: string | undefined, cwd: string, entries: readonly SessionEntry[]): string | undefined {
  if (!parentSessionFile || !entries.length) return undefined;
  const dir = helperRecordDir(parentSessionFile);
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd, parentSession: parentSessionFile };
  // The first entry's parent lives in main, not here; the record starts its own chain.
  const own = entries.map((entry, index) => (index === 0 ? { ...entry, parentId: null } : entry));
  const path = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  writeFileSync(path, `${[header, ...own].map((e) => JSON.stringify(e)).join("\n")}\n`, { mode: 0o600 });
  return path;
}

/**
 * How old a deleted session's records must be before they are removed. Pi writes a session's file
 * only once it holds a message, so a running session that has only used /slack has records and no
 * file; no running session goes this long without a message.
 */
export const ORPHAN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Is every file in `dir` a helper record of exactly `parentSessionFile`, the newest older than the age? */
function onlyOldRecordsOf(dir: string, parentSessionFile: string, now: number): boolean {
  const files = readdirSync(dir, { withFileTypes: true });
  if (!files.length) return true;
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".jsonl")) return false;
    const path = join(dir, file.name);
    if (now - statSync(path).mtimeMs < ORPHAN_AGE_MS) return false;
    const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
    let header: unknown;
    try {
      header = JSON.parse(first);
    } catch {
      return false;
    }
    if (!header || typeof header !== "object") return false;
    const { type, parentSession } = header as Record<string, unknown>;
    if (type !== "session" || parentSession !== parentSessionFile) return false;
  }
  return true;
}

/**
 * Remove the helper records of sessions that no longer exist: Pi deletes a session's file but not
 * the folder beside it. A folder goes only when it is not the current session's, its session file
 * is missing, every file in it is this package's record naming that very file as its parent, and
 * the newest is older than ORPHAN_AGE_MS. Its parent folder goes only when nothing else is left.
 * Returns how many record folders went.
 */
export function pruneOrphanRecords(sessionFile: string | undefined, now = Date.now()): number {
  if (!sessionFile) return 0;
  const sessionsDir = dirname(sessionFile);
  const current = helperRecordDir(sessionFile);
  let removed = 0;
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const parentFile = join(sessionsDir, `${entry.name}.jsonl`);
    const records = helperRecordDir(parentFile);
    if (records === current || !existsSync(records) || existsSync(parentFile)) continue;
    if (!onlyOldRecordsOf(records, parentFile, now)) continue;
    rmSync(records, { recursive: true, force: true });
    removed += 1;
    if (!readdirSync(join(sessionsDir, entry.name)).length) rmdirSync(join(sessionsDir, entry.name));
  }
  return removed;
}

/** Total cost of the assistant messages among `entries`. */
export function costOf(entries: readonly SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "assistant") total += entry.message.usage?.cost?.total ?? 0;
  }
  return total;
}

export interface CostRecordData {
  recordId: string;
  key: string;
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
}

export function triageCostRecord(provider: string, model: string, usage: CostRecordData["usage"]): CostRecordData {
  return { recordId: randomUUID(), key: `${provider}/${model}`, usage };
}
