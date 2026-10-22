// Per-project MCP tool-usage stats with recency decay, plus attribution that unwraps
// proxy (`mcp`) and wake (`load_tools`) calls to the underlying tool names.
//
// Storage is an append-only JSON Lines log, so concurrent Pi sessions (second terminals,
// subagent sessions) never overwrite each other's events, and a torn or unparseable line
// costs only that line: nothing ever rewrites the log from a stale snapshot. The log is
// compacted by renaming it aside before rewriting, so a concurrent append lands either in
// the claimed file (and is carried over) or in the fresh log.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { legacyStatsPath, usageLogPath } from "./paths.ts";

export interface UsageEvent {
  name: string;
  ts: number;
}

/** One log line: project, tool name, timestamp. */
interface UsageLine {
  p: string;
  n: string;
  t: number;
}

const MAX_EVENTS_PER_PROJECT = 5_000;
const DAY_MS = 86_400_000;
/** A compaction claim older than this belongs to a session that died mid-compaction. */
const ABANDONED_CLAIM_MS = 60_000;

/**
 * Map an observed tool call to the MCP tool name(s) it represents:
 * - `mcp({ tool: "x" })` → ["x"]; other proxy modes (search/list/describe/status) → []
 * - `load_tools({ names: [...] })` → those names
 * - a direct call → [toolName] when it is an MCP tool, otherwise []
 * Built-in and other extensions' tools are never recorded, so they cannot use up the cap.
 */
export function attributeToolNames(toolName: string, args: unknown, isMcpToolName: (name: string) => boolean): string[] {
  if (toolName === "mcp") {
    const tool = (args as { tool?: unknown } | null | undefined)?.tool;
    return typeof tool === "string" && tool.length > 0 ? [tool] : [];
  }
  if (toolName === "load_tools") {
    const names = (args as { names?: unknown } | null | undefined)?.names;
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && n.length > 0) : [];
  }
  return toolName.length > 0 && isMcpToolName(toolName) ? [toolName] : [];
}

/** Recency-decayed usage counts: each event contributes exp(-ln2 * age / halfLife). */
export function recencyScores(
  events: readonly UsageEvent[],
  halfLifeDays: number,
  now: number = Date.now(),
): Map<string, number> {
  const lambda = Math.LN2 / (Math.max(halfLifeDays, 1e-9) * DAY_MS);
  const scores = new Map<string, number>();
  for (const e of events) {
    const age = Math.max(0, now - e.ts);
    const weight = Math.exp(-lambda * age);
    scores.set(e.name, (scores.get(e.name) ?? 0) + weight);
  }
  return scores;
}

function isUsageLine(value: unknown): value is UsageLine {
  const v = value as Partial<UsageLine> | null;
  return typeof v === "object" && v !== null && typeof v.p === "string" && typeof v.n === "string" && typeof v.t === "number";
}

function readLines(path: string): UsageLine[] {
  if (!existsSync(path)) return [];
  const out: UsageLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isUsageLine(parsed)) out.push(parsed);
    } catch {
      // A torn line from an interrupted write: only that line is lost.
    }
  }
  return out;
}

/**
 * Append lines with one write. The leading newline terminates any torn line an
 * interrupted writer left behind, so it cannot swallow these.
 */
