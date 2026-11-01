// herdr-bridge: makes Pi sessions in Herdr startable, visible and followable from another Pi session.
//
// - Status bridge: a session waiting at any dialog shows in Herdr as blocked, not working.
// - start_agent_session: starts a separate interactive Pi session in its own Herdr tab.
// - Wake-ups: the session that started one hears when it finishes a turn, waits at a question,
//   stays working with no change for a quiet interval, or exits.
//
// - Orchestrator role: while sessions it started are open, its system prompt names it their
//   orchestrator and lists them, so work and questions on their tasks go to them.
//
// It does nothing outside the primary interactive Pi of a Herdr pane, and it never closes,
// types into or answers another session: those stay with the agent, through Herdr's own commands.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Herdr, cliRunner, type AgentView } from "./herdr.ts";
import { ORCHESTRATOR_SECTION, SCREEN_LINES, WAKEUP_TYPE, orchestratorSection, taskSummary, wakeupText } from "./messages.ts";
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

/** The slice of Pi's extension API this package uses. */
export type BridgeApi = Pick<ExtensionAPI, "on" | "registerTool" | "sendMessage" | "appendEntry" | "events">;

export interface BridgeDeps {
  herdr?: Herdr;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** The quiet interval: HERDR_BRIDGE_QUIET_INTERVAL_MS when it is a positive number of ms, else ten minutes. */
export function quietIntervalFrom(env: NodeJS.ProcessEnv): number {
  const configured = Number(env.HERDR_BRIDGE_QUIET_INTERVAL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_QUIET_INTERVAL_MS;
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

const StartParams = Type.Object({
  folder: Type.String({ description: "The folder the session works in; a relative path resolves against this session's folder." }),
  prompt: Type.String({ description: "The session's first message, sent as if typed." }),
  name: Type.Optional(Type.String({ description: "Herdr agent name: 1-32 lowercase letters, digits, - or _, starting with a letter. Defaults to one made from the folder name." })),
});

/** A session entry as this extension reads its own: only custom entries matter. */
type Entry = { type: string; customType?: string; data?: any };

/** Started sessions still to follow, from this session's own entries on its current branch. */
export function trackedFromEntries(entries: readonly Entry[], now: number): TrackedSession[] {
  const byPane = new Map<string, TrackedSession>();
  for (const entry of entries) {
    if (entry.type !== "custom" || !entry.data) continue;
    const data = entry.data;
    if (entry.customType === STARTED_ENTRY && typeof data.paneId === "string" && typeof data.name === "string") {
      const about = {
        folder: typeof data.folder === "string" ? data.folder : undefined,
        task: typeof data.task === "string" ? data.task : undefined,
      };
      byPane.set(data.paneId, track(data.name, data.paneId, now, typeof data.completionSeq === "number" ? data.completionSeq : undefined, about));
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
    const quietMs = quietIntervalFrom(env);
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
      timer = startTimer(() => {
        poll().catch((error) => {
          // A poll that throws past its own handling must not take Pi down; polling goes on.
          failures++;
          if (failures === FAILURES_BEFORE_NOTICE) notifyFailure(error);
        });
      }, POLL_MS);
    }

    function notifyFailure(error: unknown): void {
      if (!active) return;
      // It wakes the session: an idle orchestrator would otherwise wait forever for wake-ups that
      // cannot arrive. One turn, once per run of failures.
      pi.sendMessage(
        {
          customType: WAKEUP_TYPE,
          content: `herdr-bridge cannot read Herdr, so wake-ups for the sessions you started are not arriving: ${error instanceof Error ? error.message : String(error)}. It keeps trying; check the sessions with \`herdr agent list\` meanwhile.`,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }

    /** Records where a started session stands, so a reload or resume continues from there. */
    function persist(session: TrackedSession): void {
      pi.appendEntry(PHASE_ENTRY, { paneId: session.paneId, phase: session.phase, completionSeq: session.completionSeq });
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
          if (failures === FAILURES_BEFORE_NOTICE) notifyFailure(error);
          return;
        }
        failures = 0;
        if (!active) return;
        const previous = new Map(tracked.map((session) => [session.paneId, session]));
        const result = observe(tracked, agents, now(), quietMs);
        tracked = result.tracked;
        const byPane = new Map(tracked.map((session) => [session.paneId, session]));
        const persisted = new Set<string>();
        // Each wake-up is delivered before its session's new state is recorded: if the session
        // shuts down mid-delivery, a reload repeats the wake-up rather than losing it.
        for (const wakeup of result.wakeups) {
          await deliver(wakeup);
          if (!active) return;
          if (wakeup.kind === "gone") pi.appendEntry(ENDED_ENTRY, { paneId: wakeup.paneId });
          else if (byPane.has(wakeup.paneId)) {
            persist(byPane.get(wakeup.paneId)!);
            persisted.add(wakeup.paneId);
          }
        }
        for (const session of tracked) {
          const before = previous.get(session.paneId);
          const changed = before && (before.phase !== session.phase || before.completionSeq !== session.completionSeq);
          if (changed && !persisted.has(session.paneId)) persist(session);
        }
        if (tracked.length === 0) stopPolling();
      } finally {
        polling = false;
      }
    }

    function follow(session: StartedSession, prompt: string): void {
      const about = { folder: session.folder, task: taskSummary(prompt) };
      tracked = [...tracked.filter((t) => t.paneId !== session.paneId), track(session.name, session.paneId, now(), session.completionSeq, about)];
      pi.appendEntry(STARTED_ENTRY, { name: session.name, paneId: session.paneId, completionSeq: session.completionSeq, ...about, startedAt: now() });
      ensurePolling();
    }

    function registerTool(): void {
      if (toolRegistered) return;
      toolRegistered = true;
      pi.registerTool({
        name: "start_agent_session",
        label: "Start agent session",
        description:
          `Start a separate, interactive Pi agent session in its own Herdr tab, working in a folder, with a first prompt. The person can switch to it and type in it, and it keeps running on its own; this session gets a message when it finishes a turn, waits at a question, stays working for ${minutes(quietMs)} with no change, or exits. A subagent is different: a child task inside this session.`,
        promptSnippet: "Start a separate, interactive Pi session in its own Herdr tab, in a folder, with a first prompt.",
        promptGuidelines: [
          "Start every new Pi session with start_agent_session, whenever the user or a skill asks to start, spin up, open or create a session, agent session or run. Only a session it starts reports back to you when it finishes a turn, waits at a question, goes quiet or exits; one started with `herdr agent start`, `herdr tab create` or `pi` typed into a pane never does. When a request could mean either, a subagent is a child task inside this session.",
          "Follow sessions you started with Herdr's agent commands: `herdr agent list` and `herdr agent get <name>` for their state, `herdr agent read <name> --source recent --lines 80` for their output, `herdr agent prompt <name> \"<text>\"` to message one, and `herdr pane close <pane>` to stop one you started.",
        ],
        parameters: StartParams,
        async execute(_toolCallId: string, params: Static<typeof StartParams>) {
          const agentDir = env.PI_CODING_AGENT_DIR;
          const session = await startSession(herdr, params, { cwd, env: agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {} });
          follow(session, params.prompt);
          const lines = [
            `Started Pi session "${session.name}" in ${session.folder}: Herdr pane ${session.paneId}, tab ${session.tabId}, workspace ${session.workspaceId}.`,
            session.sessionPath ? `Its Pi session file: ${session.sessionPath}` : "Herdr did not report its Pi session file yet.",
            `The first prompt was sent. You will get a message when it finishes a turn, waits at a question, stays working for ${minutes(quietMs)} with no change, or exits.`,
            `You are its orchestrator: send work and questions that belong to its task to it with \`herdr agent prompt ${session.name} "<text>"\` rather than doing them yourself, and end your turn while it works.`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }], details: session };
        },
      });
    }

    pi.on("before_agent_start", (event) => {
      if (!active) return;
      const sections = event.systemPromptOptions.sections ?? {};
      const role = orchestratorSection(tracked, minutes(quietMs));
      if (role) sections[ORCHESTRATOR_SECTION] = role;
      else delete sections[ORCHESTRATOR_SECTION];
      event.systemPromptOptions.sections = sections;
    });

    pi.on("ui_prompt_start", (event) => {
      if (!active) return;
      pi.events.emit("herdr:blocked", { active: true, label: event.title || "waiting for an answer" });
    });

    pi.on("ui_prompt_end", () => {
      if (!active) return;
      pi.events.emit("herdr:blocked", { active: false });
    });

    pi.on("session_start", (_event, ctx) => {
      stopPolling();
      active = eligible(env, ctx.mode) && claimPrimary(owner);
      if (!active) return;
      cwd = ctx.cwd;
      registerTool();
      tracked = trackedFromEntries(ctx.sessionManager.getBranch() as Entry[], now());
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
