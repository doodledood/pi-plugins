/**
 * The substrate, as operations.
 *
 * Every consumer — the reporter inside each session, headless triage and drill
 * workers, and the seat — goes through here, and every call re-reads from disk.
 * Nothing in HQ holds the queue in memory as its source of truth (INV-G10):
 * killing the seat mid-queue must lose nothing.
 */

import type { PacketStatus } from "./types.ts";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  appendJsonl,
  atomicWriteJson,
  isPidAlive,
  createWriteQueue,
  ensureLayout,
  type ErrorReporter,
  moveFile,
  newId,
  pathExists,
  readJsonFile,
  readJsonl,
  scanJsonDir,
  silentReporter,
  withFileLock,
} from "./io.ts";
import {
  archivedPacketPath,
  hqPaths,
  packetPath,
  sessionStatePath,
} from "./paths.ts";
import { parseStopRecord } from "./stops.ts";
import {
  AUDIT_VERSION,
  type AuditRecord,
  DEFECT_VERSION,
  type DefectRecord,
  type DomainStats,
  emptyDomainStats,
  type GraduationState,
  type Packet,
  packetBarViolations,
  parseAuditRecord,
  parseDefectRecord,
  parseGraduationState,
  parsePacket,
  parseRuling,
  parseSessionState,
  type Ruling,
  type SessionState,
} from "./types.ts";

export interface StoreOptions {
  root: string;
  now?: () => Date;
  onError?: ErrorReporter;
}

export class HqStore {
  private readonly queue = createWriteQueue();
  private readonly now: () => Date;
  private readonly onError: ErrorReporter;
  readonly root: string;

  constructor(options: StoreOptions) {
    this.root = options.root;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError ?? silentReporter;
  }

  get paths() {
    return hqPaths(this.root);
  }

  async ensure(): Promise<void> {
    await ensureLayout(this.root);
  }

  // ---- fleet -------------------------------------------------------------

  async publishSessionState(state: SessionState): Promise<void> {
    const path = sessionStatePath(this.root, state.sessionId);
    await this.queue(path, async () => {
      await atomicWriteJson(path, state);
    });
  }

  /**
   * Read-modify-write of one session row, so two writers can own different fields
   * of it. The reporter owns the lifecycle fields; the titler owns the title;
   * drills own the marker set. A whole-record write from any of them would
   * silently drop the others' work, and the read has to happen inside the write
   * queue or two patches can interleave.
   */
  async mutateSessionState(
    sessionId: string,
    mutate: (current: SessionState) => SessionState,
  ): Promise<SessionState | undefined> {
    const path = sessionStatePath(this.root, sessionId);
    // Queued in-process and locked across processes: the row has three writers in
    // three processes (the session, the titler, a drill), and each owns different
    // fields, so an interleaved read-modify-write would revert someone's work.
    return this.queue(path, () =>
      withFileLock(path, async () => {
        const current = await readJsonFile(path, parseSessionState, this.onError);
        if (!current) return undefined;
        const next: SessionState = { ...mutate(current), sessionId: current.sessionId };
        await atomicWriteJson(path, next);
        return next;
      }, { onError: this.onError }));
  }

  /** Patches named fields. `undefined` values are ignored rather than written. */
  async patchSessionState(
    sessionId: string,
    patch: Partial<SessionState>,
  ): Promise<SessionState | undefined> {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<SessionState>;
    return this.mutateSessionState(sessionId, (current) => ({ ...current, ...defined }));
  }

  async readSessionState(sessionId: string): Promise<SessionState | undefined> {
    return readJsonFile(
      sessionStatePath(this.root, sessionId),
      parseSessionState,
      this.onError,
    );
  }

  /** Every published session, healthy records only, sorted by id. */
  async listFleet(): Promise<SessionState[]> {
    const scan = await scanJsonDir(
      this.paths.sessions,
      parseSessionState,
      (record) => record.sessionId,
      this.onError,
    );
    return scan.records.map((entry) => entry.record);
  }

  // ---- queue -------------------------------------------------------------

