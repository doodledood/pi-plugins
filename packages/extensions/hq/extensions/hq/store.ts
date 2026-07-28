/**
 * The substrate, as operations.
 *
 * Every consumer — the reporter inside each session, headless triage and drill
 * workers, and the seat — goes through here, and every call re-reads from disk.
 * Nothing in HQ holds the queue in memory as its source of truth (INV-G10):
 * killing the seat mid-queue must lose nothing.
 */

import { readFile } from "node:fs/promises";
import {
  appendJsonl,
  atomicWriteJson,
  createWriteQueue,
  ensureLayout,
  type ErrorReporter,
  moveFile,
  newId,
  readJsonFile,
  readJsonl,
  scanJsonDir,
  silentReporter,
} from "./io.ts";
import {
  archivedPacketPath,
  hqPaths,
  packetPath,
  sessionStatePath,
} from "./paths.ts";
import {
  type AuditRecord,
  type DefectRecord,
  type DomainStats,
  emptyDomainStats,
  type GraduationState,
  type Packet,
  packetBarViolations,
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
  async createPacket(
    draft: Omit<Packet, "version" | "id" | "createdAt" | "updatedAt" | "generation" | "status"> & {
      id?: string;
      status?: Packet["status"];
    },
  ): Promise<{ packet: Packet; violations: ReturnType<typeof packetBarViolations> }> {
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
    const path = packetPath(this.root, packet.id);
    await this.queue(path, async () => {
      await atomicWriteJson(path, packet);
    });
    return { packet, violations };
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
    return this.queue(path, async () => {
      const current = await readJsonFile(path, parsePacket, this.onError);
      if (!current) return undefined;
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
      await atomicWriteJson(path, guarded);
      return guarded;
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
  async recordRuling(ruling: Ruling): Promise<void> {
    await this.queue(this.paths.rulingsLog, async () => {
      await appendJsonl(this.paths.rulingsLog, ruling);
    });
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

  async listRulings(): Promise<Ruling[]> {
    return readJsonl(this.paths.rulingsLog, parseRuling, this.onError);
  }

  async appendAudit(record: AuditRecord): Promise<void> {
    await this.queue(this.paths.auditLog, async () => {
      await appendJsonl(this.paths.auditLog, record);
    });
  }

  async readAuditLines(): Promise<AuditRecord[]> {
    return readJsonl(
      this.paths.auditLog,
      (value) => (typeof value === "object" && value !== null ? (value as AuditRecord) : undefined),
      this.onError,
    );
  }

  async appendDefect(record: DefectRecord): Promise<void> {
    await this.queue(this.paths.defectsLog, async () => {
      await appendJsonl(this.paths.defectsLog, record);
    });
  }

  async readDefects(): Promise<DefectRecord[]> {
    return readJsonl(
      this.paths.defectsLog,
      (value) => (typeof value === "object" && value !== null ? (value as DefectRecord) : undefined),
      this.onError,
    );
  }

  // ---- graduation state -------------------------------------------------

  async readGraduation(): Promise<GraduationState> {
    const state = await readJsonFile(
      this.paths.graduation,
      parseGraduationState,
      this.onError,
    );
    return state ?? { version: 1, domains: {} };
  }

  async updateDomain(
    domain: string,
    mutate: (stats: DomainStats) => DomainStats,
  ): Promise<DomainStats> {
    return this.queue(this.paths.graduation, async () => {
      const state = await this.readGraduation();
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
