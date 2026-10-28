// herdr-bridge: makes Pi sessions in Herdr startable, visible and followable from another Pi session.
//
// - Status bridge: a session waiting at any dialog shows in Herdr as blocked, not working.
// - start_agent_session: starts a separate interactive Pi session in its own Herdr tab.
// - Wake-ups: the session that started one hears when it finishes a turn, waits at a question,
//   stays working with no change for a quiet interval, or exits.
//
// It does nothing outside the primary interactive Pi of a Herdr pane, and it never closes,
// types into or answers another session: those stay with the agent, through Herdr's own commands.
import { Type } from "typebox";
import { Herdr, cliRunner, type AgentView } from "./herdr.ts";
import { SCREEN_LINES, WAKEUP_TYPE, wakeupText } from "./messages.ts";
import { type StartedSession, startSession } from "./start.ts";
import { DEFAULT_QUIET_INTERVAL_MS, type Phase, type TrackedSession, type Wakeup, observe, track } from "./tracker.ts";

/** Entries this extension appends to its own session, so a reload or resume picks the work up again. */
export const STARTED_ENTRY = "herdr-bridge-started";
export const PHASE_ENTRY = "herdr-bridge-phase";
export const ENDED_ENTRY = "herdr-bridge-ended";

/** How often Herdr is read while a started session is live. */
export const POLL_MS = 2_000;
/** Consecutive failed reads after which the session is told its wake-ups are not arriving. */
export const FAILURES_BEFORE_NOTICE = 3;

// One claim per process: the first interactive runtime that starts in a Herdr pane is the primary
// session. An in-process child — a BTW aside binds the same terminal mode — finds it taken.
const PRIMARY = Symbol.for("@doodledood/pi-herdr-bridge/primary");
type ClaimHolder = { [PRIMARY]?: object };

export function claimPrimary(owner: object): boolean {
  const holder = globalThis as ClaimHolder;
  if (holder[PRIMARY] && holder[PRIMARY] !== owner) return false;
  holder[PRIMARY] = owner;
  return true;
}

export function releasePrimary(owner: object): void {
  const holder = globalThis as ClaimHolder;
  if (holder[PRIMARY] === owner) delete holder[PRIMARY];
}

/** True for a session the package may act in, before the primary claim. */
export function eligible(env: NodeJS.ProcessEnv, mode: string | undefined): boolean {
  return env.HERDR_ENV === "1" && Boolean(env.HERDR_PANE_ID) && mode === "tui";
}