  /**
   * Writes a packet the machinery generated. The bar is enforced here rather
   * than at presentation time so an under-specified packet is parked as `held`
   * instead of reaching the user (INV-G11).
   */
  /**
   * What makes two packets the same question. Rulings on repeated stops in one
   * session produce the same proposal over and over, and three identical "add this
   * rule" packets cost three decisions to change one thing.
   */
  static dedupeKey(
    packet: Pick<Packet, "domain" | "title" | "question" | "proposal" | "sourceSessionId">,
  ): string {
    const flatten = (text: string) =>
      text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const proposal = packet.proposal;
    // A proposal acts on doctrine, so the same rule from any session is one decision.
    // A question resumes the session it came from, so the same question about two
    // sessions is two decisions: ruling on one would strand the other.
    return proposal
      ? `proposal:${proposal.scope}:${proposal.section}:${flatten(proposal.ruleText)}`
      : `question:${packet.sourceSessionId}:${flatten(packet.domain)}:${flatten(packet.title)}:${
        flatten(packet.question)
      }`;
  }

  /** The packet already waiting on this exact question, if there is one. */
  async findOpenDuplicate(
    candidate: Pick<Packet, "domain" | "title" | "question" | "proposal" | "sourceSessionId">,
  ): Promise<Packet | undefined> {
    const key = HqStore.dedupeKey(candidate);
    const open = await this.listQueue();
    return open.find(
      (packet) =>
        (packet.status === "pending" || packet.status === "held" || packet.status === "drilling") &&
        HqStore.dedupeKey(packet) === key,
    );
  }

  async createPacket(
    draft: Omit<Packet, "version" | "id" | "createdAt" | "updatedAt" | "generation" | "status"> & {
      id?: string;
      status?: Packet["status"];
    },
  ): Promise<{ packet: Packet; violations: ReturnType<typeof packetBarViolations> }> {
    // One question, one decision: an identical packet already waiting is the answer
    // to this one, so the caller gets that packet instead of a second copy of it.
    const existing = await this.findOpenDuplicate(draft);
    if (existing) return { packet: existing, violations: [] };

    const at = this.now().toISOString();
    const candidate: Packet = {
      ...draft,
      version: 1,
      id: draft.id ?? newId("pkt", this.now()),
      createdAt: at,
      updatedAt: at,
      generation: 1,
      status: "pending",
    };
    const violations = packetBarViolations(candidate);
    const packet: Packet = {
      ...candidate,
      status: violations.length > 0 ? "held" : (draft.status ?? "pending"),
    };
    // Worked out before the write, not patched in afterwards: the caller holds the
    // packet it is handed, and a second write here would leave that copy stale.
    const stale = packet.status === "pending" ? await this.staleForSession(packet) : [];
    const written: Packet = stale.length > 0
      ? { ...packet, supersedes: stale.map((other) => other.title) }
      : packet;

    const path = packetPath(this.root, written.id);
    await this.queue(path, async () => {
      await atomicWriteJson(path, written);
    });
    await this.withdrawSuperseded(stale, written.id);
    return { packet: written, violations };
  }

  /**
   * A session is one line of work, so it has at most one open decision. Once a later
   * stop in the same session has a presentable packet, the earlier ones are stale: the
   * session has moved past what they asked — HQ continued it, or the user did — and
   * ruling on one would resume a session that is no longer where the question left it.
   *
   * Rule proposals are exempt on both sides: they act on doctrine, not on the session,
   * so nothing the session does afterwards makes them stale.
   */
  private async staleForSession(packet: Packet): Promise<Packet[]> {
    if (packet.proposal) return [];
    return (await this.listQueue()).filter(
      (other) =>
        other.id !== packet.id &&
        !other.proposal &&
        other.sourceSessionId === packet.sourceSessionId &&
        (other.status === "pending" || other.status === "held" || other.status === "drilling") &&
        other.createdAt <= packet.createdAt,
    );
  }

  /**
   * Withdraws what a packet replaced. The superseded packets are kept and archived
   * rather than deleted, and each names what replaced it, so no question the user was
   * asked disappears without trace.
   */
  private async withdrawSuperseded(stale: readonly Packet[], byId: string): Promise<void> {
    for (const other of stale) {
      await this.updatePacket(other.id, (current) => ({
        ...current,
        status: "withdrawn",
        supersededBy: byId,
      }));
      await this.archivePacket(other.id);
    }
  }

