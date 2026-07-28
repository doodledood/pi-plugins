/**
 * Durable file mechanics.
 *
 * Whole-file writes go through a same-directory temp file plus rename, logs are
 * appended, and seeding uses exclusive-create plus link so a user's edits are
 * never overwritten. Nothing here knows about packets or sessions.
 */

import {
  access,
  appendFile,
  constants,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hqPaths } from "./paths.ts";

export type ErrorReporter = (message: string, error: unknown) => void;

export const silentReporter: ErrorReporter = () => {};

export async function ensureLayout(root: string): Promise<void> {
  const paths = hqPaths(root);
  await Promise.all([
    mkdir(paths.sessions, { recursive: true }),
    mkdir(paths.queue, { recursive: true }),
    mkdir(paths.archive, { recursive: true }),
    mkdir(paths.doctrineProjects, { recursive: true }),
  ]);
}

function temporaryPath(path: string): string {
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return join(dirname(path), `.${basename(path)}.${unique}.tmp`);
}

/** Whole-file replacement that a reader can never observe half-written. */
export async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Creates a file only when it does not exist, without a check-then-write race.
 * This is what keeps re-seeding doctrine from touching the user's edits.
 */
export async function materializeIfAbsent(path: string, content: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = temporaryPath(path);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await link(temporary, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Appends one JSON record and a newline. Append-only logs are never rewritten. */
export async function appendJsonl(path: string, record: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function readJsonl<T>(
  path: string,
  parse: (value: unknown) => T | undefined,
  onError: ErrorReporter = silentReporter,
): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onError(`Unable to read log ${path}`, error);
    }
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parse(JSON.parse(trimmed));
      if (parsed === undefined) {
        onError(`Invalid record in ${path}`, new Error("record validation failed"));
        continue;
      }
      out.push(parsed);
    } catch (error) {
      // A torn final line is expected while another process appends; skip it.
      onError(`Malformed JSON line in ${path}`, error);
    }
  }
  return out;
}

export async function readJsonFile<T>(
  path: string,
  parse: (value: unknown) => T | undefined,
  onError: ErrorReporter = silentReporter,
): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onError(`Unable to read ${path}`, error);
    }
    return undefined;
  }
  try {
    const parsed = parse(JSON.parse(text));
    if (parsed === undefined) {
      onError(`Invalid record ${path}`, new Error("record validation failed"));
    }
    return parsed;
  } catch (error) {
    onError(`Malformed JSON ${path}`, error);
    return undefined;
  }
}

export interface ScanResult<T> {
  records: Array<{ path: string; id: string; record: T }>;
  /** Files that exist but could not be trusted; never silently dropped. */
  failures: Array<{ path: string; id: string }>;
}

/**
 * Reads every `*.json` in a directory. The filename's id must match the
 * record's own id, so a renamed or copied file cannot impersonate another.
 */
export async function scanJsonDir<T>(
  directory: string,
  parse: (value: unknown) => T | undefined,
  identify: (record: T) => string,
  onError: ErrorReporter = silentReporter,
): Promise<ScanResult<T>> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      onError(`Unable to list ${directory}`, error);
    }
    return { records: [], failures: [] };
  }

  const records: ScanResult<T>["records"] = [];
  const failures: ScanResult<T>["failures"] = [];

  for (const name of names.sort()) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue;
    const id = name.slice(0, -".json".length);
    const path = join(directory, name);
    const record = await readJsonFile(path, parse, onError);
    if (!record) {
      failures.push({ path, id });
      continue;
    }
    if (identify(record) !== id) {
      onError(
        `Identity mismatch ${path}`,
        new Error(`filename says ${id}, record says ${identify(record)}`),
      );
      failures.push({ path, id });
      continue;
    }
    records.push({ path, id, record });
  }

  return { records, failures };
}

/** Liveness by PID probe. EPERM means alive but not ours. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Moves a file within the state root, replacing any existing destination. */
export async function moveFile(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

const previewSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Collapses whitespace and clips to a grapheme boundary. */
export function truncatePreview(text: string, limit = 240): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  const kept: string[] = [];
  let length = 0;
  for (const { segment } of previewSegmenter.segment(normalized)) {
    if (length + segment.length > Math.max(0, limit - 1)) break;
    kept.push(segment);
    length += segment.length;
  }
  return `${kept.join("")}…`;
}

/**
 * Serializes async work per key so two writers of the same file inside one
 * process cannot interleave read-modify-write cycles.
 */
export function createWriteQueue(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const prior = chains.get(key) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work);
    chains.set(key, next);
    try {
      return await next;
    } finally {
      if (chains.get(key) === next) chains.delete(key);
    }
  };
}

/** Monotonic-ish, sortable, path-safe id with a short random tail. */
export function newId(prefix: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const tail = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${tail}`;
}
