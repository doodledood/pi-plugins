// cache.ts — pure session cache stats for the simple-statusline footer.
// Session cache rate + break detection only; the full diagnostics (per-turn
// report, break attribution, prefix fingerprinting) live in the
// cache-optimization extension's /cache command.
// No I/O and no Pi runtime types here — everything is unit-testable.

// Tunable thresholds. Adjust here if the break flag is too noisy or too quiet.
/** Hide the footer metric until the branch has at least this many prompt tokens. */
export const MIN_VISIBLE_PROMPT_TOKENS = 1024;
/** Only consider a break when the previous turn's prompt was at least this large. */
export const BREAK_MIN_PREV_PROMPT_TOKENS = 10_000;
/** Flag a break when the latest turn read less than this fraction of the previous prompt from cache. */
export const BREAK_READ_FRACTION = 0.5;

interface UsageLike {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface MessageLike {
  role?: string;
  model?: string;
  timestamp?: number;
  usage?: UsageLike;
}

/** Minimal shape of a session entry as returned by ctx.sessionManager.getBranch(). */
export interface SessionEntryLike {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: MessageLike;
  modelId?: string;
}

export interface TurnCacheStats {
  /** Position of this entry in the branch array. */
  branchIndex: number;
  /** 0-based assistant turn number. */
  turn: number;
  entryId?: string;
  /** Unix ms of the assistant message. */
  timestamp: number;
  input: number;
  read: number;
  write: number;
  /** input + read + write. */
  prompt: number;
  /** read / prompt (0 when prompt is 0). */
  rate: number;
  /** Total cost of this turn in dollars (0 when the model has no pricing). */
  cost: number;
}

export interface SessionCacheStats {
  turns: TurnCacheStats[];
  totalInput: number;
  totalRead: number;
  totalWrite: number;
  totalPrompt: number;
  /** Sum of per-turn costs in dollars (0 when the model has no pricing). */
  totalCost: number;
  /** totalRead / totalPrompt (0 when no prompt tokens). */
  sessionRate: number;
  /** Show the footer metric only when true. */
  visible: boolean;
  latest?: TurnCacheStats;
  /** True when the latest turn looks like a cache break. */
  latestBreak: boolean;
}

function messageTimestamp(entry: SessionEntryLike): number {
  const fromMessage = entry.message?.timestamp;
  if (typeof fromMessage === "number") return fromMessage;
  const fromEntry = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(fromEntry) ? fromEntry : 0;
}

/** Collect per-assistant-turn cache stats from a session branch. */
export function collectTurnStats(branch: readonly SessionEntryLike[]): TurnCacheStats[] {
  const turns: TurnCacheStats[] = [];
  branch.forEach((entry, branchIndex) => {
    if (entry.type !== "message" || entry.message?.role !== "assistant") return;
    const usage = entry.message.usage;
    if (!usage) return;
    const input = usage.input ?? 0;
    const read = usage.cacheRead ?? 0;
    const write = usage.cacheWrite ?? 0;
    const prompt = input + read + write;
    // Aborted/errored turns persist zero-initialized usage; they carry no cache
    // signal and would otherwise trigger false break flags (0 reads vs a large
    // previous prefix) and poison the next turn's break baseline.
    if (prompt === 0) return;
    turns.push({
      branchIndex,
      turn: turns.length,
      entryId: entry.id,
      timestamp: messageTimestamp(entry),
      input,
      read,
      write,
      prompt,
      rate: prompt > 0 ? read / prompt : 0,
      cost: usage.cost?.total ?? 0,
    });
  });
  return turns;
}

/**
 * Cache-break heuristic: the previous turn established a prefix of
 * `prev.prompt` tokens; if the current turn read back less than
 * BREAK_READ_FRACTION of it, the prefix was invalidated.
 * The first assistant turn is never a break (nothing was cached yet).
 */
export function isCacheBreak(prev: TurnCacheStats | undefined, current: TurnCacheStats): boolean {
  if (!prev) return false;
  if (prev.prompt < BREAK_MIN_PREV_PROMPT_TOKENS) return false;
  return current.read < prev.prompt * BREAK_READ_FRACTION;
}

/** Aggregate branch cache stats for the footer. */
export function computeSessionCacheStats(branch: readonly SessionEntryLike[]): SessionCacheStats {
  const turns = collectTurnStats(branch);
  let totalInput = 0;
  let totalRead = 0;
  let totalWrite = 0;
  let totalCost = 0;
  for (const turn of turns) {
    totalInput += turn.input;
    totalRead += turn.read;
    totalWrite += turn.write;
    totalCost += turn.cost;
  }
  const totalPrompt = totalInput + totalRead + totalWrite;
  const latest = turns[turns.length - 1];
  const prev = turns[turns.length - 2];
  return {
    turns,
    totalInput,
    totalRead,
    totalWrite,
    totalCost,
    totalPrompt,
    sessionRate: totalPrompt > 0 ? totalRead / totalPrompt : 0,
    // Data-driven visibility: enough traffic AND the provider actually reports cache fields.
    visible: totalPrompt >= MIN_VISIBLE_PROMPT_TOKENS && totalRead + totalWrite > 0,
    latest,
    latestBreak: latest ? isCacheBreak(prev, latest) : false,
  };
}

/** Compact token count for footer display. */
export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

/** Whole-number percentage for footer display. */
export function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Dollar cost for footer display. */
export function formatCost(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 3)}`;
}