function appendLines(path: string, lines: readonly UsageLine[]): void {
  if (lines.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `\n${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
}

/**
 * The newest MAX_EVENTS_PER_PROJECT events of each project, oldest first. Sorted by
 * timestamp, not log position: a compaction appends older events after any that other
 * sessions appended meanwhile.
 */
function keepNewest(lines: readonly UsageLine[]): Map<string, UsageEvent[]> {
  const projects = new Map<string, UsageEvent[]>();
  for (const line of lines) {
    const list = projects.get(line.p);
    if (list) list.push({ name: line.n, ts: line.t });
    else projects.set(line.p, [{ name: line.n, ts: line.t }]);
  }
  for (const [project, events] of projects) {
    events.sort((a, b) => a.ts - b.ts);
    if (events.length > MAX_EVENTS_PER_PROJECT) projects.set(project, events.slice(events.length - MAX_EVENTS_PER_PROJECT));
  }
  return projects;
}

function toLines(projects: ReadonlyMap<string, readonly UsageEvent[]>): UsageLine[] {
  const out: UsageLine[] = [];
  for (const [p, events] of projects) for (const e of events) out.push({ p, n: e.name, t: e.ts });
  return out;
}

/** Claim a file by renaming it; false when another session claimed it first. */
function claim(path: string, claimed: string): boolean {
  try {
    renameSync(path, claimed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fold the pre-log stats file into the log once. Renaming it claims it, so two sessions
 * starting together cannot both import it. An unreadable file (an older version caught
 * mid-write) is put back and retried at the next session start.
 */
function importLegacyStats(legacyPath: string, logPath: string): void {
  if (!existsSync(legacyPath) || existsSync(`${legacyPath}.imported`)) return;
  const claimed = `${legacyPath}.importing-${process.pid}`;
  if (!claim(legacyPath, claimed)) return;
  let parsed: { projects?: Record<string, unknown> };
  try {
    parsed = JSON.parse(readFileSync(claimed, "utf8")) as { projects?: Record<string, unknown> };
  } catch (error) {
    if (!existsSync(legacyPath)) renameSync(claimed, legacyPath);
    else unlinkSync(claimed);
    console.error("mcp-tool-loadout: old stats file unreadable, will retry its import next session", error);
    return;
  }
  const lines: UsageLine[] = [];
  for (const [p, events] of Object.entries(parsed?.projects ?? {})) {
    if (!Array.isArray(events)) continue;
    for (const e of events as Array<{ name?: unknown; ts?: unknown }>) {
      if (typeof e?.name === "string" && typeof e.ts === "number") lines.push({ p, n: e.name, t: e.ts });
    }
  }
  appendLines(logPath, lines);
  renameSync(claimed, `${legacyPath}.imported`);
}

/** Rewrite the log down to what is kept, without losing appends made meanwhile. */
function compact(logPath: string, now: number): void {
  const claimed = `${logPath}.compacting-${process.pid}-${now}`;
  if (!claim(logPath, claimed)) return;
  appendLines(logPath, toLines(keepNewest(readLines(claimed))));
  unlinkSync(claimed);
}

/** Carry over the claim of a session that died mid-compaction. */
function recoverAbandonedCompactions(logPath: string, now: number): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) return;
  const prefix = `${basename(logPath)}.compacting-`;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs < ABANDONED_CLAIM_MS) continue;
    } catch {
      continue;
    }
    const reclaimed = `${path}.recovering-${process.pid}`;
    if (!claim(path, reclaimed)) continue;
    appendLines(logPath, readLines(reclaimed));
    unlinkSync(reclaimed);
  }
}

export class UsageLog {
  private constructor(
    private readonly path: string,
    private readonly projects: ReadonlyMap<string, readonly UsageEvent[]>,
  ) {}

  /** Read the log, importing the pre-log stats file once and compacting when it has outgrown the cap. */
  static open(path: string = usageLogPath(), legacyPath: string = legacyStatsPath(), now: number = Date.now()): UsageLog {
    importLegacyStats(legacyPath, path);
    recoverAbandonedCompactions(path, now);
    const lines = readLines(path);
    const projects = keepNewest(lines);
    let kept = 0;
    for (const events of projects.values()) kept += events.length;
    if (lines.length - kept >= MAX_EVENTS_PER_PROJECT) compact(path, now);
    return new UsageLog(path, projects);
  }

  eventsFor(project: string): readonly UsageEvent[] {
    return this.projects.get(project) ?? [];
  }

  /** All usage events pooled across every project (the global usage signal). */
  allEvents(): UsageEvent[] {
    const out: UsageEvent[] = [];
    for (const events of this.projects.values()) out.push(...events);
    return out;
  }

  /** Append events straight to the log; the ranking read at open() is not changed mid-session. */
  record(project: string, names: readonly string[], now: number = Date.now()): void {
    appendLines(this.path, names.map((n) => ({ p: project, n, t: now })));
  }
}
