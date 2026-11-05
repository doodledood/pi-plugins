// One session owns a watched conversation on this machine. Each conversation has a folder of
// numbered lock files under ~/.pi/agent/slack-companion/locks/; the highest number is the lock.
// Taking a lock is creating the next number, which only one session can do, so two sessions never
// both win; numbers are not used twice while a conversation's folder exists (a release writes a
// "released" file as the next one; the sweep removes only folders abandoned for a day). A lock is
// taken from its holder only when that holder's process is gone (its pid answers no more, or now
// belongs to a process started at another time): never from a live session, however long it
// slept. A lock file that cannot be read is respected for a minute (it may be being written), then
// taken.
// Holds docs/adr/20261104-start-watching-when-the-session-messages-someone.md (routing).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** When a process started; gone when no such process runs; unknown when it could not be read. */
export type StartReading = { kind: "started"; at: string } | { kind: "gone" } | { kind: "unknown" };
export type ProcessStart = (pid: number) => StartReading;

/**
 * When a process started, as `ps` prints it, read in one fixed time zone and language: `ps` prints
 * the start in the caller's zone and locale, and two sessions must read the same text for the same
 * process. A `ps` that cannot run, or runs too long, says "unknown", never "gone".
 */
export const processStart: ProcessStart = (pid) => {
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, TZ: "UTC", LC_ALL: "C", LANG: "C" },
    }).trim();
    return out ? { kind: "started", at: out } : { kind: "gone" };
  } catch (error) {
    const { status, stdout } = error as { status?: number; stdout?: string };
    // ps exits 1 with nothing printed when no such process runs.
    return status === 1 && !String(stdout ?? "").trim() ? { kind: "gone" } : { kind: "unknown" };
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
    // A session whose own start cannot be read records none: others then judge it by its pid alone.
    const start = startOf(self.pid);
    this.self = { ...self, ...(start.kind === "started" ? { start: start.at } : {}) };
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

  /** Each number's file as text (undefined when it cannot be read): what a taker judged. */
  private contents(folder: string): Map<number, string | undefined> {
    const found = new Map<number, string | undefined>();
    for (const generation of this.generations(folder)) {
      try {
        found.set(generation, readFileSync(join(folder, `${generation}.json`), "utf8"));
      } catch {
        found.set(generation, undefined);
      }
    }
    return found;
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

  /**
   * The holder's process still runs: its pid answers, and started when the holder's did. A start
   * that cannot be read keeps the holder live: only a start read as different means the pid was reused.
   */
  private isLive(holder: LockHolder): boolean {
    if (holder.released || !this.alive(holder.pid)) return false;
    if (holder.start === undefined) return true;
    const start = this.startOf(holder.pid);
    switch (start.kind) {
      case "unknown":
        return true;
      case "gone":
        return false;
      case "started":
        return start.at === holder.start;
    }
  }

  /** Take the lock, or say who holds it. Taking one's own lock again succeeds. */
  acquire(key: string): Acquired {
    const folder = this.folder(key);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      mkdirSync(folder, { recursive: true });
      const seen = this.contents(folder);
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
      // since been passed, or the folder may have been swept and begun again from 1 meanwhile: back
      // off if a higher number exists, or a lower one that is not the file this session judged.
      const now = this.contents(folder);
      if ([...now].some(([generation, text]) => generation > next || (generation < next && seen.get(generation) !== text))) {
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
      if (age <= OLD_LOCK_MS) continue;
      const abandoned = top.holder === undefined || top.holder.released || !this.isLive(top.holder);
      if (!abandoned) continue;
      // Only the files read here go, then the folder if nothing else is in it: a lock another
      // session creates meanwhile stays (and a taker that finds the folder gone tries again).
      for (const generation of this.generations(folder)) if (generation <= top.generation) rmSync(join(folder, `${generation}.json`), { force: true });
      try {
        rmdirSync(folder);
      } catch (error) {
        // A lock another session created meanwhile keeps the folder; anything else is a real failure.
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
      }
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
