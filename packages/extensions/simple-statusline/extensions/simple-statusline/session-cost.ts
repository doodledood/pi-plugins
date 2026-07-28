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
// Two additions Pi has no equivalent for:
//   - `pi-cost-record` custom entries, for billed calls that produce no session.
//   - price fidelity: turns issued at OpenAI's priority tier cost more than Pi's
//     static per-model rates, and an unpriceable model (e.g. a model-aliases
//     entry whose target price cannot be resolved) reports real tokens at $0.
//     Both mark the total approximate rather than reporting a confident wrong number.

import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

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
}

/** Payload of a `pi-price-tier` custom entry. */
export interface PriceTierData {
  tier: "standard" | "priority";
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
  /** Tokens that were billed but priced at $0 because no rate could be resolved. */
  unpricedTokens: number;
  /** Tokens billed at a premium service tier whose surcharge Pi's rates do not model. */
  priorityTokens: number;
  /** Premium not included in `cost` because no multiplier is configured. */
  uncorrectedPriorityCost: number;
}

export interface CostAccumulator {
  cost: number;
  tokens: TokenTotals;
  byModel: Map<string, ModelTotals>;
  /** Entry ids already counted, so a re-read or a duplicated record cannot inflate. */
  seenEntryIds: Set<string>;
  /** Billing tier in force for subsequent entries, per the latest tier record. */
  currentTier: "standard" | "priority";
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
  /** Premium for priority-tier turns that is missing from `totalCost`. */
  uncorrectedPriorityCost: number;
}

/** Folding options: price adjustments plus double-count suppression. */
export interface FoldOptions extends PriceOptions {
  /**
   * Session ids and file paths already counted from their own session files. A tool
   * result that names one of these reports the same work a second time, so its usage
   * is dropped rather than added.
   */
  countedSessions?: ReadonlySet<string>;
}

