// One session owns a watched conversation on this machine. Each conversation has a folder of
// numbered lock files under ~/.pi/agent/slack-companion/locks/; the highest number is the lock.
// Taking a lock is creating the next number, which only one session can do, so two sessions never
// both win. A lock is taken from its holder only when that holder's process is gone (or the
// machine restarted since it was written): never from a live session, however long it slept.
// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md (routing).
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";

export interface LockHolder {
  pid: number;
  sessionId: string;
  /** The machine's start, in minutes since 1970: a holder from before a restart is gone. */
  boot: number;
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

/** The machine's start, in minutes since 1970 (two readings may differ by one). */
export function bootMinute(): number {
  return Math.round((Date.now() - uptime() * 1000) / 60_000);
}

/** How long an unreadable lock file is respected: a lock being written reads empty for a moment. */
export const DAMAGED_LOCK_MS = 60_000;

export type Acquired =
  | { ok: true }
  /** Another live session holds it. */
  | { ok: false; holder: LockHolder }
  /** The lock file cannot be read (being written, or damaged); it is respected for DAMAGED_LOCK_MS. */
  | { ok: false; damaged: true };

export class LockManager {
  private readonly self: LockHolder;

  constructor(
    private readonly dir: string,
    self: Omit<LockHolder, "boot">,
    private readonly alive: ProcessAlive = processAlive,
    boot: number = bootMinute(),
  ) {
    this.self = { ...self, boot };
  }

  private folder(key: string): string {
    return join(this.dir, key.replace(/[^A-Za-z0-9._-]/g, "_"));
  }

  /** The lock files of a conversation, highest number last. */
  private generations(folder: string): number[] {
    try {
      return readdirSync(folder).map((name) => /^(\d+)\.json$/.exec(name)?.[1]).filter((n): n is string => n !== undefined).map(Number).sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /** The current lock: its number and holder (undefined when the file cannot be read). */
  private top(folder: string): { generation: number; holder: LockHolder | undefined; path: string } | undefined {
    const generation = this.generations(folder).at(-1);
    if (generation === undefined) return undefined;
    const path = join(folder, `${generation}.json`);
    let holder: LockHolder | undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      const h = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      if (typeof h.pid === "number" && typeof h.sessionId === "string" && typeof h.boot === "number") holder = { pid: h.pid, sessionId: h.sessionId, boot: h.boot };
    } catch {
      holder = undefined;
    }
    return { generation, holder, path };
  }

  private isSelf(holder: LockHolder | undefined): boolean {
    return Boolean(holder && holder.pid === this.self.pid && holder.sessionId === this.self.sessionId && Math.abs(holder.boot - this.self.boot) <= 1);
  }

  private isLive(holder: LockHolder): boolean {
    return Math.abs(holder.boot - this.self.boot) <= 1 && this.alive(holder.pid);
  }

  /** Take the lock, or say who holds it. Taking one's own lock again succeeds. */
  acquire(key: string): Acquired {
    const folder = this.folder(key);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      mkdirSync(folder, { recursive: true });
      const top = this.top(folder);
      if (top) {
        if (this.isSelf(top.holder)) return { ok: true };
        if (top.holder && this.isLive(top.holder)) return { ok: false, holder: top.holder };
        if (!top.holder) {
          const age = Date.now() - (mtimeOf(top.path) ?? 0); // file times: the real clock
          if (age < DAMAGED_LOCK_MS) return { ok: false, damaged: true };
        }
      }
      const next = (top?.generation ?? 0) + 1;
      try {
        // Creating the next number succeeds for one session only: that is the take.
        writeFileSync(join(folder, `${next}.json`), JSON.stringify(this.self), { flag: "wx", mode: 0o600 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EEXIST" || code === "ENOENT") continue; // another session took it, or the folder went: look again
        throw error;
      }
      for (const generation of this.generations(folder)) if (generation < next) rmSync(join(folder, `${generation}.json`), { force: true });
      return { ok: true };
    }
    const top = this.top(folder);
    return top?.holder ? { ok: false, holder: top.holder } : { ok: false, damaged: true };
  }

  /** Does this session still hold the lock? False once any other session has taken it. */
  holds(key: string): boolean {
    return this.isSelf(this.top(this.folder(key))?.holder);
  }

  /** Let the lock go: remove this session's lock file, and the conversation's folder when empty. */
  release(key: string): void {
    const folder = this.folder(key);
    const top = this.top(folder);
    if (!top || !this.isSelf(top.holder)) return;
    rmSync(top.path, { force: true });
    try {
      rmdirSync(folder);
    } catch {
      // another session's lock is being created there: the folder stays
    }
  }
}

function mtimeOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}
