// session-cost.ts — whole-session-tree cost accounting for the footer.
//
// Pi prices a session by scanning ONE session file's entries and never aggregates
// related files, so everything a parent spawns (subagents, advisor consults, goal
// checkers, panelists, BTW asides) is billed but invisible. This module walks the
// parent's descendants and sums them with Pi's own rules.
//
// Pi's rules, replicated in `accumulateEntry` (see the installed pi-coding-agent:
// dist/core/agent-session.js getSessionStats() and dist/core/usage-totals.js
// getUsageCostBreakdown()): assistant `usage`, `toolResult.usage`, and
// `branch_summary`/`compaction` `usage`, over ALL entries rather than one branch.
//
// Every read that fails is disclosed rather than absorbed: a directory that cannot be
// listed, a file that cannot be opened or stat-ed, an entry that cannot be parsed. Each
// leaves the total a floor with a stated reason, because a figure that silently omits
// spend while reading as exact is the one failure this module exists to prevent. Absence
// is not failure — most sessions spawn nothing, and a sidecar directory that was never
// created hides nothing.
//
// One case sits outside that claim on purpose. A file whose last line is incomplete is
// being appended to as far as any single read can tell, so the partial line is held for
// the rest to arrive rather than counted as a gap. If the process writing it died there,
// that entry's spend is missing and the total will not say so — the alternative marks
// every session that is mid-turn.
//
// Two additions Pi has no equivalent for:
//   - `pi-cost-record` custom entries, for billed calls that produce no session.
//   - price fidelity: turns issued at OpenAI's priority tier cost more than Pi's
//     static per-model rates, and an unpriceable model (e.g. a model-aliases
//     entry whose target price cannot be resolved) reports real tokens at $0.
//     Both mark the total approximate rather than reporting a confident wrong number.

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

/**
 * Does this filesystem error mean nothing is there, as opposed to something being there
 * that could not be read?
 *
 * The distinction decides whether a failed read is a gap in the total. `ENOENT` is the
 * ordinary case — most sessions spawn nothing, so their sidecar directory never exists.
 * `ENOTDIR` says a path component is a regular file, and nothing can live beneath a file,
 * so again nothing is missing. Every other code — `EACCES`, `EPERM`, `EIO`, `ELOOP` —
 * means sessions or entries may exist that this scan could not see, and a total that
 * omits them must not read as exact.
 */
