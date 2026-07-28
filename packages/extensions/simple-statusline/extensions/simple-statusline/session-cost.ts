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
import { basename, dirname, join, sep } from "node:path";
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
  /**
   * False when the call was billed but no rate was available to value it — speech
   * charged per character with no configured rate, for instance. The cost then reads
   * $0 and the surfaces mark the total approximate rather than reporting it low.
   */
  priced?: boolean;
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
  /** True when real usage here was counted at $0 because no rate could be resolved. */
  unpriced: boolean;
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
  /** Dedupe keys already counted, so a re-read or a duplicated record cannot inflate. */
  countedKeys: Set<string>;
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
  /** Premium for priority-tier turns that is missing from `totalCost`. */
  uncorrectedPriorityCost: number;
  /** Session files whose spend could not be read, so it is missing from the total. */
  unreadableSessions: number;
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
 */
export function combine(own: SessionCost, descendants: SessionCost[], unreadableSessions = 0): TreeCost {
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
  if (unreadableSessions > 0) {
    reasons.push(`${unreadableSessions} session file${unreadableSessions === 1 ? "" : "s"} could not be read, so their spend is missing`);
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
  /** Files whose bytes could not be read this scan, so their spend is missing. */
  filesUnreadable: number;
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
  private lastStats: ScanStats = { filesRead: 0, filesDiscovered: 0, filesUnreadable: 0 };

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

  /**
   * Cost of one session file, folding only bytes appended since the last scan.
   *
   * `fold` carries the tree-level suppression sets. They matter only while an entry is
   * first folded — a fork's copied history is fixed when the fork is created — so a
   * cached file needs no re-evaluation when they grow.
   */
  scanFile(path: string, kind: string, fold: Omit<FoldOptions, keyof PriceOptions> = {}): SessionCost | undefined {
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
      // Unreadable now; keep whatever was already folded and report the gap, so a
      // total missing this file's spend is not presented as exact.
      this.lastStats.filesUnreadable += 1;
      return summarize(entry.acc, { id: entry.header?.id, path, kind });
    }
    entry.reads += 1;
    this.lastStats.filesRead += 1;

    const text = entry.remainder + chunk.text;
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

  private readRange(path: string, from: number, to: number, decoder: StringDecoder): { text: string; bytesRead: number } | undefined {
    if (to <= from) return { text: "", bytesRead: 0 };
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const length = to - from;
      const buffer = Buffer.allocUnsafe(length);
      const read = readSync(fd, buffer, 0, length, from);
      return { text: decoder.write(buffer.subarray(0, read)), bytesRead: read };
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
    const add = (path: string, kind: string) => {
      const real = resolveRealPath(path);
      if (skip.has(real) || byPath.has(real)) return;
      byPath.set(real, { path, real, kind, header: this.cachedHeader(path) });
    };
    for (const file of listSidecarSessionFiles(deriveSidecarRoot(rootFile))) add(file.path, file.kind);
    try {
      for (const name of readdirSync(dirname(rootFile))) {
        if (name.endsWith(".jsonl")) add(join(dirname(rootFile), name), "forks");
      }
    } catch {
      // Session directory unreadable: sidecar candidates still stand.
    }
    return [...byPath.values()];
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
    this.lastStats = { filesRead: 0, filesDiscovered: 0, filesUnreadable: 0 };

    // Discovery first, so the parent's fold knows which tool results merely restate a
    // child session's spend.
    const found = this.discover(args.sessionFile, args.sessionId);
    const countedSessions = new Set<string>();
    for (const child of found) {
      if (child.header?.id) countedSessions.add(child.header.id);
      countedSessions.add(child.path);
    }

    // The parent is folded before its descendants so its own turns own their identity:
    // a fork that copied them contributes only what it added afterwards.
    const ownAcc = createAccumulator();
    for (const entry of args.ownEntries) accumulateEntry(ownAcc, entry, { ...this.price, countedSessions });
    const own = summarize(ownAcc, { id: args.sessionId, path: args.sessionFile, kind: "own" });

    const excludeKeys = new Set(ownAcc.countedKeys);
    const descendants: SessionCost[] = [];
    for (const child of found) {
      const cost = this.scanFile(child.path, child.kind, { countedSessions, excludeKeys });
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