/** Price adjustments the scanner cannot derive from the session alone. */
export interface PriceOptions {
  /**
   * Multiplier applied to priority-tier turn cost (e.g. 2 = twice the standard rate).
   * Unset leaves those turns at standard rates and marks the total approximate.
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
    seenEntryIds: new Set(),
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
    totals = { key, cost: 0, ...createTokenTotals(), unpricedTokens: 0, priorityTokens: 0, uncorrectedPriorityCost: 0 };
    acc.byModel.set(key, totals);
  }
  return totals;
}

/** Whether an entry is an assistant turn, whose cost the billing tier can modify. */
function isAssistantEntry(entry: any): boolean {
  return entry?.type === "message" && entry.message?.role === "assistant";
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

/** Entry id used for dedupe: a cost record's own record id, else the entry id. */
function entryDedupeId(entry: any): string | undefined {
  const recordId = entry?.type === "custom" ? entry.data?.recordId : undefined;
  if (typeof recordId === "string" && recordId) return `record:${recordId}`;
  return typeof entry?.id === "string" && entry.id ? entry.id : undefined;
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
    return;
  }

  const billed = billedUsage(entry);
  if (!billed) return;
  if (restatesCountedSession(entry, price.countedSessions)) return;

  const dedupeId = entryDedupeId(entry);
  if (dedupeId) {
    if (acc.seenEntryIds.has(dedupeId)) return;
    acc.seenEntryIds.add(dedupeId);
  }

  const tokens = addTokens(acc.tokens, billed.usage);
  const totals = modelTotals(acc, billed.key);
  addTokens(totals, billed.usage);

  const baseCost = billed.usage.cost?.total ?? 0;
  // A record stating the tier it paid wins over the ambient tier.
  const ownTier = entry?.type === "custom" ? entry.data?.tier : undefined;
  const tier = ownTier ?? acc.currentTier;
  const priority = tier === "priority" && (isAssistantEntry(entry) || ownTier === "priority");
  const multiplier = priority ? price.priorityMultiplier : undefined;
  const cost = multiplier != null ? baseCost * multiplier : baseCost;

  acc.cost += cost;
  totals.cost += cost;
  if (priority) {
    totals.priorityTokens += tokens;
    if (multiplier == null) totals.uncorrectedPriorityCost += baseCost;
  }
  if (tokens > 0 && baseCost === 0) totals.unpricedTokens += tokens;
}

/** Collapse an accumulator into a comparable per-session summary. */
export function summarize(acc: CostAccumulator, meta: { id?: string; path?: string; kind: string }): SessionCost {
  const models = [...acc.byModel.values()].sort((a, b) => b.cost - a.cost);
  return {
    ...meta,
    cost: acc.cost,
    tokens: acc.tokens,
    models,
    unpricedModels: models.filter((m) => m.unpricedTokens > 0).map((m) => m.key),
    priorityTokens: models.reduce((sum, m) => sum + m.priorityTokens, 0),
    uncorrectedPriorityCost: models.reduce((sum, m) => sum + m.uncorrectedPriorityCost, 0),
  };
}

/** Sum a session collection into the footer's headline figure. */
export function combine(own: SessionCost, descendants: SessionCost[]): TreeCost {
  const all = [own, ...descendants];
  const totalTokens = createTokenTotals();
  let totalCost = 0;
  let uncorrectedPriorityCost = 0;
  const unpriced = new Set<string>();
  for (const session of all) {
    totalCost += session.cost;
    uncorrectedPriorityCost += session.uncorrectedPriorityCost;
    totalTokens.input += session.tokens.input;
    totalTokens.output += session.tokens.output;
    totalTokens.cacheRead += session.tokens.cacheRead;
    totalTokens.cacheWrite += session.tokens.cacheWrite;
    for (const key of session.unpricedModels) unpriced.add(key);
  }
  const reasons: string[] = [];
  if (uncorrectedPriorityCost > 0) {
    reasons.push("priority-tier turns priced at standard rates (set priorityMultiplier in gpt-fast-toggle.json)");
  }
  if (unpriced.size > 0) {
    reasons.push(`no price resolved for ${[...unpriced].join(", ")}`);
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

const HEADER_READ_BYTES = 16 * 1024;

/** Read a session file's first line without loading the whole file. */
export function readSessionHeader(path: string): SessionHeader | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(HEADER_READ_BYTES);
    const read = readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    const line = newline >= 0 ? text.slice(0, newline) : text;
    const parsed = JSON.parse(line);
    if (parsed?.type !== "session") return undefined;
    return { id: parsed.id, parentSession: parsed.parentSession, cwd: parsed.cwd };
  } catch {
    return undefined;
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

/** Every `.jsonl` file under `root`, at any depth, with the top-level folder as its kind. */
export function listSidecarSessionFiles(root: string, maxDepth = 8): Array<{ path: string; kind: string }> {
  const found: Array<{ path: string; kind: string }> = [];
  const walk = (dir: string, kind: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // missing or unreadable sidecar directory: nothing to add
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
  return found;
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
}

/**
 * Caching, incremental scanner over a session tree.
 *
 * Session files are append-only, so an unchanged file is never re-read and a grown
 * file is read only from its previous end. Unreadable, missing, and half-written
 * files degrade to the best available total instead of throwing.
 */
export class SessionTreeScanner {
  private readonly files = new Map<string, FileCacheEntry>();
  private lastStats: ScanStats = { filesRead: 0, filesDiscovered: 0 };

  constructor(private readonly price: PriceOptions = {}) {}

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

  /** Cost of one session file, folding only bytes appended since the last scan. */
  scanFile(path: string, kind: string, countedSessions?: ReadonlySet<string>): SessionCost | undefined {
    let stat: import("node:fs").Stats;
    try {
      stat = statSync(path);
    } catch {
      return undefined; // deleted between discovery and scan
    }
    const cached = this.files.get(path);
    const grewInPlace = cached != null && stat.size >= cached.size && stat.mtimeMs >= cached.mtimeMs;
    const entry: FileCacheEntry = grewInPlace ? cached : this.freshFileCache(cached?.header, cached?.reads ?? 0);
    this.files.set(path, entry);

    if (grewInPlace && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) {
      return summarize(entry.acc, { id: entry.header?.id, path, kind });
    }

    const chunk = this.readRange(path, entry.offset, stat.size, entry.decoder);
    if (chunk == null) {
      // Unreadable now; keep whatever was already folded.
      return summarize(entry.acc, { id: entry.header?.id, path, kind });
    }
    entry.reads += 1;
    this.lastStats.filesRead += 1;

    const text = entry.remainder + chunk;
    const lines = text.split("\n");
    // A file being appended to can end mid-line; hold it back until the rest arrives.
    entry.remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // torn or corrupt line: skip it rather than failing the scan
      }
      if (parsed?.type === "session") {
        entry.header = { id: parsed.id, parentSession: parsed.parentSession, cwd: parsed.cwd };
        continue;
      }
      accumulateEntry(entry.acc, parsed, { ...this.price, countedSessions });
    }
    // Offset tracks bytes consumed; the incomplete tail lives in `remainder`, so the
    // next read starts after it and no byte is ever folded twice.
    entry.offset = stat.size;
    entry.size = stat.size;
    entry.mtimeMs = stat.mtimeMs;
    return summarize(entry.acc, { id: entry.header?.id, path, kind });
  }

  private readRange(path: string, from: number, to: number, decoder: StringDecoder): string | undefined {
    if (to <= from) return "";
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const length = to - from;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, from);
      return decoder.write(buffer.subarray(0, read));
    } catch {
      return undefined;
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
   * the sidecar directory convention and a `parentSession` header holding either
   * a session id or a session file path. Cycles and repeats are impossible: a
   * session is admitted once, by resolved path and by id.
   */
  discover(rootFile: string | undefined, rootId: string | undefined): Array<{ path: string; kind: string; header?: SessionHeader }> {
    const results: Array<{ path: string; kind: string; header?: SessionHeader }> = [];
    if (!rootFile && !rootId) return results;

    const seenPaths = new Set<string>();
    const seenIds = new Set<string>();
    if (rootFile) seenPaths.add(resolveRealPath(rootFile));
    if (rootId) seenIds.add(rootId);

    // One directory listing serves every node: siblings link by header, not by location.
    const siblingsByParent = rootFile ? this.indexSiblingsByParent(dirname(rootFile), seenPaths) : new Map();

    const queue: Array<{ file?: string; id?: string }> = [{ file: rootFile, id: rootId }];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const candidates: Array<{ path: string; kind: string }> = [];
      if (node.file) candidates.push(...listSidecarSessionFiles(deriveSidecarRoot(node.file)));
      for (const key of [node.id, node.file].filter((v): v is string => !!v)) {
        for (const path of siblingsByParent.get(key) ?? []) candidates.push({ path, kind: "forks" });
      }

      for (const candidate of candidates) {
        const real = resolveRealPath(candidate.path);
        if (seenPaths.has(real)) continue;
        const header = readSessionHeader(candidate.path);
        if (header?.id && seenIds.has(header.id)) continue;
        seenPaths.add(real);
        if (header?.id) seenIds.add(header.id);
        results.push({ ...candidate, header });
        queue.push({ file: candidate.path, id: header?.id });
      }
    }
    this.lastStats.filesDiscovered = results.length;
    return results;
  }

  private indexSiblingsByParent(dir: string, skip: Set<string>): Map<string, string[]> {
    const index = new Map<string, string[]>();
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return index;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      if (skip.has(resolveRealPath(path))) continue;
      const header = this.cachedHeader(path);
      if (!header?.parentSession) continue;
      const list = index.get(header.parentSession);
      if (list) list.push(path);
      else index.set(header.parentSession, [path]);
    }
    return index;
  }