  async readPacket(packetId: string): Promise<Packet | undefined> {
    const live = await readJsonFile(
      packetPath(this.root, packetId),
      parsePacket,
      this.onError,
    );
    if (live) return live;
    return readJsonFile(
      archivedPacketPath(this.root, packetId),
      parsePacket,
      this.onError,
    );
  }

  /**
   * Read-modify-write a packet, bumping its generation. The generation is what
   * a ruling names, so a packet that changed under a stale presentation can be
   * detected rather than answered blindly.
   */
  async updatePacket(
    packetId: string,
    mutate: (packet: Packet) => Packet,
  ): Promise<Packet | undefined> {
    const path = packetPath(this.root, packetId);
    let statusBefore: PacketStatus | undefined;
    let stale: Packet[] = [];
    // Locked as well as queued: the seat, a drill worker and a triage worker are
    // separate processes and all read-modify-write packets, so the in-process
    // queue alone would let one overwrite another's annotation or patch.
    return this.queue(path, () =>
      withFileLock(path, async () => {
      const current = await readJsonFile(path, parsePacket, this.onError);
      if (!current) return undefined;
      statusBefore = current.status;
      const mutated = mutate(current);
      const next: Packet = {
        ...mutated,
        id: current.id,
        createdAt: current.createdAt,
        generation: current.generation + 1,
        updatedAt: this.now().toISOString(),
      };
      // Re-check the bar on every edit, in both directions: an edit can never
      // leave a sub-bar packet presentable, and a held packet whose gaps were
      // filled becomes presentable without a separate promotion step.
      const violations = packetBarViolations(next);
      const guarded: Packet = violations.length > 0
        ? (next.status === "pending" ? { ...next, status: "held" } : next)
        : (next.status === "held" ? { ...next, status: "pending" } : next);
      // A held packet a drill just filled is the session's live question now, so the
      // same supersession applies to the edit that presents it, not only to creation.
      // Withdrawing is not a presentable status, so this cannot cascade.
      const becamePresentable = guarded.status === "pending" && statusBefore !== "pending";
      stale = becamePresentable ? await this.staleForSession(guarded) : [];
      const written: Packet = stale.length > 0
        ? { ...guarded, supersedes: [...(guarded.supersedes ?? []), ...stale.map((o) => o.title)] }
        : guarded;
      await atomicWriteJson(path, written);
      return written;
      }, { onError: this.onError })).then(async (result) => {
      // Outside the lock on this packet, so the packets being withdrawn take their
      // own locks without one write waiting on another.
      if (result) await this.withdrawSuperseded(stale, result.id);
      return result;
    });
  }

  /** Everything still in the queue, in any live status. */
  async listQueue(): Promise<Packet[]> {
    const scan = await scanJsonDir(
      this.paths.queue,
      parsePacket,
      (record) => record.id,
      this.onError,
    );
    return scan.records.map((entry) => entry.record);
  }

  /** Only packets that may be shown to the user: pending, and bar-clearing. */
  async listPresentable(): Promise<Packet[]> {
    const all = await this.listQueue();
    return all.filter(
      (packet) => packet.status === "pending" && packetBarViolations(packet).length === 0,
    );
  }

  // ---- rulings, audit, defects ------------------------------------------

  /**
   * Records the ruling first, then archives the packet: the authoritative
   * record exists before the work becomes eligible to continue, so a crash can
   * never leave an unrecorded ruling that already moved work forward.
   */
  async recordRuling(ruling: Ruling, options: { archive?: boolean } = {}): Promise<void> {
    await this.queue(this.paths.rulingsLog, async () => {
      await appendJsonl(this.paths.rulingsLog, ruling);
    });
    if (options.archive === false) return;
    if (ruling.form === "defer") return;
    await this.updatePacket(ruling.packetId, (packet) => ({ ...packet, status: "ruled" }));
    await this.archivePacket(ruling.packetId);
  }

  async archivePacket(packetId: string): Promise<void> {
    const from = packetPath(this.root, packetId);
    const to = archivedPacketPath(this.root, packetId);
    try {
      await moveFile(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.onError(`Unable to archive packet ${packetId}`, error);
      }
    }
  }

