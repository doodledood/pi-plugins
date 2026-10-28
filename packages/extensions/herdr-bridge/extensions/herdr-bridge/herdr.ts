// The one place this package talks to Herdr: it runs the `herdr` CLI and parses what comes back.
// Inside a Herdr pane the CLI reaches that pane's own Herdr session through the environment Herdr
// gives the pane, so nothing here names a session or a socket.
import { execFile } from "node:child_process";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
const STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

/** One agent Herdr sees in a pane, as `herdr agent list` reports it. */
export interface AgentView {
  paneId: string;
  tabId: string;
  workspaceId: string;
  /** The agent's live name, when it has one; it follows the pane's occupant. */
  name?: string;
  /** Which agent Herdr recognized in the pane, such as `pi`. */
  kind?: string;
  status: AgentStatus;
  cwd?: string;
  /** The agent's own session file, where its integration reported one. */
  sessionPath?: string;
  /** Rises each time the agent finishes a turn, whether or not anyone saw it. */
  completionSeq?: number;
}

export interface PaneView {
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd?: string;
}

export interface WorkspaceView {
  workspaceId: string;
  label?: string;
}

/** Runs one `herdr` command and returns its standard output, or throws a {@link HerdrError}. */
export type HerdrRunner = (args: readonly string[], options?: { timeoutMs?: number }) => Promise<string>;

/** A failed Herdr command, carrying Herdr's own error code when it gave one. */
export class HerdrError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

/** Herdr's CLI as a {@link HerdrRunner}. `bin` is the executable to run. */
export function cliRunner(bin = "herdr"): HerdrRunner {
  return (args, options) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...args], { timeout: options?.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const reported = herdrErrorIn(stdout) ?? herdrErrorIn(stderr);
        if (reported) {
          reject(reported);
          return;
        }
        const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
        reject(
          new HerdrError(
            missing
              ? `the \`${bin}\` command was not found on PATH; install Herdr (https://herdr.dev) and run this inside a Herdr pane`
              : `herdr ${args.join(" ")} failed: ${(stderr || stdout || error.message).trim()}`,
            missing ? "herdr_not_found" : undefined,
          ),
        );
      });
    });
}

function herdrErrorIn(text: string): HerdrError | undefined {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (parsed.error && typeof parsed.error.message === "string") {
      return new HerdrError(parsed.error.message, typeof parsed.error.code === "string" ? parsed.error.code : undefined);
    }
  } catch {
    // Not Herdr's JSON error shape; the caller reports the raw output instead.
  }
  return undefined;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

function resultOf(stdout: string, command: string): Json {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new HerdrError(`herdr ${command} printed something that is not JSON: ${stdout.slice(0, 200)}`);
  }
  if (!isObject(parsed) || !isObject(parsed.result)) throw new HerdrError(`herdr ${command} returned no result`);
  return parsed.result;
}

function parseAgent(value: unknown): AgentView | undefined {
  if (!isObject(value)) return undefined;
  const paneId = str(value.pane_id);
  const tabId = str(value.tab_id);
  const workspaceId = str(value.workspace_id);
  if (!paneId || !tabId || !workspaceId) return undefined;
  const status = STATUSES.includes(value.agent_status as AgentStatus) ? (value.agent_status as AgentStatus) : "unknown";
  const session = isObject(value.agent_session) && value.agent_session.kind === "path" ? str(value.agent_session.value) : undefined;
  return {
    paneId,
    tabId,
    workspaceId,
    name: str(value.name),
    kind: str(value.agent),
    status,
    cwd: str(value.cwd),
    sessionPath: session,
    completionSeq: typeof value.completion_seq === "number" ? value.completion_seq : undefined,
  };
}

function parsePane(value: unknown): PaneView | undefined {
  if (!isObject(value)) return undefined;
  const paneId = str(value.pane_id);
  const tabId = str(value.tab_id);
  const workspaceId = str(value.workspace_id);
  if (!paneId || !tabId || !workspaceId) return undefined;
  return { paneId, tabId, workspaceId, cwd: str(value.cwd) };
}