  private cachedHeader(path: string): SessionHeader | undefined {
    const cached = this.files.get(path);
    if (cached?.header) return cached.header;
    const header = readSessionHeader(path);
    if (header) {
      const entry = cached ?? this.freshFileCache();
      entry.header = header;
      this.files.set(path, entry);
    }
    return header;
  }

  /**
   * Whole-tree cost: the live parent's own entries plus every descendant on disk.
   * `ownEntries` comes from the live session manager so the parent's own file —
   * the largest and most frequently appended — is never re-read.
   */
  scanTree(args: { ownEntries: Iterable<any>; sessionFile?: string; sessionId?: string }): TreeCost {
    this.lastStats = { filesRead: 0, filesDiscovered: 0 };

    // Descendants first: their ids tell the parent's fold which tool results merely
    // restate a child session's spend.
    const descendants: SessionCost[] = [];
    const counted = new Set<string>();
    for (const found of this.discover(args.sessionFile, args.sessionId)) {
      const cost = this.scanFile(found.path, found.kind);
      if (!cost) continue;
      descendants.push(cost);
      if (cost.id) counted.add(cost.id);
      if (cost.path) counted.add(cost.path);
    }
    descendants.sort((a, b) => b.cost - a.cost);

    const ownAcc = createAccumulator();
    for (const entry of args.ownEntries) accumulateEntry(ownAcc, entry, { ...this.price, countedSessions: counted });
    const own = summarize(ownAcc, { id: args.sessionId, path: args.sessionFile, kind: "own" });

    return combine(own, descendants);
  }
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