/** The slice of Pi's extension API this package uses; the real API satisfies it. */
export interface BridgeApi {
  on(event: string, handler: (event: any, ctx: any) => unknown): unknown;
  registerTool(tool: any): void;
  sendMessage(message: { customType: string; content: string; display: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
  appendEntry(customType: string, data?: unknown): void;
  events: { emit(channel: string, data: unknown): void };
}

export interface BridgeDeps {
  herdr?: Herdr;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  pollMs?: number;
  quietIntervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

const StartParams = Type.Object({
  folder: Type.String({ description: "The folder the session works in; a relative path resolves against this session's folder." }),
  prompt: Type.String({ description: "The session's first message, sent as if typed." }),
  name: Type.Optional(Type.String({ description: "Herdr agent name: 1-32 lowercase letters, digits, - or _. Defaults to one made from the folder name." })),
});

type Entry = { type?: string; customType?: string; data?: any };

/** Started sessions still to follow, from this session's own entries on its current branch. */
export function trackedFromEntries(entries: readonly Entry[], now: number): TrackedSession[] {
  const byPane = new Map<string, TrackedSession>();
  for (const entry of entries) {
    if (entry.type !== "custom" || !entry.data) continue;
    const data = entry.data;
    if (entry.customType === STARTED_ENTRY && typeof data.paneId === "string" && typeof data.name === "string") {
      byPane.set(data.paneId, track(data.name, data.paneId, now, typeof data.completionSeq === "number" ? data.completionSeq : undefined));
    } else if (entry.customType === PHASE_ENTRY && byPane.has(data.paneId)) {
      const session = byPane.get(data.paneId)!;
      if (data.phase === "working" || data.phase === "finished" || data.phase === "blocked") session.phase = data.phase as Phase;
      if (typeof data.completionSeq === "number") session.completionSeq = data.completionSeq;
    } else if (entry.customType === ENDED_ENTRY) {
      byPane.delete(data.paneId);
    }
  }
  return [...byPane.values()];
}

export function createHerdrBridge(deps: BridgeDeps = {}) {
  return function herdrBridge(pi: BridgeApi): void {
    const env = deps.env ?? process.env;
    const herdr = deps.herdr ?? new Herdr(cliRunner());
    const now = deps.now ?? Date.now;
    const pollMs = deps.pollMs ?? POLL_MS;
    const quietMs = deps.quietIntervalMs ?? (Number(env.HERDR_BRIDGE_QUIET_INTERVAL_MS) || DEFAULT_QUIET_INTERVAL_MS);
    const startTimer = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    const stopTimer = deps.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    const owner = {};

    let active = false;
    let toolRegistered = false;
    let tracked: TrackedSession[] = [];
    let timer: unknown;
    let polling = false;
    let failures = 0;
    let cwd = process.cwd();

    function stopPolling(): void {
      if (timer !== undefined) stopTimer(timer);
      timer = undefined;
    }

    function ensurePolling(): void {
      if (!active || timer !== undefined || tracked.length === 0) return;
      timer = startTimer(() => void poll(), pollMs);
    }

    async function deliver(wakeup: Wakeup): Promise<void> {
      let screen: string | undefined;
      if (wakeup.kind === "blocked") {
        try {
          screen = await herdr.readScreen(wakeup.name, SCREEN_LINES);
        } catch {
          screen = undefined;
        }
      }
      if (!active) return;
      pi.sendMessage(
        { customType: WAKEUP_TYPE, content: wakeupText(wakeup, screen), display: true, details: wakeup },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }

    async function poll(): Promise<void> {
      if (!active || polling) return;
      polling = true;
      try {
        let agents: AgentView[];
        try {
          agents = await herdr.listAgents();
        } catch (error) {
          failures++;
          if (failures === FAILURES_BEFORE_NOTICE && active) {
            pi.sendMessage(
              {
                customType: WAKEUP_TYPE,
                content: `herdr-bridge cannot read Herdr, so wake-ups for the sessions you started are not arriving: ${error instanceof Error ? error.message : String(error)}. It keeps trying; check the sessions with \`herdr agent list\` meanwhile.`,
                display: true,
              },
              { triggerTurn: false },
            );
          }
          return;
        }
        failures = 0;
        if (!active) return;
        const previous = new Map(tracked.map((session) => [session.paneId, session]));
        const result = observe(tracked, agents, now(), quietMs);
        tracked = result.tracked;
        for (const session of tracked) {
          const before = previous.get(session.paneId);
          if (before && (before.phase !== session.phase || before.completionSeq !== session.completionSeq)) {
            pi.appendEntry(PHASE_ENTRY, { paneId: session.paneId, phase: session.phase, completionSeq: session.completionSeq });
          }
        }
        for (const wakeup of result.wakeups) {
          if (wakeup.kind === "gone") pi.appendEntry(ENDED_ENTRY, { paneId: wakeup.paneId });
          await deliver(wakeup);
        }
        if (tracked.length === 0) stopPolling();
      } finally {
        polling = false;
      }
    }

    function follow(session: StartedSession): void {
      tracked = [...tracked.filter((t) => t.paneId !== session.paneId), track(session.name, session.paneId, now(), session.completionSeq)];
      pi.appendEntry(STARTED_ENTRY, { name: session.name, paneId: session.paneId, completionSeq: session.completionSeq, startedAt: now() });
      ensurePolling();
    }

    function registerTool(): void {
      if (toolRegistered) return;
      toolRegistered = true;
      pi.registerTool({
        name: "start_agent_session",
        label: "Start agent session",
        description:
          "Start a separate, interactive Pi agent session in its own Herdr tab, working in a folder, with a first prompt. The person can switch to it and type in it, and it keeps running on its own; this session gets a message when it finishes a turn, waits at a question, stays working for 10 minutes with no change, or exits. A subagent is different: a child task inside this session.",
        promptSnippet: "Start a separate, interactive Pi session in its own Herdr tab, in a folder, with a first prompt.",
        promptGuidelines: [
          "Use start_agent_session when the user or a skill asks to start, spin up, open or create a new session, agent session or run; use a subagent only when a child task inside this session is asked for.",
          "Follow sessions you started with Herdr's agent commands: `herdr agent list` and `herdr agent get <name>` for their state, `herdr agent read <name> --source recent --lines 80` for their output, `herdr agent prompt <name> \"<text>\"` to message one, and `herdr pane close <pane>` to stop one you started.",
        ],
        parameters: StartParams,
        async execute(_toolCallId: string, params: { folder: string; prompt: string; name?: string }) {
          const agentDir = env.PI_CODING_AGENT_DIR;
          const session = await startSession(herdr, params, { cwd, env: agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {} });
          follow(session);
          const lines = [
            `Started Pi session "${session.name}" in ${session.folder}: Herdr pane ${session.paneId}, tab ${session.tabId}, workspace ${session.workspaceId}.`,
            session.sessionPath ? `Its Pi session file: ${session.sessionPath}` : "Herdr did not report its Pi session file yet.",
            `The first prompt was sent. You will get a message when it finishes a turn, waits at a question, stays working for ${Math.round(quietMs / 60_000)} minutes with no change, or exits.`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: session };
        },
      });
    }

    pi.on("ui_prompt_start", (event: { title?: string }) => {
      if (!active) return;
      pi.events.emit("herdr:blocked", { active: true, label: event.title || "waiting for an answer" });
    });

    pi.on("ui_prompt_end", () => {
      if (!active) return;
      pi.events.emit("herdr:blocked", { active: false });
    });

    pi.on("session_start", (_event: unknown, ctx: { mode?: string; cwd?: string; sessionManager?: { getBranch(): Entry[] } }) => {
      stopPolling();
      active = eligible(env, ctx.mode) && claimPrimary(owner);
      if (!active) return;
      cwd = ctx.cwd ?? cwd;
      registerTool();
      tracked = trackedFromEntries(ctx.sessionManager?.getBranch() ?? [], now());
      failures = 0;
      ensurePolling();
    });

    pi.on("session_shutdown", () => {
      stopPolling();
      if (active) releasePrimary(owner);
      active = false;
    });
  };
}

export default createHerdrBridge();