/** Typed Herdr commands over a runner. */
export class Herdr {
  constructor(private readonly run: HerdrRunner) {}

  async listAgents(): Promise<AgentView[]> {
    const result = resultOf(await this.run(["agent", "list"]), "agent list");
    const agents = Array.isArray(result.agents) ? result.agents : [];
    return agents.map(parseAgent).filter((agent): agent is AgentView => agent !== undefined);
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const result = resultOf(await this.run(["workspace", "list"]), "workspace list");
    const workspaces = Array.isArray(result.workspaces) ? result.workspaces : [];
    return workspaces.flatMap((w) => (isObject(w) && str(w.workspace_id) ? [{ workspaceId: str(w.workspace_id)!, label: str(w.label) }] : []));
  }

  async listPanes(workspaceId: string): Promise<PaneView[]> {
    const result = resultOf(await this.run(["pane", "list", "--workspace", workspaceId]), "pane list");
    const panes = Array.isArray(result.panes) ? result.panes : [];
    return panes.map(parsePane).filter((pane): pane is PaneView => pane !== undefined);
  }

  /** Creates a workspace for `cwd` and returns its first pane. */
  async createWorkspace(cwd: string, label: string, env: Record<string, string>): Promise<PaneView> {
    const args = ["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus", ...envArgs(env)];
    const pane = parsePane(resultOf(await this.run(args), "workspace create").root_pane);
    if (!pane) throw new HerdrError("herdr workspace create returned no pane");
    return pane;
  }

  /** Opens a tab in a workspace and returns its pane. */
  async createTab(workspaceId: string, cwd: string, label: string, env: Record<string, string>): Promise<PaneView> {
    const args = ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus", ...envArgs(env)];
    const pane = parsePane(resultOf(await this.run(args), "tab create").root_pane);
    if (!pane) throw new HerdrError("herdr tab create returned no pane");
    return pane;
  }

  /**
   * Starts Pi in a shell pane under `name` and returns the agent once Herdr sees it ready. A new
   * pane's shell takes a moment to reach its prompt; until it does, Herdr refuses the pane as not an
   * available shell, so that refusal is retried for up to `shellWaitMs`.
   */
  async startPi(name: string, paneId: string, timeoutMs: number, shellWaitMs = 20_000, retryMs = 250): Promise<AgentView> {
    const deadline = Date.now() + shellWaitMs;
    for (;;) {
      try {
        const stdout = await this.run(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", String(timeoutMs)], {
          timeoutMs: timeoutMs + 15_000,
        });
        const agent = parseAgent(resultOf(stdout, "agent start").agent);
        if (!agent) throw new HerdrError("herdr agent start returned no agent");
        return agent;
      } catch (error) {
        const shellNotReady = error instanceof HerdrError && /not an available shell/i.test(error.message);
        if (!shellNotReady || Date.now() >= deadline) throw error;
        await new Promise((done) => setTimeout(done, retryMs));
      }
    }
  }

  /**
   * Types `text` into an agent and submits it, returning once Herdr sees the agent start working on
   * it (or stop at a question), never waiting for the turn to end.
   */
  async prompt(target: string, text: string, timeoutMs = 20_000): Promise<void> {
    await this.run(["agent", "prompt", target, text, "--wait", "--until", "working", "--until", "blocked", "--timeout", String(timeoutMs)], {
      timeoutMs: timeoutMs + 10_000,
    });
  }

  async getAgent(target: string): Promise<AgentView | undefined> {
    return parseAgent(resultOf(await this.run(["agent", "get", target]), "agent get").agent);
  }

  /** The agent's screen as plain text. */
  async readScreen(target: string, lines: number): Promise<string> {
    return this.run(["agent", "read", target, "--source", "visible", "--lines", String(lines)]);
  }
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}