export function isAbsence(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Custom-entry type carrying usage for a billed call with no Pi session of its own.
 * Written with `pi.appendEntry(COST_RECORD_TYPE, data)`, whose entries are durable and
 * excluded from LLM context (installed pi-coding-agent: CustomEntry in
 * dist/core/session-manager.d.ts, appendCustomEntry in dist/core/session-manager.js).
 */
export const COST_RECORD_TYPE = "pi-cost-record";
/** Custom-entry type recording which billing tier subsequent turns were issued at. */
export const PRICE_TIER_RECORD_TYPE = "pi-price-tier";

/** Payload of a `pi-cost-record` custom entry. */
export interface CostRecordData {
  /** Stable id for the billed call, so a replayed or duplicated record counts once. */
  recordId: string;
  /** Bucket the spend is reported under, e.g. `keepalive` or `openai/tts-1`. */
  key: string;
  usage: UsageLike;
  /** Billing tier this call actually paid, when it differs from the ambient tier. */
  tier?: "standard" | "priority";
  /**
   * False when the call was billed but no rate was available to value it — speech
   * charged per character with no configured rate, for instance. The cost then reads
   * $0 and the surfaces mark the total approximate rather than reporting it low.
   */
  priced?: boolean;
}

/**
 * Payload of a `pi-price-tier` custom entry.
 *
 * Self-describing on purpose: whichever extension knows about the billing tier states
 * both the tier and what it costs relative to standard rates, so this module needs no
 * knowledge of that extension — not its name, not its config file.
 */
export interface PriceTierData {
  tier: "standard" | "priority";
  /** Price as a multiple of the standard rate (2 = twice). Absent means unknown. */
  multiplier?: number;
}
/** Bucket key Pi uses for non-assistant usage (tool results, compaction, branch summaries). */
export const TOOLS_BUCKET_KEY = "Tools/summaries";

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelTotals extends TokenTotals {
  key: string;
  cost: number;
  /** True when real usage here was counted at $0 because no rate could be resolved. */
  unpriced: boolean;
  /** Tokens that were billed but priced at $0 because no rate could be resolved. */
  unpricedTokens: number;
  /** Tokens billed at a premium service tier whose surcharge Pi's rates do not model. */
  priorityTokens: number;
  /**
   * Standard-rate cost of priority-tier turns left uncorrected because no multiplier is
   * configured. The real charge is some multiple of this, so it is the size of the
   * spend the total is approximating rather than the size of the missing premium.
   */
  uncorrectedPriorityCost: number;
}

export interface CostAccumulator {
  cost: number;
  tokens: TokenTotals;
  byModel: Map<string, ModelTotals>;
  /**
   * Session lines that could not be parsed, so whatever they were billed is missing.
   *
   * Latched here rather than counted per scan because the bytes are consumed once: the
   * scanner advances past a bad line and never reads it again, while `ScanStats` resets
   * on every scan. The accumulator lives as long as the file's folded total does, which
   * is exactly as long as the gap does.
   */
  corruptEntries: number;
  /** Dedupe keys already counted, so a re-read or a duplicated record cannot inflate. */
  countedKeys: Set<string>;
  /** Billing tier in force for subsequent entries, per the latest tier record. */
  currentTier: "standard" | "priority";
  /** Premium the latest tier record declared, when it declared one. */
  currentMultiplier?: number;
}

export interface SessionCost {
  /** Session id from the file header, when known. */
  id?: string;
  /** Absolute session file path; absent for the live in-memory parent. */
  path?: string;
  /** Where this session came from: "own", or the sidecar folder name (tasks, advisor, ...). */
  kind: string;
  cost: number;
  tokens: TokenTotals;
  models: ModelTotals[];
  unpricedModels: string[];
  priorityTokens: number;
  uncorrectedPriorityCost: number;
  /** Entries in this session that could not be parsed, so their spend is missing. */
  corruptEntries: number;
  /** Dedupe keys this session contributed, so a fork of it cannot re-count them. */
  countedKeys: ReadonlySet<string>;
}

export interface TreeCost {
  own: SessionCost;
  descendants: SessionCost[];
  /** Own + every descendant. This is the footer headline. */
  totalCost: number;
  totalTokens: TokenTotals;
  /** True when some spend could not be priced exactly; render the total as approximate. */
  approximate: boolean;
  /** Human-readable reasons the total is approximate. */
  approximateReasons: string[];
  /** Models whose usage was real but priced at $0. */
  unpricedModels: string[];
  /**
   * Standard-rate cost of the priority-tier turns whose premium is uncorrected. The
   * real charge is a multiple of this figure.
   */
  uncorrectedPriorityCost: number;
  /** Parts of the tree whose spend could not be read, so it is missing from the total. */
  unreadableSessions: number;
  /** Session entries across the tree that could not be parsed, so their spend is missing. */
  corruptEntries: number;
  /**
   * True when spend was billed and could not be counted, as opposed to counted and found
   * to be nothing. Both make a total approximate, and surfaces need to tell them apart: a
   * $0 total is worth showing when money went uncounted and worth hiding when the session
   * genuinely cost nothing. Derived here rather than by each surface enumerating the gap
   * counters, so a later kind of gap reaches them without their having to know about it.
   */
  missingSpend: boolean;
}

/** Folding options: price adjustments plus double-count suppression. */
export interface FoldOptions extends PriceOptions {
  /**
   * Session ids and file paths already counted from their own session files. A tool
   * result that names one of these reports the same work a second time, so its usage
   * is dropped rather than added.
   */
  countedSessions?: ReadonlySet<string>;
  /**
   * Dedupe keys already counted elsewhere in the tree. A fork copies its parent's
   * entries verbatim into its own file — BTW asides and pi's own `/fork` both do —
   * so those turns appear in two session files while having been billed once.
   */
  excludeKeys?: ReadonlySet<string>;
}

/**
 * Price adjustments the scanner cannot derive from the session alone.
 *
 * Normally nothing needs to be supplied here: a tier record states its own premium.
 * This is the fallback for a producer that records a tier without one.
 */
export interface PriceOptions {
  /**
   * Multiplier applied to priority-tier turn cost (e.g. 2 = twice the standard rate)
   * when the tier record does not declare one. Unset leaves those turns at standard
   * rates and marks the total approximate.
   */
  priorityMultiplier?: number;
}

export function createTokenTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function createAccumulator(): CostAccumulator {
  return {
    cost: 0,
    tokens: createTokenTotals(),
    byModel: new Map(),
    corruptEntries: 0,
    countedKeys: new Set(),
    currentTier: "standard",
  };
}

function addTokens(target: TokenTotals, usage: UsageLike): number {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  target.input += input;
  target.output += output;
  target.cacheRead += cacheRead;
  target.cacheWrite += cacheWrite;
  return input + output + cacheRead + cacheWrite;
}

function modelTotals(acc: CostAccumulator, key: string): ModelTotals {
  let totals = acc.byModel.get(key);
  if (!totals) {
    totals = { key, cost: 0, ...createTokenTotals(), unpriced: false, unpricedTokens: 0, priorityTokens: 0, uncorrectedPriorityCost: 0 };
    acc.byModel.set(key, totals);
  }
  return totals;
}

/** Usage plus its bucket key for one session entry, or undefined when the entry is not billed. */
function billedUsage(entry: any): { key: string; usage: UsageLike } | undefined {
  if (entry?.type === "branch_summary" || entry?.type === "compaction") {
    return entry.usage ? { key: TOOLS_BUCKET_KEY, usage: entry.usage } : undefined;
  }
  if (entry?.type === "custom" && entry.customType === COST_RECORD_TYPE) {
    const data = entry.data;
    if (!data?.usage) return undefined;
    return { key: typeof data.key === "string" && data.key ? data.key : "Non-session calls", usage: data.usage };
  }
  if (entry?.type !== "message") return undefined;
  const message = entry.message;
  if (!message) return undefined;
  if (message.role === "assistant") {
    if (!message.usage) return undefined;
    const key = `${message.provider ?? "unknown"}/${message.responseModel ?? message.model ?? "unknown"}`;
    return { key, usage: message.usage };
  }
  if (message.role === "toolResult") {
    return message.usage ? { key: TOOLS_BUCKET_KEY, usage: message.usage } : undefined;
  }
  return undefined;
}

/**
 * Identity of one billed unit, stable across files and re-reads.
 *
 * A cost record is identified by its own record id. Everything else uses the entry
 * id plus its timestamp: pi's entry ids are only 8 hex characters, unique within a
 * session but not across a large tree, so the timestamp is what makes the key safe
 * to compare between files — a copied fork entry keeps both verbatim, while two
 * unrelated entries would have to collide on both to be wrongly merged.
 */
export function entryDedupeKey(entry: any): string | undefined {
  const recordId = entry?.type === "custom" ? entry.data?.recordId : undefined;
  if (typeof recordId === "string" && recordId) return `record:${recordId}`;
  if (typeof entry?.id !== "string" || !entry.id) return undefined;
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : entry.message?.timestamp;
  return timestamp === undefined ? entry.id : `${entry.id}@${timestamp}`;
}

/**
 * Does this entry's usage restate work already counted from a child session file?
 * A tool that runs a child session and also reports usage would otherwise be billed
 * twice; the tool result names the session it ran, which is the side we drop.
 */
function restatesCountedSession(entry: any, counted: ReadonlySet<string> | undefined): boolean {
  if (!counted || counted.size === 0) return false;
  const details = entry?.message?.details;
  if (!details) return false;
  for (const key of ["childSessionId", "sessionId", "childSessionFile", "sessionFile"]) {
    const value = details[key];
    if (typeof value === "string" && counted.has(value)) return true;
  }
  return false;
}

/**
 * Fold one session entry into `acc`, applying Pi's accounting rules plus the two
 * price-fidelity adjustments. Entries already counted (by id) are ignored, so
 * repeated scans and duplicated cost records cannot inflate a total.
 */
export function accumulateEntry(acc: CostAccumulator, entry: any, price: FoldOptions = {}): void {
  if (entry?.type === "custom" && entry.customType === PRICE_TIER_RECORD_TYPE) {
    const tier = entry.data?.tier;
    if (tier === "priority" || tier === "standard") acc.currentTier = tier;
    const declared = entry.data?.multiplier;
    acc.currentMultiplier = typeof declared === "number" && declared > 0 ? declared : undefined;
    return;
  }

  const billed = billedUsage(entry);
  if (!billed) return;
  if (restatesCountedSession(entry, price.countedSessions)) return;

  const dedupeKey = entryDedupeKey(entry);
  if (dedupeKey) {
    if (acc.countedKeys.has(dedupeKey) || price.excludeKeys?.has(dedupeKey)) return;
    acc.countedKeys.add(dedupeKey);
  }

  const tokens = addTokens(acc.tokens, billed.usage);
  const totals = modelTotals(acc, billed.key);
  addTokens(totals, billed.usage);

  const baseCost = billed.usage.cost?.total ?? 0;
  // The ambient tier covers every request pi issues on the session's model — assistant
  // turns, but also the compaction, branch-summary, and tool-nested calls that go
  // through the same provider path and are billed at the same tier. A cost record is a
  // separate paid call, so it is only priority when it says so itself.
  const ownTier = entry?.type === "custom" ? entry.data?.tier : undefined;
  const tier = ownTier ?? (entry?.type === "custom" ? "standard" : acc.currentTier);
  const priority = tier === "priority";
  // The record's own premium wins; a caller-supplied one is only a fallback, so no cost
  // surface has to know which extension produced the tier.
  const multiplier = priority ? (acc.currentMultiplier ?? price.priorityMultiplier) : undefined;
  const cost = multiplier != null ? baseCost * multiplier : baseCost;

  acc.cost += cost;
  totals.cost += cost;
  if (priority) {
    totals.priorityTokens += tokens;
    if (multiplier == null) totals.uncorrectedPriorityCost += baseCost;
  }
  // Unpriced spend, from either direction: real usage that priced to nothing, or a
  // record that says outright it could not be priced (speech with no configured rate,
  // whose usage is characters rather than tokens).
  const declaredUnpriced = entry?.type === "custom" && entry.data?.priced === false;
  if ((tokens > 0 && baseCost === 0) || declaredUnpriced) {
    totals.unpriced = true;
    totals.unpricedTokens += tokens;
  }
}

/** Collapse an accumulator into a comparable per-session summary. */
export function summarize(acc: CostAccumulator, meta: { id?: string; path?: string; kind: string }): SessionCost {
  const models = [...acc.byModel.values()].sort((a, b) => b.cost - a.cost);
  return {
    ...meta,
    cost: acc.cost,
    tokens: acc.tokens,
    corruptEntries: acc.corruptEntries,
    countedKeys: acc.countedKeys,
    models,
    unpricedModels: models.filter((m) => m.unpriced).map((m) => m.key),
    priorityTokens: models.reduce((sum, m) => sum + m.priorityTokens, 0),
    uncorrectedPriorityCost: models.reduce((sum, m) => sum + m.uncorrectedPriorityCost, 0),
  };
}

/**
 * Sum a session collection into the footer's headline figure.
 *
 * `unreadableSessions` counts spend the scan knows it could not read. A total that
 * silently omits a child's cost while reading as exact is the failure this whole
 * mechanism exists to prevent, so it marks the figure approximate too.
 *
 * Corrupt entries arrive on the sessions themselves rather than as an argument, because
 * those bytes are read once and the count has to outlive the read that found them.
 */
export function combine(own: SessionCost, descendants: SessionCost[], unreadableSessions = 0): TreeCost {
  const all = [own, ...descendants];
  const totalTokens = createTokenTotals();
  let totalCost = 0;
  let uncorrectedPriorityCost = 0;
  let corruptEntries = 0;
  const unpriced = new Set<string>();
  for (const session of all) {
    totalCost += session.cost;
    uncorrectedPriorityCost += session.uncorrectedPriorityCost;
    corruptEntries += session.corruptEntries;
    totalTokens.input += session.tokens.input;
    totalTokens.output += session.tokens.output;
    totalTokens.cacheRead += session.tokens.cacheRead;
    totalTokens.cacheWrite += session.tokens.cacheWrite;
    for (const key of session.unpricedModels) unpriced.add(key);
  }
  const reasons: string[] = [];
  if (uncorrectedPriorityCost > 0) {
    reasons.push("priority-tier turns counted at standard rates, because nothing declared the premium they were billed at");
  }
  if (unpriced.size > 0) {
    reasons.push(`no price resolved for ${[...unpriced].join(", ")} (unpriced, or genuinely free)`);
  }
  if (unreadableSessions > 0) {
    reasons.push(
      `${unreadableSessions} part${unreadableSessions === 1 ? "" : "s"} of the tree could not be read, so that spend is missing`,
    );
  }
  if (corruptEntries > 0) {
    reasons.push(
      `${corruptEntries} session entr${corruptEntries === 1 ? "y" : "ies"} could not be parsed, so that spend is missing`,
    );
  }
  return {
    own,
    descendants,
    totalCost,
    totalTokens,
    approximate: reasons.length > 0,
    approximateReasons: reasons,
    unpricedModels: [...unpriced],
    uncorrectedPriorityCost,
    unreadableSessions,
    corruptEntries,
    missingSpend: unreadableSessions > 0 || corruptEntries > 0,
  };
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Sidecar root for a session file: `<dir>/<basename without .jsonl>/`.
 * Matches the convention `@gotgenes/pi-subagents` already writes `tasks/` into,
 * and stays out of Pi's session list, which reads one directory non-recursively
 * (installed pi-coding-agent, dist/core/session-manager.js listSessionsFromDir).
 */
export function deriveSidecarRoot(sessionFile: string): string {
  return join(dirname(sessionFile), basename(sessionFile, ".jsonl"));
}

/** Sidecar directory for a given child kind, e.g. `advisor` or `tasks`. */
export function deriveChildSessionDir(sessionFile: string, kind: string): string {
  return join(deriveSidecarRoot(sessionFile), kind);
}

export interface SessionHeader {
  id?: string;
  /** Parent link: a session id (pi-subagents) or a session file path (Pi forks). */
  parentSession?: string;
  cwd?: string;
}

/**
 * Outcome of a header read. The two ways to have no header are worth keeping apart: a
 * file whose first line read and parsed and simply is not a session header belongs to
 * nobody, while a file whose first line could not be read or could not be parsed might
 * be a session of this tree — an unanswerable question rather than a negative answer.
 */
export interface SessionHeaderRead {
  header?: SessionHeader;
  /** True when something is there but could not be read, leaving its membership unknown. */
  unreadable?: boolean;
}

const HEADER_READ_BYTES = 16 * 1024;

/** Read a session file's first line without loading the whole file. */
export function readSessionHeader(path: string): SessionHeaderRead {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(HEADER_READ_BYTES);
    const read = readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    const line = newline >= 0 ? text.slice(0, newline) : text;
    // Nothing written yet is the same as nothing there: an empty file holds no spend, and
    // pi leaves one behind whenever it opens a session file before writing its header.
    // Parsing "" would throw, and reading that as unknown would mark a total that is exact.
    if (!line.trim()) return {};
    const parsed = JSON.parse(line);
    if (parsed?.type !== "session") return {};
    return { header: { id: parsed.id, parentSession: parsed.parentSession, cwd: parsed.cwd } };
  } catch (error) {
    // Absence answers the question — nothing is there to belong to this tree. Nothing else
    // does. A first line that will not parse is the shape a torn write leaves behind, and a
    // header longer than the bytes read above is truncated rather than absent, so neither
    // says the file is unrelated; treating them as an answer would drop a fork of this
    // session on a bad byte.
    return isAbsence(error) ? {} : { unreadable: true };
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * How deep the sidecar walk goes. Each generation of nesting costs two levels
 * (`<session>/<kind>/`), so this allows sessions spawned about sixteen deep — far past
 * any real tree, while still bounding a pathological one. Hitting it is reported rather
 * than passed over, since dropped descendants would otherwise lower the total silently.
 */
export const MAX_SIDECAR_DEPTH = 32;

/**
 * Every `.jsonl` file under `root`, at any depth, with the top-level folder as its kind.
 *
 * `unreadableDirs` counts directories that exist but could not be read. Every session
 * beneath one of those is invisible to this walk, so it is reported for the same reason
 * `truncated` is: a total silently missing those sessions would still read as exact.
 */
export function listSidecarSessionFiles(
  root: string,
  maxDepth = MAX_SIDECAR_DEPTH,
): { files: Array<{ path: string; kind: string }>; truncated: boolean; unreadableDirs: number } {
  const found: Array<{ path: string; kind: string }> = [];
  let truncated = false;
  let unreadableDirs = 0;
  const walk = (dir: string, kind: string, depth: number) => {
    if (depth > maxDepth) {
      truncated = true;
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // A directory that exists and cannot be listed hides every session below it.
      if (!isAbsence(error)) unreadableDirs += 1;
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, kind || entry.name, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.push({ path: full, kind: kind || "children" });
      }
    }
  };
  walk(root, "", 0);
  return { files: found, truncated, unreadableDirs };
}

// ── Scanner ──────────────────────────────────────────────────────────────────

interface FileCacheEntry {
  size: number;
  mtimeMs: number;
  /** Byte offset already folded into `acc`. */
  offset: number;
  /** Trailing text of an incomplete final line, prepended to the next read. */
  remainder: string;
  /** Keeps a multi-byte character split across two reads intact. */
  decoder: StringDecoder;
  acc: CostAccumulator;
  header?: SessionHeader;
  reads: number;
}

export interface ScanStats {
  /** Files whose bytes were read this scan (a cache hit reads nothing). */
  filesRead: number;
  filesDiscovered: number;
  /**
   * Parts of the tree this scan could not read: a file it could not open or stat, a
   * directory it could not list, a sibling it could not classify, or a walk that hit its
   * depth bound. In every case spend may be missing, which is what makes a total a floor.
   * A path that never existed is not counted here — nothing is missing from nothing. One
   * this scan discovered and then could not read is, since it was there a moment ago.
   */
  filesUnreadable: number;
}

/**
 * Caching, incremental scanner over a session tree.
 *
 * Session files are append-only, so an unchanged file is never re-read and a grown
 * file is read only from its previous end.
 *
 * Nothing here throws on a bad read; what it does instead is the point. A path that was
 * never there holds nothing, so it costs the total nothing — but one this scan discovered
 * and then found gone does count, for the reason `scanFile` gives. Anything else that
 * cannot be read — a failed open or stat, a directory that will not list, a line that will
 * not parse — keeps whatever was already folded and is counted as a gap, so the total
 * reads as a floor with a reason rather than as an exact smaller number.
 */
export class SessionTreeScanner {
  private readonly files = new Map<string, FileCacheEntry>();
  private lastStats: ScanStats = { filesRead: 0, filesDiscovered: 0, filesUnreadable: 0 };

  /**
   * `maxSidecarDepth` exists so the truncation disclosure can be exercised without
   * building a sixteen-generation tree; production uses the default.
   */
  constructor(
    private readonly price: PriceOptions = {},
    private readonly maxSidecarDepth: number = MAX_SIDECAR_DEPTH,
  ) {}

  private freshFileCache(header?: SessionHeader, reads = 0): FileCacheEntry {
    return { size: 0, mtimeMs: 0, offset: 0, remainder: "", decoder: new StringDecoder("utf8"), acc: createAccumulator(), header, reads };
  }

  get stats(): ScanStats {
    return this.lastStats;
  }

  setPrice(price: PriceOptions): void {
    if (price.priorityMultiplier === this.price.priorityMultiplier) return;
    // Pricing changes invalidate every folded total, so drop the cache wholesale.
    (this.price as PriceOptions).priorityMultiplier = price.priorityMultiplier;
    this.files.clear();
  }

  /**
   * Cost of one session file, folding only bytes appended since the last scan.
   *
   * `fold` carries the tree-level suppression sets. They matter only while an entry is
   * first folded — a fork's copied history is fixed when the fork is created — so a
   * cached file needs no re-evaluation when they grow.
   */
  scanFile(
    path: string,
    kind: string,
    fold: Omit<FoldOptions, keyof PriceOptions> & { knownToExist?: boolean } = {},
  ): SessionCost | undefined {
    let stat: import("node:fs").Stats;
    try {
      stat = statSync(path);
    } catch (error) {
      // Classified before anything else, because the gap is the same whether or not this
      // file had been read before: a path that is gone hides nothing further, while any
      // other failure means a discovered session may be holding spend out of sight.
      //
      // Absence is not forgiven for a file this scan just discovered. It existed moments
      // ago, which is why its id already sits in `countedSessions` — so the parent's tool
      // result restating this session's spend has been dropped as a duplicate of a file
      // that then disappeared. Treating that as benign loses the same money twice over and
      // still reads as exact.
      if (!isAbsence(error) || fold.knownToExist) this.lastStats.filesUnreadable += 1;
      const counted = this.files.get(path);
      if (!counted) return undefined; // never read, so there is no folded total to keep
      // Spend already folded here has been counted and shown, so it stands rather than
      // quietly lowering a total the user has seen — the same choice the failed read below
      // makes. Reached when a discovered file stops being readable, and for the one scan
      // that catches a deletion mid-pass; by the next scan a deleted file is no longer
      // discovered, and then it is no longer part of the tree at all.
      return summarize(counted.acc, { id: counted.header?.id, path, kind });
    }
    const cached = this.files.get(path);
    const grewInPlace = cached != null && stat.size >= cached.size && stat.mtimeMs >= cached.mtimeMs;
    const entry: FileCacheEntry = grewInPlace ? cached : this.freshFileCache(cached?.header, cached?.reads ?? 0);
    this.files.set(path, entry);

    if (grewInPlace && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) {
      return summarize(entry.acc, { id: entry.header?.id, path, kind });
    }

    const chunk = this.readRange(path, entry.offset, stat.size, entry.decoder);
    if (!("text" in chunk)) {
      // Keep whatever was already folded, so a total missing this file's spend is not
      // presented as exact — and report the gap on the same rule the stat above uses: a
      // path that was never seen hides nothing, but one this scan just discovered was there
      // moments ago, and its bytes are spend nothing else will account for.
      if (!chunk.absent || fold.knownToExist) this.lastStats.filesUnreadable += 1;
      return summarize(entry.acc, { id: entry.header?.id, path, kind });
    }
    entry.reads += 1;
    this.lastStats.filesRead += 1;

    const text = entry.remainder + chunk.text;
    const lines = text.split("\n");
    // A file being appended to can end mid-line; hold it back until the rest arrives. A
    // torn write that is never followed by another entry stays held and uncounted, which is
    // the one gap this module does not disclose — see the note in the module header.
    entry.remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A corrupt line is skipped rather than failing the whole scan, but it is spend
        // this total will never include: pi appends each entry as one write, so a torn
        // write merges with the next entry into a single unparseable line and takes that
        // entry's cost down with it. Counted on the accumulator, which outlives the read.
        entry.acc.corruptEntries += 1;
        continue;
      }
      if (parsed?.type === "session") {
        entry.header = { id: parsed.id, parentSession: parsed.parentSession, cwd: parsed.cwd };
        continue;
      }
      accumulateEntry(entry.acc, parsed, { ...this.price, ...fold });
    }
    // Offset tracks bytes actually consumed; the incomplete tail lives in `remainder`,
    // so the next read resumes after it and no byte is folded twice. A short read
    // leaves the offset behind rather than skipping the bytes it never saw.
    entry.offset += chunk.bytesRead;
    entry.size = entry.offset;
    entry.mtimeMs = stat.mtimeMs;
    return summarize(entry.acc, { id: entry.header?.id, path, kind });
  }

  /**
   * Bytes in `[from, to)`, or why the read failed. `absent` separates a file that vanished
   * between the stat and the open from one that is there and could not be read. The caller
   * decides what that means: absence hides nothing for a path it never saw, and hides this
   * file's whole contribution for one it just discovered.
   */
  private readRange(
    path: string,
    from: number,
    to: number,
    decoder: StringDecoder,
  ): { text: string; bytesRead: number } | { absent: boolean } {
    if (to <= from) return { text: "", bytesRead: 0 };
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const length = to - from;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, from);
      return { text: decoder.write(buffer.subarray(0, read)), bytesRead: read };
    } catch (error) {
      return { absent: isAbsence(error) };
    } finally {
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    }
  }

  /**
   * Every descendant of `rootFile`/`rootId`, following both discovery signals:
   * a session's location under an ancestor's sidecar directory, and a `parentSession`
   * header holding either a session id or a session file path.
   *
   * Both signals are evaluated for every candidate rather than one per location, since
   * real children carry both — a panelist sits in the sidecar directory AND names its
   * parent's id. Admission is therefore what keeps a session single: once by resolved
   * path, once by id, which also makes cycles and self-links harmless.
   */
  discover(rootFile: string | undefined, rootId: string | undefined): Array<{ path: string; kind: string; header?: SessionHeader }> {
    const results: Array<{ path: string; kind: string; header?: SessionHeader }> = [];
    if (!rootFile && !rootId) return results;

    const seenPaths = new Set<string>();
    const seenIds = new Set<string>();
    if (rootFile) seenPaths.add(resolveRealPath(rootFile));
    if (rootId) seenIds.add(rootId);

    const candidates = this.collectCandidates(rootFile, seenPaths);
    const queue: Array<{ file?: string; id?: string }> = [{ file: rootFile, id: rootId }];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const sidecarPrefix = node.file ? deriveSidecarRoot(node.file) + sep : undefined;
      for (const candidate of candidates) {
        if (seenPaths.has(candidate.real)) continue;
        if (candidate.header?.id && seenIds.has(candidate.header.id)) continue;
        const byLocation = sidecarPrefix !== undefined && candidate.path.startsWith(sidecarPrefix);
        const link = candidate.header?.parentSession;
        const byHeader = link !== undefined && (link === node.id || link === node.file);
        if (!byLocation && !byHeader) continue;
        seenPaths.add(candidate.real);
        if (candidate.header?.id) seenIds.add(candidate.header.id);
        results.push({ path: candidate.path, kind: candidate.kind, header: candidate.header });
        queue.push({ file: candidate.path, id: candidate.header?.id });
      }
    }
    this.lastStats.filesDiscovered = results.length;
    return results;
  }

  /**
   * Session files that could belong to this tree: everything under the root's sidecar
   * subtree (at any depth), plus the root's own directory, where pi writes forks as
   * siblings that only a header links back. Headers are read once and cached.
   */
  private collectCandidates(
    rootFile: string | undefined,
    skip: ReadonlySet<string>,
  ): Array<{ path: string; real: string; kind: string; header?: SessionHeader }> {
    if (!rootFile) return [];
    const byPath = new Map<string, { path: string; real: string; kind: string; header?: SessionHeader }>();
    const add = (path: string, kind: string): SessionHeaderRead => {
      const real = resolveRealPath(path);
      if (skip.has(real)) return {};
      const existing = byPath.get(real);
      if (existing) return { header: existing.header };
      const read = this.cachedHeader(path);
      byPath.set(real, { path, real, kind, header: read.header });
      return read;
    };
    const sidecar = listSidecarSessionFiles(deriveSidecarRoot(rootFile), this.maxSidecarDepth);
    if (sidecar.truncated) this.lastStats.filesUnreadable += 1;
    this.lastStats.filesUnreadable += sidecar.unreadableDirs;
    for (const file of sidecar.files) add(file.path, file.kind);
    try {
      for (const name of readdirSync(dirname(rootFile))) {
        if (!name.endsWith(".jsonl")) continue;
        // A sibling belongs to this tree only if its header says so. When its first line
        // cannot be read or cannot be parsed, that question has no answer, and a fork of
        // this session would drop out of the total unnoticed — so the ambiguity is disclosed
        // rather than resolved as "unrelated". A sidecar file needs no such care: it is
        // admitted by where it sits, and its own read failure is reported when it is scanned.
        if (add(join(dirname(rootFile), name), "forks").unreadable) this.lastStats.filesUnreadable += 1;
      }
    } catch {
      // This directory holds the parent session file itself, so it existed; every failure
      // here is a real one, absence included — a directory that has gone missing under a
      // live session took every fork of it along. Sidecar candidates still stand, but the
      // forks are now unaccounted for.
      this.lastStats.filesUnreadable += 1;
    }
    return [...byPath.values()];
  }

  private cachedHeader(path: string): SessionHeaderRead {
    const cached = this.files.get(path);
    if (cached?.header) return { header: cached.header };
    const read = readSessionHeader(path);
    if (read.header) {
      const entry = cached ?? this.freshFileCache();
      entry.header = read.header;
      this.files.set(path, entry);
    }
    return read;
  }

  /**
   * Whole-tree cost: the parent plus every descendant on disk. This is the single
   * tree walk — the live footer and post-hoc analysis differ only in where the
   * parent's own entries come from.
   *
   * Pass `ownEntries` from a live session manager so the parent's own file — the
   * largest and most frequently appended — is never re-read; omit it to read the
   * parent from disk, which is what analysis of a finished session does.
   *
   * Order is load-bearing twice over: descendants are discovered before the parent
   * is folded so its tool results can be recognized as restatements, and the parent
   * is folded before its descendants so its turns own their identity and a fork that
   * copied them contributes only what it added.
   */
  scanTree(args: { ownEntries?: Iterable<any>; sessionFile?: string; sessionId?: string }): TreeCost {
    this.lastStats = { filesRead: 0, filesDiscovered: 0, filesUnreadable: 0 };

    const rootRead = args.sessionFile ? this.cachedHeader(args.sessionFile) : undefined;
    const rootId = args.sessionId ?? rootRead?.header?.id;
    // An unreadable root header costs the tree every fork that links back by session id —
    // but only when the id was not handed in, since that is the only thing the header was
    // needed for here. Counted only when the parent's entries come from memory too, because
    // otherwise this same file is scanned below and reports the failure there. Anything else
    // would mark a total that is missing nothing.
    if (rootRead?.unreadable && args.ownEntries && !args.sessionId) this.lastStats.filesUnreadable += 1;
    const found = this.discover(args.sessionFile, rootId);
    const countedSessions = new Set<string>();
    for (const child of found) {
      if (child.header?.id) countedSessions.add(child.header.id);
      countedSessions.add(child.path);
    }

    let own: SessionCost | undefined;
    if (args.ownEntries) {
      const ownAcc = createAccumulator();
      for (const entry of args.ownEntries) accumulateEntry(ownAcc, entry, { ...this.price, countedSessions });
      own = summarize(ownAcc, { id: rootId, path: args.sessionFile, kind: "own" });
    } else if (args.sessionFile) {
      own = this.scanFile(args.sessionFile, "own", { countedSessions });
    }
    own ??= summarize(createAccumulator(), { id: rootId, path: args.sessionFile, kind: "own" });

    const excludeKeys = new Set<string>(own.countedKeys);
    const descendants: SessionCost[] = [];
    for (const child of found) {
      const cost = this.scanFile(child.path, child.kind, { countedSessions, excludeKeys, knownToExist: true });
      if (!cost) continue;
      descendants.push(cost);
      for (const key of cost.countedKeys) excludeKeys.add(key);
    }
    descendants.sort((a, b) => b.cost - a.cost);

    return combine(own, descendants, this.lastStats.filesUnreadable);
  }
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
