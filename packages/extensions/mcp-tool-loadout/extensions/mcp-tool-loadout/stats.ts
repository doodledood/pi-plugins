// Per-project tool-usage stats with recency decay, plus attribution that unwraps
// proxy (`mcp`) and wake (`load_tools`) calls to the underlying tool names.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statsPath } from "./paths.ts";

export interface UsageEvent {
  name: string;
  ts: number;
}

interface StatsFile {
  version: 1;
  projects: Record<string, UsageEvent[]>;
}

const MAX_EVENTS_PER_PROJECT = 5_000;
const DAY_MS = 86_400_000;

/**
 * Map an observed tool call to the underlying tool name(s) it represents:
 * - `mcp({ tool: "x" })` → ["x"]; other proxy modes (search/list/describe/status) → []
 * - `load_tools({ names: [...] })` → those names
 * - anything else → [toolName]
 */
export function attributeToolNames(toolName: string, args: unknown): string[] {
  if (toolName === "mcp") {
    const tool = (args as { tool?: unknown } | null | undefined)?.tool;
    return typeof tool === "string" && tool.length > 0 ? [tool] : [];
  }
  if (toolName === "load_tools") {
    const names = (args as { names?: unknown } | null | undefined)?.names;
    return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && n.length > 0) : [];
  }
  return toolName.length > 0 ? [toolName] : [];
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

function emptyFile(): StatsFile {
  return { version: 1, projects: {} };
}

export class StatsStore {
  private constructor(
    private readonly file: StatsFile,
    private readonly path: string,
  ) {}

  static load(path: string = statsPath()): StatsStore {
    if (!existsSync(path)) return new StatsStore(emptyFile(), path);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StatsFile>;
      const projects =
        parsed && typeof parsed.projects === "object" && parsed.projects !== null
          ? (parsed.projects as Record<string, UsageEvent[]>)
          : {};
      // Defensive: keep only well-formed events.
      const clean: Record<string, UsageEvent[]> = {};
      for (const [proj, events] of Object.entries(projects)) {
        if (!Array.isArray(events)) continue;
        clean[proj] = events.filter(
          (e): e is UsageEvent =>
            typeof e === "object" && e !== null && typeof e.name === "string" && typeof e.ts === "number",
        );
      }
      return new StatsStore({ version: 1, projects: clean }, path);
    } catch {
      return new StatsStore(emptyFile(), path);
    }
  }

  eventsFor(project: string): UsageEvent[] {
    return this.file.projects[project] ?? [];
  }

  /** All usage events pooled across every project (the global usage signal). */
  allEvents(): UsageEvent[] {
    const out: UsageEvent[] = [];
    for (const events of Object.values(this.file.projects)) out.push(...events);
    return out;
  }

  record(project: string, names: readonly string[], now: number = Date.now()): void {
    if (names.length === 0) return;
    const list = (this.file.projects[project] ??= []);
    for (const name of names) list.push({ name, ts: now });
    if (list.length > MAX_EVENTS_PER_PROJECT) {
      this.file.projects[project] = list.slice(list.length - MAX_EVENTS_PER_PROJECT);
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.file), "utf8");
  }
}
