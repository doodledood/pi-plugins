// One session owns a watched conversation on this machine. A lock is a small file under
// ~/.pi/agent/slack-companion/locks/; a lock whose holder process is gone is reclaimed.
// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md (routing).
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockHolder {
  pid: number;
  sessionId: string;
  at: number;
  /** The holder let the lock go; the file stays so the next session learns who answered last. */
  released?: boolean;
}

export type ProcessAlive = (pid: number) => boolean;

export const processAlive: ProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** How long a released lock's marker is kept: long enough for any resumed session to learn of a hand-over. */
export const RELEASED_MARKER_MS = 30 * 24 * 60 * 60 * 1000;

export type Acquired =
  /** `previous`: another session held this conversation since this one last did (it may have answered there). */
  | { ok: true; previous?: LockHolder }
  | { ok: false; holder: LockHolder };

/**
 * A holder refreshes its lock on every poll. A lock whose process is gone, or that was not
 * refreshed for `staleAfterMs` (a reused pid after a reboot), is reclaimed. Every write is a
 * whole-file rename, so a reader never sees half a lock; a lock is taken over by renaming it
 * away first, so two sessions cannot both take the same one.
 */
export class LockManager {
  constructor(
    private readonly dir: string,
    private readonly self: Omit<LockHolder, "at" | "released">,
    private readonly alive: ProcessAlive = processAlive,
    private readonly staleAfterMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private readFile(path: string): LockHolder | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!value || typeof value !== "object") return undefined;
      const h = value as Record<string, unknown>;
      return typeof h.pid === "number" && typeof h.sessionId === "string" && typeof h.at === "number" ? (h as unknown as LockHolder) : undefined;
    } catch {
      return undefined;
    }
  }

  private mine(holder: LockHolder | undefined): boolean {
    return Boolean(holder && !holder.released && holder.sessionId === this.self.sessionId && holder.pid === this.self.pid);
  }

  /** Write the whole file at once: a reader sees the old lock or the new one, never part of one. */
  private write(path: string, holder: LockHolder): void {
    const temp = `${path}.${this.self.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(holder), { mode: 0o600 });
    renameSync(temp, path);
  }

  /**
   * Take the lock, or return who holds it. Re-acquiring one's own lock succeeds. A free lock that
   * another session held last (released, or left behind by a dead process) is taken with that
   * session named as `previous`.
   */
  acquire(key: string): Acquired {
    mkdirSync(this.dir, { recursive: true });
    const path = this.path(key);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const fresh = `${path}.${this.self.pid}.${randomUUID()}.tmp`;
      writeFileSync(fresh, JSON.stringify({ ...this.self, at: this.now() }), { mode: 0o600 });
      try {
        linkSync(fresh, path); // fails when a lock file exists: the take is atomic
        rmSync(fresh, { force: true });
        return { ok: true };
      } catch (error) {
        rmSync(fresh, { force: true });
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = this.readFile(path);
      if (this.mine(holder)) return { ok: true };
      if (!holder) {
        // Unreadable: a lock is written whole, so this is damage, not a write in progress. Held
        // until it is older than the stale time, then reclaimed.
        // File times are on the real clock, whatever clock the holders use.
        const age = Date.now() - (statOrUndefined(path)?.mtimeMs ?? 0);
        if (age < this.staleAfterMs) return { ok: false, holder: { pid: -1, sessionId: "unknown", at: this.now() } };
      } else if (!holder.released && this.alive(holder.pid) && this.now() - holder.at < this.staleAfterMs) {
        return { ok: false, holder };
      }
      // Free (released, stale, or damaged): take it over by renaming it away, then check that what
      // was renamed is what was judged free; another session may have replaced it in between.
      const aside = `${path}.${this.self.pid}.${randomUUID()}.old`;
      try {
        renameSync(path, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = this.readFile(aside);
      if (JSON.stringify(moved) !== JSON.stringify(holder)) {
        // Not the lock judged free: put it back (unless yet another lock appeared) and look again.
        try {
          linkSync(aside, path);
        } catch {
          // a newer lock is in place; the one renamed away is gone either way
        }
        rmSync(aside, { force: true });
        continue;
      }
      rmSync(aside, { force: true });
      const created = this.acquireFree(path);
      if (!created) continue;
      const previous = holder && holder.sessionId !== this.self.sessionId ? holder : undefined;
      return previous ? { ok: true, previous } : { ok: true };
    }
    const holder = this.readFile(path);
    return { ok: false, holder: holder ?? { pid: -1, sessionId: "unknown", at: 0 } };
  }

  private acquireFree(path: string): boolean {
    const fresh = `${path}.${this.self.pid}.${randomUUID()}.tmp`;
    writeFileSync(fresh, JSON.stringify({ ...this.self, at: this.now() }), { mode: 0o600 });
    try {
      linkSync(fresh, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    } finally {
      rmSync(fresh, { force: true });
    }
  }

  /**
   * Keep an owned lock fresh. False when the lock is no longer this session's: another session
   * holds it, or held it and let it go (it took over a lock this session left unrefreshed, for
   * example across a long sleep). Either way that session may have answered here, so this one must
   * stop rather than take the lock back unawares.
   */
  refresh(key: string): boolean {
    const path = this.path(key);
    if (!this.mine(this.readFile(path))) return false;
    this.write(path, { ...this.self, at: this.now() });
    return true;
  }

  /** Let the lock go, leaving a marker that names this session as the last to answer there. */
  release(key: string): void {
    const path = this.path(key);
    if (this.mine(this.readFile(path))) this.write(path, { ...this.self, at: this.now(), released: true });
  }

  /** Remove released markers older than RELEASED_MARKER_MS, and temp files a crash left behind. */
  sweep(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.dir, name);
      const age = Date.now() - (statOrUndefined(path)?.mtimeMs ?? Date.now()); // file times: the real clock
      if (/\.(tmp|old)$/.test(name) && age > 60_000) rmSync(path, { force: true });
      else if (name.endsWith(".json") && this.readFile(path)?.released && age > RELEASED_MARKER_MS) rmSync(path, { force: true });
    }
  }
}

function statOrUndefined(path: string): { mtimeMs: number } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
