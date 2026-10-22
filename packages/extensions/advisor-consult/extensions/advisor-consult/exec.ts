import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/** How long a terminated advisor gets to shut down cleanly before it and its descendants are killed. */
export const TERMINATE_GRACE_MS = 4_000;
/** After the advisor exits, how long its pipes may stay quiet before descendants still holding them are ignored. */
const EXIT_STDIO_IDLE_MS = 200;

export interface AdvisorExecOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AdvisorExecResult {
  stdout: string;
  stderr: string;
  /** Exit code; null when the process ended on a signal or could not start. */
  code: number | null;
  /** Set when the run was terminated, naming what asked for it first. */
  terminatedBy?: "timeout" | "abort";
  /** Spawn failure, e.g. `pi` not on PATH. */
  spawnError?: string;
}

export type AdvisorExec = (command: string, args: string[], options: AdvisorExecOptions) => Promise<AdvisorExecResult>;

/**
 * Run the advisor subprocess and bound its teardown.
 *
 * Pi's `pi.exec` cannot be used: it escalates to SIGKILL only `if (!proc.killed)`, which Node sets as soon as
 * SIGTERM is delivered, so a child that handles SIGTERM slowly is never killed, and a parent abort after the
 * timeout is ignored. Here a terminate request sends SIGTERM to the advisor's whole process group, a second
 * request (an abort after the timeout) or the end of the grace period sends SIGKILL to the group. The group
 * covers whatever the advisor's tools started, and is cleared when the consult settles.
 */
export const runAdvisorProcess: AdvisorExec = (command, args, options) =>
  new Promise((resolve) => {
    const startedAbort = options.signal?.aborted === true;
    if (startedAbort) {
      resolve({ stdout: "", stderr: "", code: null, terminatedBy: "abort" });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group on POSIX, so one signal reaches the advisor and everything it started.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ stdout: "", stderr: "", code: null, spawnError: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let terminatedBy: AdvisorExecResult["terminatedBy"];
    let exitCode: number | null = null;
    let exited = false;
    let finished = false;
    let spawnError: string | undefined;
    const timers = new Set<NodeJS.Timeout>();
    let idleTimer: NodeJS.Timeout | undefined;

    const signalTree = (signal: NodeJS.Signals): void => killTree(child, signal);

    const terminate = (reason: "timeout" | "abort"): void => {
      if (finished) return;
      if (terminatedBy !== undefined) {
        // A second request (an abort after the timeout) does not wait out the grace period.
        signalTree("SIGKILL");
        return;
      }
      terminatedBy = reason;
      signalTree("SIGTERM");
      const escalate = setTimeout(() => {
        // Kill the group even if the leader already exited, so descendants holding its pipes go too.
        signalTree("SIGKILL");
      }, TERMINATE_GRACE_MS);
      timers.add(escalate);
    };

    const onAbort = (): void => terminate("abort");
    // The advisor runs in its own group, so the terminal's Ctrl+C no longer reaches it; take it down with Pi.
    const onParentExit = (): void => signalTree("SIGKILL");

    const finish = (): void => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener("abort", onAbort);
      process.removeListener("exit", onParentExit);
      // Anything still in the group is work the advisor left behind; nothing a consult started outlives it.
      signalTree("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ stdout, stderr, code: exitCode, ...(terminatedBy ? { terminatedBy } : {}), ...(spawnError ? { spawnError } : {}) });
    };

    const armIdle = (): void => {
      if (!exited) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(finish, EXIT_STDIO_IDLE_MS);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      armIdle();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      armIdle();
    });
    child.on("error", (error) => {
      spawnError = error.message;
      if (child.pid === undefined) finish();
    });
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      armIdle();
    });
    child.on("close", finish);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    process.on("exit", onParentExit);
    if (options.timeoutMs > 0) {
      const timeout = setTimeout(() => terminate("timeout"), options.timeoutMs);
      timers.add(timeout);
    }
  });

function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (signal === "SIGKILL") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}
