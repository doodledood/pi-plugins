// One session owns a watched conversation on this machine. A lock is a small file under
// ~/.pi/agent/slack-companion/locks/; a lock whose holder process is gone is reclaimed.
// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md (routing).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockHolder {
  pid: number;
  sessionId: string;
  at: number;
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

export class LockManager {
  constructor(
    private readonly dir: string,
    private readonly self: Omit<LockHolder, "at">,
    private readonly alive: ProcessAlive = processAlive,
  ) {}

  private path(key: string): string {
    return join(this.dir, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
  }

  private read(key: string): LockHolder | undefined {
    try {
      return JSON.parse(readFileSync(this.path(key), "utf8")) as LockHolder;
    } catch {
      return undefined;
    }
  }

  /** Take the lock, or return who holds it. Re-acquiring one's own lock succeeds. */
  acquire(key: string): { ok: true } | { ok: false; holder: LockHolder } {
    mkdirSync(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        writeFileSync(this.path(key), JSON.stringify({ ...this.self, at: Date.now() }), { flag: "wx", mode: 0o600 });
        return { ok: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = this.read(key);
      if (holder && holder.sessionId === this.self.sessionId && holder.pid === this.self.pid) return { ok: true };
      if (holder && this.alive(holder.pid)) return { ok: false, holder };
      // The holder is gone (killed without shutdown) or the file is unreadable: reclaim.
      rmSync(this.path(key), { force: true });
    }
    const holder = this.read(key);
    return holder ? { ok: false, holder } : { ok: false, holder: { pid: -1, sessionId: "unknown", at: 0 } };
  }

  release(key: string): void {
    const holder = this.read(key);
    if (holder && holder.sessionId === this.self.sessionId && holder.pid === this.self.pid) rmSync(this.path(key), { force: true });
  }
}