  /**
   * Rulings are appended twice when routing follows recording, so the same id can
   * appear more than once. The last append wins: it is the one that knows where
   * the ruling was carried.
   */
  async listRulings(): Promise<Ruling[]> {
    const all = await readJsonl(this.paths.rulingsLog, parseRuling, this.onError);
    const latest = new Map<string, Ruling>();
    for (const ruling of all) latest.set(ruling.id, ruling);
    return [...latest.values()];
  }

  async appendAudit(record: Omit<AuditRecord, "version">): Promise<void> {
    await this.queue(this.paths.auditLog, async () => {
      await appendJsonl(this.paths.auditLog, { version: AUDIT_VERSION, ...record });
    });
  }

  async readAuditLines(): Promise<AuditRecord[]> {
    return readJsonl(this.paths.auditLog, parseAuditRecord, this.onError);
  }

  /**
   * Counts distinct records dated `day`. The logs are append-only and roughly
   * time-ordered, so the scan walks backwards and stops parsing at the first
   * older line; it still reads the file, so the saving is parse work, not IO.
   *
   * Distinctness matters for rulings: a ruling is appended twice (once when
   * recorded, once when its routing is known), and both lines share an id.
   */
  async countToday(day: string): Promise<{ rulings: number; audits: number }> {
    const [rulings, audits] = await Promise.all([
      countTailMatching(this.paths.rulingsLog, day, (line) => !line.includes('"form":"defer"')),
      countTailMatching(this.paths.auditLog, day, () => true),
    ]);

    return { rulings, audits };
  }

  async appendDefect(record: Omit<DefectRecord, "version">): Promise<void> {
    await this.queue(this.paths.defectsLog, async () => {
      await appendJsonl(this.paths.defectsLog, { version: DEFECT_VERSION, ...record });
    });
  }

  async readDefects(): Promise<DefectRecord[]> {
    return readJsonl(this.paths.defectsLog, parseDefectRecord, this.onError);
  }

  // ---- graduation state -------------------------------------------------

  async readGraduation(): Promise<GraduationState> {
    return (await this.readGraduationStrict()) ?? { version: 1, domains: {} };
  }

  /** Absent and unreadable are different: undefined means "exists but untrusted". */
  private async readGraduationStrict(): Promise<GraduationState | undefined> {
    const state = await readJsonFile(
      this.paths.graduation,
      parseGraduationState,
      this.onError,
    );
    if (state) return state;
    return (await pathExists(this.paths.graduation)) ? undefined : { version: 1, domains: {} };
  }

  async updateDomain(
    domain: string,
    mutate: (stats: DomainStats) => DomainStats,
  ): Promise<DomainStats> {
    return this.queue(this.paths.graduation, async () => {
      let state = await this.readGraduationStrict();
      if (!state) {
        // Overwriting a file we could not parse would destroy every grant it holds.
        // Keep it, name it, and start fresh beside it.
        const aside = `${this.paths.graduation}.unreadable-${this.now().toISOString().replace(/[:.]/g, "-")}`;
        await moveFile(this.paths.graduation, aside);
        this.onError(
          `Could not read ${this.paths.graduation}; kept it at ${aside} and started fresh`,
          new Error("graduation state unreadable"),
        );
        state = { version: 1, domains: {} };
      }
      const current = state.domains[domain] ?? emptyDomainStats(domain);
      const next = { ...mutate(current), domain };
      const updated: GraduationState = {
        version: 1,
        domains: { ...state.domains, [domain]: next },
      };
      await atomicWriteJson(this.paths.graduation, updated);
      return next;
    });
  }

  async isGraduated(domain: string): Promise<boolean> {
    const state = await this.readGraduation();
    return state.domains[domain]?.graduated === true;
  }

  // ---- doctrine files ---------------------------------------------------

  async readTextFile(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.onError(`Unable to read ${path}`, error);
      }
      return undefined;
    }
  }
}

/**
 * Reads a log backwards and counts lines whose `at` falls on `day`, stopping at
 * the first older line. Bounded by the day's own volume rather than the log's.
 */
async function countTailMatching(
  path: string,
  day: string,
  accept: (line: string) => boolean,
): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  const lines = text.split("\n");
  const seen = new Set<string>();
  let count = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    const at = /"at":"([^"]+)"/.exec(line)?.[1];
    if (!at) continue;
    const lineDay = at.slice(0, 10);
    if (lineDay > day) continue;
    if (lineDay < day) break;
    if (!accept(line)) continue;
    // Records that carry an id are counted once, however many times they were
    // appended; records without one (audits) are counted per line.
    const id = /"id":"([^"]+)"/.exec(line)?.[1];
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    count += 1;
  }
  return count;
}

