// A stand-in for the `herdr` CLI in unit tests: it answers the commands this package runs from an
// in-memory model of workspaces, tabs, panes and agents, and records every command it was given.
import { HerdrError, type HerdrRunner } from "./herdr.ts";

export interface FakePane {
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
  agent?: { name: string; kind: string; status: string; completionSeq?: number; sessionPath?: string };
}

export class FakeHerdr {
  readonly commands: string[][] = [];
  workspaces: { workspaceId: string; label: string }[] = [];
  panes: FakePane[] = [];
  /** Commands that fail with this Herdr error code, keyed by their first two words. */
  failures = new Map<string, { code: string; message: string }>();
  /** Screen text per agent name. */
  screens = new Map<string, string>();
  prompts: { target: string; text: string }[] = [];
  /** How many of the next prompts stall the way Herdr reports a prompt no working state followed. */
  stallPrompts = 0;
  /** How many of the next `agent start` calls find the pane's shell not at its prompt yet. */
  shellNotReady = 0;
  /** Called on each prompt, after it is recorded. */
  onPrompt?: (target: string, text: string) => void;
  private next = 1;
  private nextTab = 100;

  readonly run: HerdrRunner = async (args) => {
    this.commands.push([...args]);
    const key = `${args[0]} ${args[1]}`;
    const failure = this.failures.get(key);
    if (failure) throw new HerdrError(failure.message, failure.code);
    const flag = (name: string) => {
      const at = args.indexOf(name);
      return at === -1 ? undefined : args[at + 1];
    };
    const ok = (result: unknown) => JSON.stringify({ id: `cli:${key}`, result });
    switch (key) {
      case "agent list":
        if (this.brokenAgentList) return ok({ type: "agent_list", items: [] });
        return ok({ type: "agent_list", agents: this.panes.filter((p) => p.agent).map((p) => this.agentJson(p)) });
      case "workspace list":
        return ok({ type: "workspace_list", workspaces: this.workspaces.map((w) => ({ workspace_id: w.workspaceId, label: w.label })) });
      case "pane list": {
        const workspace = flag("--workspace");
        return ok({ panes: this.panes.filter((p) => workspace === undefined || p.workspaceId === workspace).map((p) => this.paneJson(p)) });
      }
      case "workspace create": {
        const workspaceId = `w${this.next++}`;
        this.workspaces.push({ workspaceId, label: flag("--label") ?? "" });
        const pane = { paneId: `${workspaceId}:p1`, tabId: `${workspaceId}:t1`, workspaceId, cwd: flag("--cwd")! };
        this.panes.push(pane);
        return ok({ type: "workspace_created", root_pane: this.paneJson(pane) });
      }
      case "tab create": {
        const workspaceId = flag("--workspace")!;
        const n = this.nextTab++;
        const pane = { paneId: `${workspaceId}:p${n}`, tabId: `${workspaceId}:t${n}`, workspaceId, cwd: flag("--cwd")! };
        this.panes.push(pane);
        return ok({ type: "tab_created", root_pane: this.paneJson(pane) });
      }
      case "agent start": {
        if (this.shellNotReady > 0) {
          this.shellNotReady--;
          throw new HerdrError(`agent target pane ${flag("--pane")} is not an available shell`, "agent_pane_unavailable");
        }
        const pane = this.panes.find((p) => p.paneId === flag("--pane"));
        if (!pane) throw new HerdrError(`agent target pane ${flag("--pane")} not found`, "agent_pane_not_found");
        pane.agent = { name: args[2]!, kind: "pi", status: "idle", sessionPath: `/sessions/${args[2]}.jsonl` };
        return ok({ type: "agent_started", agent: this.agentJson(pane) });
      }
      case "agent get": {
        const pane = this.panes.find((p) => p.agent?.name === args[2]);
        if (!pane) throw new HerdrError(`agent target ${args[2]} not found`, "agent_not_found");
        return ok({ type: "agent_info", agent: this.agentJson(pane) });
      }
      case "agent prompt":
        this.prompts.push({ target: args[2]!, text: args[3]! });
        this.onPrompt?.(args[2]!, args[3]!);
        if (this.stallPrompts > 0) {
          this.stallPrompts--;
          throw new HerdrError("agent prompt produced no observed working or blocked state within 5000 ms; current status is idle", "agent_prompt_stalled");
        }
        return ok({ type: "agent_prompted" });
      case "agent read":
        return this.screens.get(args[2]!) ?? "";
      default:
        throw new HerdrError(`fake herdr does not know "${args.join(" ")}"`, "unknown_command");
    }
  };

  private paneJson(p: FakePane) {
    return { pane_id: p.paneId, tab_id: p.tabId, workspace_id: p.workspaceId, cwd: p.cwd };
  }

  private agentJson(p: FakePane) {
    return {
      ...this.paneJson(p),
      name: p.agent!.name,
      agent: p.agent!.kind,
      agent_status: p.agent!.status,
      completion_seq: p.agent!.completionSeq,
      agent_session: p.agent!.sessionPath ? { kind: "path", value: p.agent!.sessionPath, source: "herdr:pi", agent: "pi" } : undefined,
    };
  }

  /** Pane entries Herdr lists, for a test that breaks their shape. */
  brokenAgentList = false;

  /** Commands other than read-only queries (list, read, get). */
  writes(): string[][] {
    return this.commands.filter((c) => !["list", "read", "get"].includes(c[1]!));
  }
}
