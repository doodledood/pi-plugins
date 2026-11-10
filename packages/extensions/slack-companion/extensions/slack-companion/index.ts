/**
 * slack-companion — people on Slack work with a running Pi session directly.
 *
 * A plain-code poll watches the Slack conversations this session takes part in. For each batch
 * of new messages worth answering, a read-only, sandboxed fork of the session answers in the
 * thread; information goes to the main session as the sender's words, and anything that would
 * change the owner's work waits for the owner's approval. Decisions: docs/adr/*slack*.
 */
import type { BuildSystemPromptOptions, ExtensionAPI, ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { McpSlackBackend, RUNTIME_TOOL_CALL_EVENT, type SlackBackend } from "./backend.ts";
import { ConfigError, DEFAULT_CONFIG, enableInConfig, loadConfig, type SlackCompanionConfig } from "./config.ts";
import { parseSlackLink } from "./conversation.ts";
import { Engine, type EngineDeps, emptyState, type EngineState, StoppedConversationError, watchLabel } from "./engine.ts";
import { parseSendResult } from "./format.ts";
import { selectForkBranch } from "./fork.ts";
import { runHelper, type HelperOutcome } from "./helper.ts";
import { LockManager } from "./locks.ts";
import { type HelperMcpReach, helperMcpTools, mcpCachePathIn, missingSlackTools, readMcpCache, slackServers } from "./mcp-tools.ts";
import { approvedActionText, infoHandoffText, MAIN_PROMPT_SECTION, markMessage } from "./messages.ts";
import { COST_RECORD_TYPE, costOf, pruneOrphanRecords, triageCostRecord, writeHelperRecord } from "./records.ts";
import { startShellSandbox, type SandboxRuntime } from "./sandbox.ts";
import { openedFolders, readPolicy, stripControl } from "./secrets.ts";
import { sendCallOf } from "./send-route.ts";
import { chooseTriageModel, triageContext, triageVerdict } from "./triage.ts";
import { Panel, PANEL_HEIGHT_PERCENT, panelRows, renderLine, WIDGET_KEY, type Paint, type PanelAction, type SurfaceProblem, type SurfaceState } from "./ui.ts";

export const STATE_ENTRY = "slack-companion-state";
export const HANDOFF_MESSAGE = "slack-companion-handoff";
export const PROMPT_SECTION = "slack_companion";
export const WATCH_TOOL = "slack_watch";

export interface Overrides {
  agentDir?: string;
  /** The home folder whose secret locations the helper may not read (default: the real one). */
  home?: string;
  backend?: (pi: ExtensionAPI, config: SlackCompanionConfig) => SlackBackend;
  /** sandbox-runtime itself; the package's own policy and options still flow through startShellSandbox. */
  sandboxRuntime?: SandboxRuntime;
  /** The platform the shell sandbox is built for (default: this machine's). */
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Starts and clears the poll timer; tests pass one that records and never fires, and drive polls themselves. */
  scheduler?: Scheduler;
  onEngine?: (engine: Engine) => void;
  /** Sees every notice the owner would see (tests run without a UI). */
  onNotify?: (level: "info" | "warning" | "error", text: string) => void;
}

export interface Scheduler {
  start(run: () => void, everyMs: number): unknown;
  stop(handle: unknown): void;
}

const realScheduler: Scheduler = {
  start(run, everyMs) {
    const handle = setInterval(run, everyMs);
    handle.unref?.();
    return handle;
  },
  stop(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function paintFrom(theme: Theme): Paint {
  return { fg: (color, text) => theme.fg(color, text), bold: (text) => theme.bold(text) };
}

/** Is pi-mcp-adapter listening for code calls? Any listener answers synchronously; no network. */
function adapterPresent(pi: ExtensionAPI): boolean {
  const probe: { version: 0; tool: string; result?: Promise<unknown> } = { version: 0, tool: "slack-companion-probe" };
  pi.events.emit(RUNTIME_TOOL_CALL_EVENT, probe);
  probe.result?.catch(() => {});
  return probe.result !== undefined;
}

const ADAPTER_MISSING = "pi-mcp-adapter is not installed, so Slack cannot be read from code; slack-companion cannot watch.";

/** A key the owner pressed in the panel: owner input first (it is the owner acting), then the action. */
export async function applyPanelAction(engine: Engine, action: PanelAction): Promise<void> {
  engine.ownerInput();
  switch (action.kind) {
    case "approve": return engine.approve(action.id);
    case "deny": return engine.deny(action.id);
    case "stop": return engine.stop(action.key);
    case "resume": return engine.resume(action.key);
    case "rewatch": return engine.rewatch(action.key);
    default: {
      const unhandled: never = action;
      throw new Error(`unhandled panel action ${JSON.stringify(unhandled)}`);
    }
  }
}

export function activate(pi: ExtensionAPI, overrides: Overrides = {}): void {
  const agentDir = overrides.agentDir ?? getAgentDir();
  const home = overrides.home ?? homedir();
  const cachePath = mcpCachePathIn(agentDir);
  const now = overrides.now ?? Date.now;
  let config: SlackCompanionConfig = { ...DEFAULT_CONFIG };
  let problem: SurfaceProblem | undefined;
  const readConfig = () => {
    try {
      config = loadConfig(agentDir);
      problem = undefined;
    } catch (error) {
      config = { ...DEFAULT_CONFIG, enabled: false };
      problem = { title: "its config has an error", detail: error instanceof ConfigError ? error.message : String(error) };
    }
  };
  readConfig();

  let engine: Engine | undefined;
  let ctxRef: ExtensionContext | undefined;
  // False from session_shutdown on: work still finishing must not touch a context Pi has retired.
  let live = false;
  const scheduler = overrides.scheduler ?? realScheduler;
  let timer: unknown;
  let requestRender: (() => void) | undefined;
  let warnedUnattributed = false;
  let warnedTriage = false;
  let warnedCache = false;
  // Send calls this package marked, so the nested call a proxy makes for one is not marked again.
  const markedCalls = new Set<string>();
  // The main session's prompt options as of its last turn: the helper rebuilds the same skills and context files.
  let lastPromptOptions: BuildSystemPromptOptions | undefined;

  const surface = (): SurfaceState => {
    const engineState = engine?.snapshot() ?? emptyState();
    return {
      enabled: config.enabled,
      ...(problem ? { problem } : {}),
      engine: engineState,
      panelKey: config.panelKey,
      answering: new Set(engineState.watches.filter((w) => engine?.isAnswering(w.key)).map((w) => w.key)),
      seenErrors: new Set(engineState.seenErrors ?? []),
      now: now(),
    };
  };

  // Every notice goes through here; it may quote Slack or adapter text, so control codes go first.
  const notify = (level: "info" | "warning" | "error", raw: string) => {
    if (!live) return;
    const text = stripControl(raw);
    overrides.onNotify?.(level, text);
    if (ctxRef?.hasUI) ctxRef.ui.notify(text, level);
  };

  /** The helper's MCP reach: every read-only tool and the owner's investigative list; main's active ones shown directly. */
  const mcpToolsForHelper = (): HelperMcpReach => {
    try {
      const cache = readMcpCache(cachePath);
      return helperMcpTools(cache, new Set(pi.getActiveTools()), config.investigativeTools, {
        blocked: [config.tools.sendMessage],
        // The owner's own Slack (search, other channels, private messages) is not read for people in
        // a watched conversation unless he lists those tools: his other conversations are his.
        // The servers in config.privateServers likewise (always the ones that drive his logged-in
        // browser and the reference file server, plus his own): their read-only tools see cookies,
        // auth headers, private pages and files.
        privateServers: [...slackServers(cache, Object.values(config.tools), config.server), ...config.privateServers],
      });
    } catch (error) {
      if (!warnedCache) {
        warnedCache = true;
        notify("warning", `Slack helper runs without MCP tools: pi-mcp-adapter's tool cache could not be read (${(error as Error).message}).`);
      }
      return { catalog: [], direct: [] };
    }
  };

  let lastNoShellReason: string | undefined;
  const runHelperFor: EngineDeps["runHelper"] = async ({ batch, signal }) => {
    const ctx = ctxRef;
    if (!live || !ctx?.model) throw new Error("the main session is not available");
    // The owner's readable folders, with ~ meaning his home.
    const readable = config.readableFolders.map((f) => (f.startsWith("~/") ? join(home, f.slice(2)) : f));
    const sandbox = await startShellSandbox({ cwd: ctx.cwd, allowedDomains: config.allowedDomains, agentDir, home, readable, ...(overrides.platform ? { platform: overrides.platform } : {}) }, overrides.sandboxRuntime);
    if (signal.aborted) {
      if (sandbox.ok) await sandbox.dispose();
      throw new Error("the helper was stopped before it answered");
    }
    // Said once per reason: on Linux every run has no shell, and a warning per run would be noise.
    if (!sandbox.ok && sandbox.reason !== lastNoShellReason) notify("warning", `Slack helper runs without a shell: ${sandbox.reason}`);
    lastNoShellReason = sandbox.ok ? undefined : sandbox.reason;
    const sections = { ...(lastPromptOptions?.sections ?? {}) };
    delete sections[PROMPT_SECTION];
    let outcome: HelperOutcome;
    try {
      outcome = await runHelper({
        cwd: ctx.cwd,
        agentDir,
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
        streamSimple: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
        branch: selectForkBranch(ctx.sessionManager.getBranch() as SessionEntry[], ctx.isIdle()),
        systemPromptOptions: { ...(lastPromptOptions ?? { cwd: ctx.cwd }), sections },
        events: pi.events,
        mcpTools: mcpToolsForHelper(),
        sandbox,
        reads: readPolicy({ home, agentDir, roots: openedFolders({ home, agentDir, cwd: ctx.cwd, readable }) }),
      }, batch, signal);
    } finally {
      if (sandbox.ok) await sandbox.dispose();
    }
    if (!live) return { ...outcome, usd: costOf(outcome.ownEntries) };
    const recorded = writeHelperRecord(ctx.sessionManager.getSessionFile(), ctx.cwd, outcome.ownEntries);
    if (!recorded && outcome.ownEntries.length && !warnedUnattributed) {
      warnedUnattributed = true;
      notify("info", "Slack helper spend is not attributable: this session is not saved to a file.");
    }
    return { ...outcome, usd: costOf(outcome.ownEntries) };
  };

  const triageFor: EngineDeps["triage"] = async (input) => {
    const ctx = ctxRef;
    if (!live || !ctx?.model) throw new Error("the main session is not available");
    const { model, note } = chooseTriageModel(config.triageModel, ctx.model, ctx.modelRegistry.getAvailable());
    if (note && !warnedTriage) {
      warnedTriage = true;
      notify("info", `Slack: ${note}`);
    }
    // streamSimple, not complete: only streamSimple routes a virtual model to a real one.
    const message = await ctx.modelRegistry.streamSimple(model, triageContext(input)).result();
    if (live) pi.appendEntry(COST_RECORD_TYPE, triageCostRecord(model.provider, model.id, message.usage));
    if (message.stopReason === "error") throw new Error(`the triage model failed: ${message.errorMessage ?? "unknown error"}`);
    return { speak: triageVerdict(message), usd: message.usage?.cost?.total ?? 0 };
  };

  const startTimer = () => {
    if (timer !== undefined || !engine || !config.enabled || problem) return;
    // The first read waits for the first tick: the adapter may still be starting at session_start.
    timer = scheduler.start(() => {
      void engine?.poll().catch((error) => notify("error", `Slack: a poll failed: ${(error as Error).message}`));
    }, config.pollSeconds * 1000);
  };

  /** Read the config and check what watching needs; the one path both session start and /slack on take. */
  const checkReady = () => {
    readConfig();
    if (!config.enabled || problem) return;
    if (!adapterPresent(pi)) {
      problem = { title: "pi-mcp-adapter is not installed", detail: ADAPTER_MISSING };
      return;
    }
    try {
      const missing = missingSlackTools(readMcpCache(cachePath), Object.values(config.tools), config.server);
      if (missing.length) problem = { title: `Slack tool name${missing.length === 1 ? "" : "s"} not found`, detail: `the Slack tool${missing.length === 1 ? "" : "s"} ${missing.map((m) => `"${m}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} not among your Slack server's MCP tools; set the right name under "tools" in ${agentDir}/slack-companion.json.` };
    } catch (error) {
      problem = { title: "pi-mcp-adapter's tool cache is unreadable", detail: `pi-mcp-adapter's tool cache could not be read: ${(error as Error).message}` };
    }
  };

  /** Build the engine for this session from the config as it is now. */
  const startEngine = (ctx: ExtensionContext) => {
    ctxRef = ctx;
    live = true;
    if (timer !== undefined) scheduler.stop(timer);
    timer = undefined;
    engine?.dispose();
    checkReady();
    if (problem) notify("error", `slack-companion: ${problem.detail}`);
    const backend = overrides.backend ? overrides.backend(pi, config) : new McpSlackBackend(pi.events, config.tools, config.server);
    const locks = new LockManager(`${agentDir}/slack-companion/locks`, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId() });
    try {
      locks.sweep();
    } catch (error) {
      // Old lock folders stay; watching works the same. Said, not hidden.
      notify("warning", `Slack: old lock folders could not be removed: ${error instanceof Error ? error.message : String(error)}`);
    }
    engine = new Engine({
      backend,
      config: () => config,
      now,
      persist: (state: EngineState) => { if (live) pi.appendEntry(STATE_ENTRY, state); },
      notify,
      changed: () => requestRender?.(),
      deliverInfo: ({ watch, senders, text }) => {
        if (!live) return;
        pi.sendMessage(
          { customType: HANDOFF_MESSAGE, content: infoHandoffText({ label: watchLabel(watch), senders, text }), display: true, details: { kind: "info", watch: watch.key } },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
      deliverApproved: ({ approval, ownerName }) => {
        if (!live) return;
        pi.sendMessage(
          { customType: HANDOFF_MESSAGE, content: approvedActionText({ label: approval.label, requester: approval.requester, ownerName, text: approval.text }), display: true, details: { kind: "approved", watch: approval.watchKey, approval: approval.id } },
          { triggerTurn: true, deliverAs: "steer" },
        );
      },
      triage: triageFor,
      runHelper: runHelperFor,
      locks,
    });
    // A disabled package holds nothing: no restored watch, no lock.
    if (config.enabled && !problem) {
      const saved = [...(ctx.sessionManager.getBranch() as SessionEntry[])].reverse().find((e) => e.type === "custom" && e.customType === STATE_ENTRY);
      const restored = engine.restore(saved?.type === "custom" ? saved.data : undefined);
      if (!restored.ok) {
        const lost = restored.lostWatches.length ? `: ${restored.lostWatches.join(", ")}. Watch them again with /slack <link>` : "";
        const kept = restored.keptRequests ? ` The ${restored.keptRequests} request${restored.keptRequests === 1 ? "" : "s"} waiting for you ${restored.keptRequests === 1 ? "was" : "were"} kept.` : "";
        const off = restored.autoStart ? "" : " Automatic starts are off until you run /slack on.";
        notify("warning", `slack-companion: this session's saved Slack watches came from another version of the package and were not restored${lost}.${kept}${off}`);
      }
    }
    overrides.onEngine?.(engine);
    // Helper records of deleted sessions are removed when a session starts (Pi leaves them behind).
    if (config.enabled) {
      try {
        pruneOrphanRecords(ctx.sessionManager.getSessionFile());
      } catch (error) {
        notify("warning", `slack-companion: could not clean up the records of deleted sessions: ${(error as Error).message}`);
      }
    }
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        requestRender = () => tui.requestRender();
        return { invalidate() {}, render: (width: number) => renderLine(surface(), paintFrom(theme), width) };
      });
    }
    startTimer();
  };

  pi.on("session_start", (_event, ctx) => startEngine(ctx));
  pi.on("session_shutdown", () => {
    live = false;
    if (timer !== undefined) scheduler.stop(timer);
    timer = undefined;
    engine?.dispose();
    engine = undefined;
    requestRender = undefined;
  });

  // The owner typing in main is owner input: send counts reset, and watches paused for the send limit resume.
  pi.on("input", (event) => {
    if (event.source === "interactive") engine?.ownerInput();
  });

  pi.on("before_agent_start", (event) => {
    const sections = event.systemPromptOptions.sections ?? {};
    if (config.enabled && !problem) sections[PROMPT_SECTION] = MAIN_PROMPT_SECTION;
    else delete sections[PROMPT_SECTION];
    event.systemPromptOptions.sections = sections;
    lastPromptOptions = { ...event.systemPromptOptions, sections: { ...sections } };
  });

  // Mark every message main sends into a watched conversation, or one that starts a watch.
  pi.on("tool_call", async (event) => {
    if (!config.enabled || problem || !engine) return;
    // A proxy's nested call carries the message this package already marked in its parent call.
    if (event.parentToolCallId && markedCalls.has(event.parentToolCallId)) return;
    const call = sendCallOf(event.toolName, event.input as Record<string, unknown>, config.tools.sendMessage);
    if (!call || !engine.sendWillBeWatched(call.channelId, call.threadTs)) return;
    markedCalls.add(event.toolCallId);
    const marked = markMessage(call.message, config.marker);
    call.setMessage(marked);
    engine.mainSendStarting(event.toolCallId, { text: marked, channelId: call.channelId, ...(call.threadTs ? { threadTs: call.threadTs } : {}) });
  });

  pi.on("tool_result", async (event) => {
    markedCalls.delete(event.toolCallId);
    if (!config.enabled || problem || !engine || event.isError) return;
    const call = sendCallOf(event.toolName, event.input, config.tools.sendMessage);
    if (!call) return;
    const text = event.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    let sent: { channelId: string; ts: string };
    try {
      sent = parseSendResult(text);
    } catch {
      if (!event.parentToolCallId && !/message_context/.test(text)) {
        // A send whose result names no message: the watch cannot start, so say so rather than stay silent.
        notify("warning", "Slack: a message was sent but its result named no message, so a conversation it would start is not watched.");
      }
      return;
    }
    await engine.onMainSend({ channelId: sent.channelId, ts: sent.ts, addressedTo: call.channelId, text: call.message, ...(call.threadTs ? { threadTs: call.threadTs } : {}) });
    engine.mainSendRecorded(event.toolCallId);
  });

  /**
   * Watch a conversation by its link. The owner's /slack may restart one that someone stopped; the
   * model-callable tool may not, since main's model can be steered by what a hand-off quotes.
   */
  const attachLink = async (link: string, byOwner: boolean): Promise<string> => {
    if (problem) return `slack-companion cannot watch: ${problem.detail}`;
    if (!config.enabled) return "slack-companion is off; /slack on turns it on.";
    const parsed = parseSlackLink(link);
    if (!parsed) return `Not a Slack message link: ${link}`;
    let watch;
    try {
      watch = await engine?.attach(parsed, { byOwner });
    } catch (error) {
      if (error instanceof StoppedConversationError) return error.message;
      return `Could not watch that conversation: ${(error as Error).message}`;
    }
    if (!watch) return "Could not watch that conversation (see the notice).";
    return byOwner && watch.partner?.name ? `Watching the conversation with ${watch.partner.name}.` : "Watching that conversation.";
  };

  pi.registerTool({
    name: WATCH_TOOL,
    label: "Watch a Slack conversation",
    description: "Watch a Slack conversation someone else started (by its message link) so that a read-only helper forked from this session answers there, or stop watching one. Conversations this session starts by sending a Slack message are watched already.",
    promptSnippet: "Watch, or stop watching, a Slack conversation by its link",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("watch"), Type.Literal("stop")]),
      link: Type.String({ description: "The Slack message link (…/archives/<channel>/p<ts>[?thread_ts=…])." }),
    }),
    async execute(_id, params) {
      let text: string;
      if (params.action === "watch") text = await attachLink(params.link, false);
      else {
        const parsed = parseSlackLink(params.link);
        text = parsed && engine?.stopLink(parsed, "stopped by the session") ? "Stopped watching." : "That conversation is not being watched.";
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  const openPanel = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) {
      notify("info", "The Slack panel needs Pi's interactive screen.");
      return;
    }
    await ctx.ui.custom<void>((tui, theme, _kb, done) => new Panel(surface, paintFrom(theme), (action) => {
      if (!engine) return;
      void applyPanelAction(engine, action).catch((e) => notify("error", `Slack: ${action.kind} failed: ${(e as Error).message}`));
      tui.requestRender();
    }, () => done(), tui, () => panelRows(tui.terminal.rows), (ids) => engine?.markErrorsSeen(ids)), { overlay: true, overlayOptions: { maxHeight: `${PANEL_HEIGHT_PERCENT}%` } });
  };

  pi.registerCommand("slack", {
    description: "Slack companion: /slack (panel) · /slack <link> · /slack on · /slack off · /slack stop",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) return openPanel(ctx);
      if (arg === "on") {
        const wasReady = config.enabled && !problem;
        enableInConfig(agentDir);
        if (wasReady) engine?.setAutoStart(true);
        else startEngine(ctx);
        if (problem) return; // startEngine said why it cannot watch
        engine?.setAutoStart(true);
        notify("info", "slack-companion is on: a Slack message this session sends now starts a watch.");
        return;
      }
      if (arg === "off") {
        engine?.setAutoStart(false);
        notify("info", "Slack messages this session sends no longer start watches (/slack on turns it back on).");
        return;
      }
      if (arg === "stop") {
        engine?.stopAll();
        notify("info", "Stopped watching every Slack conversation in this session.");
        return;
      }
      notify("info", await attachLink(arg, true));
    },
  });

  pi.registerShortcut(config.panelKey, {
    description: "Open the Slack companion panel",
    handler: (ctx) => openPanel(ctx),
  });
}

export default function slackCompanion(pi: ExtensionAPI): void {
  activate(pi);
}