/** Removes state that has aged out, so the glance and the sweeps stay bounded. */
export interface RetentionResult {
  sessions: number;
  stops: number;
  logs: number;
}

/**
 * Retention: HQ's own bookkeeping is not history the user asked to keep. Session
 * rows for dead sessions, finished stop records, and worker logs are dropped once
 * they are older than `days`, which keeps the board readable and the sweeps cheap.
 * Packets, rulings, audits, defects and doctrine are never touched.
 */
export async function pruneState(
  root: string,
  options: { days: number; now: Date; alive?: (pid: number) => boolean },
): Promise<RetentionResult> {
  const cutoff = options.now.getTime() - options.days * 86_400_000;
  const alive = options.alive ?? isPidAlive;
  const paths = hqPaths(root);
  const result: RetentionResult = { sessions: 0, stops: 0, logs: 0 };

  const sessions = await scanJsonDir(
    paths.sessions,
    parseSessionState,
    (record) => record.sessionId,
  );
  for (const { path, record } of sessions.records) {
    const old = Date.parse(record.lastEventAt) < cutoff;
    if (!old || alive(record.pid)) continue;
    await rm(path, { force: true });
    result.sessions += 1;
  }

  const stops = await scanJsonDir(paths.stops, parseStopRecord, (record) => record.stopId);
  for (const { path, record } of stops.records) {
    if (record.status !== "done") continue;
    if (Date.parse(record.createdAt) >= cutoff) continue;
    await rm(path, { force: true });
    await rm(`${path.slice(0, -".json".length)}.claim`, { force: true });
    result.stops += 1;
  }

  try {
    for (const name of await readdir(paths.logs)) {
      const path = join(paths.logs, name);
      const info = await stat(path).catch(() => undefined);
      if (!info || info.mtimeMs >= cutoff) continue;
      await rm(path, { force: true });
      result.logs += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return result;
}

/**
 * Returns packets that have been drilling longer than `minutes` to the queue.
 *
 * A drill worker that dies without submitting would otherwise park its packet in
 * `drilling` forever, which costs the user the decision — the same loss the stop
 * sweep exists to prevent, one layer up. The packet comes back annotated so the
 * user can see that the answer never arrived.
 */
export async function reopenStalledDrills(
  store: HqStore,
  options: { minutes: number; now: Date },
): Promise<string[]> {
  const cutoff = options.now.getTime() - options.minutes * 60_000;
  const reopened: string[] = [];

  // A completion drill is started on a packet that is *held*, not drilling, so
  // recovery keys off the origin row's markers as well as the packet status —
  // otherwise a dead completion drill strands the packet and leaves the board
  // claiming a drill is still running.
  const markers = new Map<string, string[]>();
  for (const state of await store.listFleet()) {
    for (const packetId of state.drillingPacketIds) {
      markers.set(packetId, [...(markers.get(packetId) ?? []), state.sessionId]);
    }
  }

  for (const packet of await store.listQueue()) {
    const marked = markers.has(packet.id);
    if (packet.status !== "drilling" && !(packet.status === "held" && marked)) continue;
    if (Date.parse(packet.updatedAt) >= cutoff) continue;
    await store.updatePacket(packet.id, (current) => ({
      ...current,
      // A held packet stays held: its gaps are still unfilled. The bar decides
      // whether the annotation made it presentable.
      status: current.status === "drilling" ? "pending" : current.status,
      annotations: [
        ...current.annotations,
        {
          at: options.now.toISOString(),
          question: "(drill did not report)",
          answer:
            `No answer came back within ${options.minutes} minutes, so this is back in the queue undrilled. Ask again if you still want it looked into.`,
          quotes: [],
          tier: 1 as const,
        },
      ],
    }));
    for (const sessionId of markers.get(packet.id) ?? []) {
      await store.mutateSessionState(sessionId, (current) => ({
        ...current,
        drillingPacketIds: current.drillingPacketIds.filter((id) => id !== packet.id),
      }));
    }
    reopened.push(packet.id);
  }
  return reopened;
}
