// One session owns a watched conversation on this machine. Each conversation has a folder of
// numbered lock files under ~/.pi/agent/slack-companion/locks/; the highest number is the lock.
// Taking a lock is creating the next number, which only one session can do, so two sessions never
// both win; numbers are never used twice (a release writes a "released" file as the next one). A
// lock is taken from its holder only when that holder's process is gone (its pid answers no more,
// or now belongs to a process started at another time): never from a live session, however long
// it slept.
// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md (routing).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LockHolder {
  pid: number;
  sessionId: string;
  /** When the holder's process started, as `ps` tells it: a pid reused by another process (or after a restart) is not the holder. Unset when `ps` could not tell. */
  start?: string;
  /** The holder let the conversation go; the next session takes the next number. */
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

export type ProcessStart = (pid: number) => string | undefined;

/** When a process started, as `ps` prints it; undefined when there is no such process or no `ps`. */
export const processStart: ProcessStart = (pid) => {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
};

/** How old a released or abandoned lock folder must be before a session start removes it. */
export const OLD_LOCK_MS = 24 * 60 * 60 * 1000;

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
    self: Pick<LockHolder, "pid" | "sessionId">,
    private readonly alive: ProcessAlive = processAlive,
    private readonly startOf: ProcessStart = processStart,
  ) {
    const start = startOf(self.pid);
    this.self = { ...self, ...(start ? { start } : {}) };
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
      if (typeof h.pid === "number" && typeof h.sessionId === "string") {
        holder = { pid: h.pid, sessionId: h.sessionId, ...(typeof h.start === "string" ? { start: h.start } : {}), ...(h.released === true ? { released: true } : {}) };
      }
    } catch {
      holder = undefined;
    }
    return { generation, holder, path };
  }

  private isSelf(holder: LockHolder | undefined): boolean {
    return Boolean(holder && !holder.released && holder.pid === this.self.pid && holder.sessionId === this.self.sessionId && holder.start === this.self.start);
  }

  /** The holder's process still runs: its pid answers, and (when known) started when the holder's did. */
  private isLive(holder: LockHolder): boolean {
    if (holder.released || !this.alive(holder.pid)) return false;
    return holder.start === undefined || this.startOf(holder.pid) === holder.start;
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
      // A session that judged the lock from an older reading may have created a number that has
      // since been passed: only the highest number holds, so back off if a higher one exists.
      if (this.generations(folder).some((generation) => generation > next)) {
        rmSync(join(folder, `${next}.json`), { force: true });
        continue;
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

  /**
   * Let the lock go: write a "released" file as the next number (so the number is never used again,
   * and a session that judged the old holder an instant ago cannot reuse it), then remove this
   * session's own file.
   */
  release(key: string): void {
    const folder = this.folder(key);
    const top = this.top(folder);
    if (!top || !this.isSelf(top.holder)) return;
    try {
      writeFileSync(join(folder, `${top.generation + 1}.json`), JSON.stringify({ ...this.self, released: true }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; // another session took it already
    }
    rmSync(top.path, { force: true });
  }

  /**
   * Remove the folders of conversations whose lock was released, or whose holder is gone, more
   * than OLD_LOCK_MS ago: no session can be deciding on such an old lock any more.
   */
  sweep(now = Date.now()): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const folder = join(this.dir, name);
      const top = this.top(folder);
      if (!top) continue;
      const age = now - (mtimeOf(top.path) ?? now);
      const abandoned = top.holder === undefined || top.holder.released || !this.isLive(top.holder);
      if (abandoned && age > OLD_LOCK_MS) rmSync(folder, { recursive: true, force: true });
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
