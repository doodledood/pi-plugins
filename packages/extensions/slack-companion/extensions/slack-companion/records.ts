// What a helper or a triage call cost, written where session-tree cost accounting finds it.
// Holds docs/adr/20261104-run-slack-helpers-in-memory.md: a helper's file holds only its own
// entries, linked to the parent session, never a copy of main.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
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
 * Remove the helper records of sessions that no longer exist: Pi deletes a session's file but not
 * the folder beside it. Only this package's own subfolder is removed, and its parent folder only
 * when nothing else is left in it. Returns how many record folders went.
 */
export function pruneOrphanRecords(sessionFile: string | undefined): number {
  if (!sessionFile) return 0;
  const sessionsDir = dirname(sessionFile);
  let removed = 0;
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const records = join(sessionsDir, entry.name, HELPER_SESSION_KIND);
    if (!existsSync(records) || existsSync(join(sessionsDir, `${entry.name}.jsonl`))) continue;
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
