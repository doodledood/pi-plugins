// cache.ts — pure cache-efficiency analysis for simple-statusline.
// Session cache rate, break detection, break attribution (session-entry
// correlation + prefix-fingerprint diff), and the /cache report content.
// No I/O and no Pi runtime types here — everything is unit-testable.

import { createHash } from "node:crypto";

// Tunable thresholds. Adjust here if the break flag is too noisy or too quiet.
/** Hide the footer metric until the branch has at least this many prompt tokens. */
export const MIN_VISIBLE_PROMPT_TOKENS = 1024;
/** Only consider a break when the previous turn's prompt was at least this large. */
export const BREAK_MIN_PREV_PROMPT_TOKENS = 10_000;
/** Flag a break when the latest turn read less than this fraction of the previous prompt from cache. */
export const BREAK_READ_FRACTION = 0.5;
/** Idle gap treated as probable cache TTL expiry (default short retention). */
export const TTL_SHORT_MS = 5 * 60_000;
/** Idle gap treated as probable TTL expiry when PI_CACHE_RETENTION=long. */
export const TTL_LONG_MS = 60 * 60_000;

interface UsageLike {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
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
  /** Position of this entry in the branch array (for slicing entries between turns). */
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
}

export interface SessionCacheStats {
  turns: TurnCacheStats[];
  totalInput: number;
  totalRead: number;
  totalWrite: number;
  totalPrompt: number;
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
  for (const turn of turns) {
    totalInput += turn.input;
    totalRead += turn.read;
    totalWrite += turn.write;
  }
  const totalPrompt = totalInput + totalRead + totalWrite;
  const latest = turns[turns.length - 1];
  const prev = turns[turns.length - 2];
  return {
    turns,
    totalInput,
    totalRead,
    totalWrite,
    totalPrompt,
    sessionRate: totalPrompt > 0 ? totalRead / totalPrompt : 0,
    // Data-driven visibility: enough traffic AND the provider actually reports cache fields.
    visible: totalPrompt >= MIN_VISIBLE_PROMPT_TOKENS && totalRead + totalWrite > 0,
    latest,
    latestBreak: latest ? isCacheBreak(prev, latest) : false,
  };
}

// ---------------------------------------------------------------------------
// Prefix fingerprinting (hashes only — no payload content is ever retained)
// ---------------------------------------------------------------------------

export interface FingerprintSnapshot {
  systemHash?: string;
  toolsHash?: string;
  messageHashes: string[];
  /** False when the payload shape wasn't recognized, so nothing meaningful was hashed. */
  recognized: boolean;
}

export type FingerprintDivergence =
  | { kind: "system_prompt" }
  | { kind: "tools" }
  | { kind: "message"; index: number }
  | { kind: "history_shrunk"; from: number; to: number }
  | { kind: "no_baseline" }
  | { kind: "unrecognized_payload" }
  | { kind: "none" };

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex").slice(0, 16);
}

/**
 * Strip volatile per-request cache markers and normalize interchangeable
 * content shapes before hashing, so fingerprints only change when real
 * content changes. Anthropic moves `cache_control` onto the last user
 * message/tool of every request, and Bedrock appends `cachePoint` content
 * blocks — without canonicalization every consecutive request pair would
 * spuriously diff at the marker's host message.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !isCacheMarkerBlock(item)).map((item) => canonicalize(item));
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (key === "cache_control") continue;
      result[key] = canonicalize(entry);
    }
    // Providers use `content: "text"` and `content: [{ type: "text", text }]` interchangeably.
    if (typeof result.role === "string" && typeof result.content === "string") {
      result.content = [{ type: "text", text: result.content }];
    }
    return result;
  }
  return value;
}

/** Bedrock cache markers are standalone `{ cachePoint: ... }` content blocks. */
function isCacheMarkerBlock(item: unknown): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const keys = Object.keys(item);
  return keys.length === 1 && keys[0] === "cachePoint";
}

/**
 * Best-effort provider-agnostic fingerprint of an LLM request payload.
 * Anthropic: { system, tools, messages }; OpenAI Completions: { messages, tools };
 * OpenAI Responses: { input, tools } (the system prompt travels as the first
 * input message; `instructions` is also handled when present);
 * Google/Vertex: { contents, config: { systemInstruction, tools } }.
 * Payloads are canonicalized first (volatile cache markers stripped) and
 * unrecognized shapes are marked so they never diff as "identical".
 */
