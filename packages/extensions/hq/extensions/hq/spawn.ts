/**
 * Spawning headless workers.
 *
 * Workers are child `pi` processes in print mode rather than in-process SDK
 * sessions, for three reasons: a child process gets its own environment, so the
 * managed marker cannot leak onto the seat that spawned it; HQ's own reporter is
 * discovered inside the child, so a worker publishes its state and detects its
 * own stop; and the seat can be killed without orphaning work.
 *
 * Nothing here decides what a worker does — that is the caller's prompt.
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "./io.ts";
import { hqPaths } from "./paths.ts";
import type { SessionKind } from "./types.ts";

/** Marks a session as HQ-managed. Absent means attended: hands off. */
export const MANAGED_ENV = "HQ_MANAGED";
export const KIND_ENV = "HQ_KIND";
export const ORIGIN_ENV = "HQ_ORIGIN_SESSION_ID";
export const PACKET_ENV = "HQ_PACKET_ID";
export const HOME_ENV = "HQ_HOME";
export const TITLER_ENV = "HQ_NO_TITLER";
export const BIN_ENV = "HQ_PI_BIN";
/**
 * Loads HQ explicitly in the child rather than relying on discovery. Set by the
 * end-to-end runner and by a sandboxed install so a test never depends on the
 * user's real settings.
 */
export const EXTENSION_ENV = "HQ_EXTENSION_PATH";

/** A worker kind that must never itself be triaged or titled. */
export const INTERNAL_KINDS: ReadonlySet<string> = new Set(["triage", "drill", "titler"]);

export interface SpawnRequest {
  kind: SessionKind | "titler";
  prompt: string;
  cwd: string;
  /** Resume this session file instead of starting fresh. */
  resumeSessionFile?: string;
  /** Fork this session file into a new session (the drill's copy). */
  forkSessionFile?: string;
  model?: string;
  /** Tool allowlist passed through to the child. */
  tools?: string[];
  originSessionId?: string;
  packetId?: string;
  name?: string;
  /** Wait for the child to exit and report its code. Off by default. */
  wait?: boolean;
  /** Extra environment for the child. */
  env?: Record<string, string>;
}

export interface SpawnResult {
  /** HQ's own handle for the run; also the log file name. */
  runId: string;
  pid: number | undefined;
  logPath: string;
  argv: string[];
  exitCode?: number;
}

export type Spawner = (request: SpawnRequest) => Promise<SpawnResult>;

export interface SpawnerOptions {
  root: string;
  /** Overridden in tests; defaults to node:child_process.spawn. */
  spawnImpl?: typeof nodeSpawn;
  /** Overridden in tests; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Where a spawn failure is reported. Without one, failures are logged only. */
  onError?: (message: string, error: unknown) => void;
}

export function buildArgv(request: SpawnRequest, extensionPath?: string): string[] {
  const argv: string[] = [];
  if (extensionPath) argv.push("-e", extensionPath);
  if (request.resumeSessionFile) argv.push("--session", request.resumeSessionFile);
  if (request.forkSessionFile) argv.push("--fork", request.forkSessionFile);
  if (request.model) argv.push("--model", request.model);
  if (request.name) argv.push("--name", request.name);
  if (request.tools && request.tools.length > 0) argv.push("--tools", request.tools.join(","));
  argv.push("--print", request.prompt);
  return argv;
}

export function buildEnv(
  request: SpawnRequest,
  root: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...request.env };
  env[MANAGED_ENV] = "1";
  env[KIND_ENV] = request.kind;
  env[HOME_ENV] = root;
  if (request.originSessionId) env[ORIGIN_ENV] = request.originSessionId;
  else delete env[ORIGIN_ENV];
  if (request.packetId) env[PACKET_ENV] = request.packetId;
  else delete env[PACKET_ENV];
  // A titler must never trigger another titler.
  if (INTERNAL_KINDS.has(request.kind)) env[TITLER_ENV] = "1";
  return env;
}

export function createSpawner(options: SpawnerOptions): Spawner {
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const baseEnv = options.env ?? process.env;
  const bin = baseEnv[BIN_ENV]?.trim() || "pi";

  return async (request: SpawnRequest): Promise<SpawnResult> => {
    const logs = hqPaths(options.root).logs;
    await mkdir(logs, { recursive: true });
    const runId = newId(request.kind);
    const logPath = join(logs, `${runId}.log`);
    const argv = buildArgv(request, baseEnv[EXTENSION_ENV]?.trim() || undefined);
    const handle = await open(logPath, "a");

    try {
      const spawnOptions: SpawnOptions = {
        cwd: request.cwd,
        env: buildEnv(request, options.root, baseEnv),
        detached: !request.wait,
        stdio: ["ignore", handle.fd, handle.fd],
      };
      const child = spawnImpl(bin, argv, spawnOptions);
      const pid = child.pid;

      if (!request.wait) {
        // Node throws on an unhandled 'error' event, and a detached spawn resolves
        // before the failure arrives — without this listener a missing `pi` binary
        // or a deleted cwd takes down the session that spawned the worker.
        child.once?.("error", (error: unknown) => {
          options.onError?.(`Unable to spawn ${request.kind} worker (${bin})`, error);
        });
        child.unref?.();
        return { runId, pid, logPath, argv };
      }

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 0));
      });
      return { runId, pid, logPath, argv, exitCode };
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
}

/** Reads the managed marker out of an environment. */
export function isManagedEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[MANAGED_ENV] === "1";
}

export function envKind(env: NodeJS.ProcessEnv = process.env): SessionKind | "titler" {
  const kind = env[KIND_ENV];
  if (kind === "worker" || kind === "triage" || kind === "drill" || kind === "continuation") {
    return kind;
  }
  if (kind === "titler") return "titler";
  return "worker";
}
