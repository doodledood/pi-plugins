/**
 * Where HQ's substrate lives, and the only place HQ's runtime writes.
 *
 * Resolution order (ASM-1, ASM-10): HQ_HOME, then the pi user directory
 * inferred from PI_CODING_AGENT_DIR, then ~/.pi/hq. Tests always pass
 * HQ_HOME so they never touch the real root.
 */

import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface HqPaths {
  root: string;
  /** One file per supervised session: the fleet. */
  sessions: string;
  /** One file per packet: the queue. */
  queue: string;
  /** Packets that have been ruled, kept for audit. */
  archive: string;
  /** One record per observed stop, until triage finishes it. */
  stops: string;
  /** Doctrine files: global.md plus projects/<slug>.md, plus meta. */
  doctrine: string;
  doctrineGlobal: string;
  doctrineProjects: string;
  /** Append-only records. */
  rulingsLog: string;
  auditLog: string;
  defectsLog: string;
  /** One line per drill step, so tiering is auditable. */
  drillsLog: string;
  /** Per-domain shadow-agreement and graduation state. */
  graduation: string;
  /** How HQ's judgment workers think: the seat's own model and effort. */
  judgment: string;
  /** Who is at the desk right now, with a heartbeat. */
  seat: string;
  /** Stdout/stderr of spawned workers, for debugging a failed worker. */
  logs: string;
}

/** Resolves the HQ state root without creating anything. */
export function resolveStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HQ_HOME?.trim();
  if (explicit) return expandHome(explicit);

  const agentDir = env.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) return join(dirname(expandHome(agentDir)), "hq");

  return join(homedir(), ".pi", "hq");
}

/**
 * Expands a leading `~` before resolving, the way pi expands the same variables.
 * Without this, `PI_CODING_AGENT_DIR=~/custom/agent` would resolve against the
 * session's cwd and give every project its own literal `~`-named state root —
 * fragmenting the one substrate the seat and its workers share.
 */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function hqPaths(root: string): HqPaths {
  const doctrine = join(root, "doctrine");
  return {
    root,
    sessions: join(root, "sessions"),
    queue: join(root, "queue"),
    archive: join(root, "archive"),
    stops: join(root, "stops"),
    doctrine,
    doctrineGlobal: join(doctrine, "global.md"),
    doctrineProjects: join(doctrine, "projects"),
    rulingsLog: join(root, "rulings.jsonl"),
    auditLog: join(root, "audit.jsonl"),
    defectsLog: join(root, "defects.jsonl"),
    drillsLog: join(root, "drills.jsonl"),
    graduation: join(root, "graduation.json"),
    judgment: join(root, "judgment.json"),
    seat: join(root, "seat.json"),
    logs: join(root, "logs"),
  };
}

/** A filesystem-safe slug for a project path, used for per-project doctrine. */
export function projectSlug(projectPath: string): string {
  const trimmed = projectPath.replace(/\/+$/, "");
  const base = trimmed.split("/").filter(Boolean).slice(-2).join("-");
  const slug = (base || "root").toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return slug.replace(/^-+|-+$/g, "") || "root";
}

export function sessionStatePath(root: string, sessionId: string): string {
  return join(hqPaths(root).sessions, `${assertSafeId(sessionId, "session id")}.json`);
}

export function packetPath(root: string, packetId: string): string {
  return join(hqPaths(root).queue, `${assertSafeId(packetId, "packet id")}.json`);
}

export function archivedPacketPath(root: string, packetId: string): string {
  return join(hqPaths(root).archive, `${assertSafeId(packetId, "packet id")}.json`);
}

export function projectDoctrinePath(root: string, projectPath: string): string {
  return join(hqPaths(root).doctrineProjects, `${projectSlug(projectPath)}.md`);
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Guards every id that becomes a path component. A traversal-shaped id is a
 * write outside the state root, which INV-G12 forbids.
 */
export function assertSafeId(value: string, label: string): string {
  if (!SAFE_ID.test(value) || value.includes("..")) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}