export function snapshotPayload(payload: unknown): FingerprintSnapshot {
  const p = (payload ?? {}) as Record<string, unknown>;
  const config = (p.config ?? {}) as Record<string, unknown>;
  const system = p.system ?? p.instructions ?? config.systemInstruction;
  // `toolConfig` is Bedrock's tool container (bedrock-converse-stream payloads).
  const tools = p.tools ?? config.tools ?? p.toolConfig;
  const messages = Array.isArray(p.messages)
    ? p.messages
    : Array.isArray(p.input)
      ? p.input
      : Array.isArray(p.contents)
        ? p.contents
        : undefined;
  return {
    systemHash: system === undefined ? undefined : sha(canonicalize(system)),
    toolsHash: tools === undefined ? undefined : sha(canonicalize(tools)),
    messageHashes: (messages ?? []).map((message) => sha(canonicalize(message))),
    recognized: system !== undefined || tools !== undefined || messages !== undefined,
  };
}

/**
 * Locate the first divergence between two consecutive request fingerprints.
 * In a cache-friendly session the previous request is a strict prefix of the
 * current one; anything else names what invalidated the prefix.
 */
export function diffSnapshots(prev: FingerprintSnapshot, current: FingerprintSnapshot): FingerprintDivergence {
  // "none"/"identical" must only be reachable when something was actually hashed.
  if (!prev.recognized || !current.recognized) return { kind: "unrecognized_payload" };
  if (prev.systemHash !== current.systemHash) return { kind: "system_prompt" };
  if (prev.toolsHash !== current.toolsHash) return { kind: "tools" };
  if (current.messageHashes.length < prev.messageHashes.length) {
    return { kind: "history_shrunk", from: prev.messageHashes.length, to: current.messageHashes.length };
  }
  for (let i = 0; i < prev.messageHashes.length; i++) {
    if (prev.messageHashes[i] !== current.messageHashes[i]) return { kind: "message", index: i };
  }
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Break attribution (layer 1: session-entry correlation; layer 2: fingerprints)
// ---------------------------------------------------------------------------

export type CacheBreakCause =
  | { kind: "compaction" }
  | { kind: "model_change"; modelId?: string }
  | { kind: "branch_nav" }
  | { kind: "ttl_expiry"; gapMs: number }
  | { kind: "prefix_change"; divergence?: FingerprintDivergence };

export interface AttributeBreakArgs {
  /** Branch entries strictly after the previous assistant entry, up to the breaking one. */
  entriesBetween: readonly SessionEntryLike[];
  prev: TurnCacheStats | undefined;
  current: TurnCacheStats;
  /** True when PI_CACHE_RETENTION=long. */
  longRetention?: boolean;
  /** Fingerprint divergence for this turn, when observed in-process. */
  divergence?: FingerprintDivergence;
}

/** Attribute a cache break to its probable cause(s). */
export function attributeBreak(args: AttributeBreakArgs): CacheBreakCause[] {
  const causes: CacheBreakCause[] = [];
  for (const entry of args.entriesBetween) {
    if (entry.type === "compaction") causes.push({ kind: "compaction" });
    else if (entry.type === "model_change") causes.push({ kind: "model_change", modelId: entry.modelId });
    else if (entry.type === "branch_summary") causes.push({ kind: "branch_nav" });
  }
  if (args.prev) {
    const gapMs = args.current.timestamp - args.prev.timestamp;
    const ttlMs = args.longRetention ? TTL_LONG_MS : TTL_SHORT_MS;
    if (gapMs > ttlMs) causes.push({ kind: "ttl_expiry", gapMs });
  }
  if (causes.length === 0) causes.push({ kind: "prefix_change", divergence: args.divergence });
  return causes;
}

export function formatCause(cause: CacheBreakCause): string {
  switch (cause.kind) {
    case "compaction":
      return "compaction rewrote the context (full cache reset)";
    case "model_change":
      return `model switched${cause.modelId ? ` to ${cause.modelId}` : ""} (prompt cache is per-model)`;
    case "branch_nav":
      return "branch/tree navigation rewrote the prefix";
    case "ttl_expiry":
      return `probable cache TTL expiry (idle ${formatDuration(cause.gapMs)})`;
    case "prefix_change":
      return formatPrefixChange(cause.divergence);
  }
}

function formatPrefixChange(divergence: FingerprintDivergence | undefined): string {
  if (!divergence) {
    return "prefix content changed (no fingerprint retained for this turn — predates this process or pruned; entry-correlation only)";
  }
  switch (divergence.kind) {
    case "system_prompt":
      return "prefix changed: system prompt changed";
    case "tools":
      return "prefix changed: tool set changed";
    case "message":
      return `prefix changed: message #${divergence.index + 1} changed`;
    case "history_shrunk":
      return `prefix changed: history shrank from ${divergence.from} to ${divergence.to} messages`;
    case "no_baseline":
      return "prefix content changed (first request observed in this process — no earlier request to diff against)";
    case "unrecognized_payload":
      return "prefix content changed (request shape not recognized for fingerprinting)";
    case "none":
      return "prefix looks identical (likely provider-side cache miss or eviction)";
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ""}`;
}

// ---------------------------------------------------------------------------
// /cache report
// ---------------------------------------------------------------------------

export interface SnapshotPair {
  prev?: FingerprintSnapshot;
  curr: FingerprintSnapshot;
}

export interface CacheReportArgs {
  branch: readonly SessionEntryLike[];
  /** In-process fingerprint pairs keyed by assistant message timestamp (Unix ms). */
  snapshots?: ReadonlyMap<number, SnapshotPair>;
  longRetention?: boolean;
}

export interface CacheReportRow {
  turn: TurnCacheStats;
  isBreak: boolean;
  causes: CacheBreakCause[];
  /** True when this turn had an in-process fingerprint pair. */
  fingerprinted: boolean;
}

/** Display tone for a report line — travels with the data so renderers never parse text. */
export type ReportTone = "text" | "warning" | "muted";

export interface ReportLine {
  text: string;
  tone: ReportTone;
}

export interface CacheReport {
  stats: SessionCacheStats;
  rows: CacheReportRow[];
  lines: ReportLine[];
}

/** Compact token count (shared by the footer and the /cache report). */
export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}m`;
}

/** Whole-number percentage (shared by the footer and the /cache report). */
export function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** 10-cell hit-rate bar for the /cache report (█ filled, ░ empty). */
export function hitBar(rate: number): string {
  const slots = 10;
  const filled = Math.max(0, Math.min(slots, Math.round(rate * slots)));
  return "█".repeat(filled) + "░".repeat(slots - filled);
}

/** Build the /cache report: per-turn stats, breaks, and attributed causes. */
export function buildCacheReport(args: CacheReportArgs): CacheReport {
  const stats = computeSessionCacheStats(args.branch);
  const rows: CacheReportRow[] = [];

  for (let i = 0; i < stats.turns.length; i++) {
    const turn = stats.turns[i]!;
    const prev = stats.turns[i - 1];
    const isBreak = isCacheBreak(prev, turn);
    const pair = args.snapshots?.get(turn.timestamp);
    // A turn counts as fingerprinted only when a recognized request pair can actually be diffed.
    const fingerprinted = Boolean(pair?.prev && pair.prev.recognized && pair.curr.recognized);
    let causes: CacheBreakCause[] = [];
    if (isBreak) {
      const entriesBetween = args.branch.slice(prev ? prev.branchIndex + 1 : 0, turn.branchIndex + 1);
      const divergence: FingerprintDivergence | undefined = !pair
        ? undefined
        : pair.prev
          ? diffSnapshots(pair.prev, pair.curr)
          : { kind: "no_baseline" };
      causes = attributeBreak({
        entriesBetween,
        prev,
        current: turn,
        longRetention: args.longRetention,
        divergence,
      });
    }
    rows.push({ turn, isBreak, causes, fingerprinted });
  }

  const lines: ReportLine[] = [];
  if (stats.turns.length === 0) {
    lines.push({ text: "No assistant turns with usage in this branch yet.", tone: "text" });
    return { stats, rows, lines };
  }

  lines.push({
    text: `Session cache rate: ${pct(stats.sessionRate)}  ${hitBar(stats.sessionRate)}  read ${formatTokens(stats.totalRead)} / prompt ${formatTokens(stats.totalPrompt)} · write ${formatTokens(stats.totalWrite)}`,
    tone: "text",
  });
  lines.push({ text: "", tone: "text" });
  lines.push({ text: `${"turn".padEnd(6)}${"hit".padEnd(17)}${"prompt".padEnd(9)}${"read".padEnd(9)}${"write".padEnd(9)}`, tone: "muted" });
  for (const row of rows) {
    const t = row.turn;
    const base = `${`#${t.turn + 1}`.padEnd(6)}${hitBar(t.rate)} ${pct(t.rate).padEnd(6)}${formatTokens(t.prompt).padEnd(9)}${formatTokens(t.read).padEnd(9)}${formatTokens(t.write).padEnd(9)}`;
    lines.push({ text: `${base}${row.isBreak ? "BREAK" : ""}`.trimEnd(), tone: row.isBreak ? "warning" : "text" });
    for (const cause of row.causes) {
      lines.push({ text: `      └ ${formatCause(cause)}`, tone: "muted" });
    }
  }
  const observed = rows.filter((row) => row.fingerprinted).length;
  lines.push({ text: "", tone: "text" });
  lines.push({
    text: `Prefix fingerprints cover ${observed}/${rows.length} turns (only turns observed in this process get exact divergence attribution).`,
    tone: "muted",
  });
  return { stats, rows, lines };
}
