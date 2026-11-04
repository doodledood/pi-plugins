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
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { McpSlackBackend, RUNTIME_TOOL_CALL_EVENT, type SlackBackend } from "./backend.ts";
import { ConfigError, DEFAULT_CONFIG, enableInConfig, loadConfig, type SlackCompanionConfig } from "./config.ts";
import { parseSlackLink } from "./conversation.ts";
import { Engine, type EngineDeps, emptyState, type EngineState, watchLabel } from "./engine.ts";
import { parseSendResult } from "./format.ts";
import { selectForkBranch } from "./fork.ts";
import { runHelper, type HelperOutcome } from "./helper.ts";
import { LockManager } from "./locks.ts";
import { mcpCachePathIn, readOnlyMcpTools } from "./mcp-tools.ts";
import { approvedActionText, infoHandoffText, MAIN_PROMPT_SECTION, markMessage } from "./messages.ts";
import { COST_RECORD_TYPE, costOf, triageCostRecord, writeHelperRecord } from "./records.ts";
import { startShellSandbox, type ShellSandbox } from "./sandbox.ts";
import { defaultSecretPolicy } from "./secrets.ts";
import { namesSendTool, sendCallOf } from "./send-route.ts";
import { chooseTriageModel, triageContext, triageVerdict } from "./triage.ts";
import { Panel, renderLine, WIDGET_KEY, type Paint, type SurfaceState } from "./ui.ts";

export const STATE_ENTRY = "slack-companion-state";
export const HANDOFF_MESSAGE = "slack-companion-handoff";
export const PROMPT_SECTION = "slack_companion";
export const WATCH_TOOL = "slack_watch";

export interface Overrides {
  agentDir?: string;
  backend?: (pi: ExtensionAPI, config: SlackCompanionConfig) => SlackBackend;
  sandbox?: (cwd: string, config: SlackCompanionConfig) => Promise<ShellSandbox>;
  now?: () => number;
  /** Tests drive polls themselves. */
  noTimer?: boolean;
  onEngine?: (engine: Engine) => void;
  /** Sees every notice the owner would see (tests run without a UI). */
  onNotify?: (level: "info" | "warning" | "error", text: string) => void;
}

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

/** A configured Slack tool that is not among the MCP tools Pi or the adapter knows. */
function missingTool(pi: ExtensionAPI, config: SlackCompanionConfig, cachePath: string): string | undefined {
  const known = new Set(pi.getAllTools().map((t) => t.name));
  let cached = false;
  try {
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    for (const entry of Object.values<any>(cache?.servers ?? {})) for (const tool of entry?.tools ?? []) if (typeof tool?.name === "string") { known.add(tool.name); cached = true; }
  } catch {
    /* no cache yet: the adapter has not listed its servers; nothing to check against */
  }
  if (!cached) return undefined;
  for (const name of Object.values(config.tools)) {
    if (![...known].some((k) => namesSendTool(k, name))) return name;
  }
  return undefined;
}

export function activate(pi: ExtensionAPI, overrides: Overrides = {}): void {
  const agentDir = overrides.agentDir ?? getAgentDir();
  const cachePath = mcpCachePathIn(agentDir);
  const now = overrides.now ?? Date.now;
  let config: SlackCompanionConfig = { ...DEFAULT_CONFIG };
  let problem: string | undefined;
  const readConfig = () => {
    try {
      config = loadConfig(agentDir);
      problem = undefined;
    } catch (error) {
      config = { ...DEFAULT_CONFIG, enabled: false };
      problem = error instanceof ConfigError ? error.message : String(error);
    }
  };
  readConfig();

  let engine: Engine | undefined;
  let ctxRef: ExtensionContext | undefined;
  // False from session_shutdown on: work still finishing must not touch a context Pi has retired.
  let live = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let warnedUnattributed = false;
  let warnedTriage = false;
  let panelSeenAt = 0;
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
      unseenErrors: engineState.watches.filter((w) => w.status === "error" && (w.endedAt ?? 0) > panelSeenAt).length,
      now: now(),
    };
  };

  const notify = (level: "info" | "warning" | "error", text: string) => {
    if (!live) return;
    overrides.onNotify?.(level, text);
    if (ctxRef?.hasUI) ctxRef.ui.notify(text, level);
  };

  const runHelperFor: EngineDeps["runHelper"] = async ({ batch, signal }) => {
    const ctx = ctxRef;
    if (!live || !ctx?.model) throw new Error("the main session is not available");
    const sandbox = overrides.sandbox
      ? await overrides.sandbox(ctx.cwd, config)
      : await startShellSandbox({ cwd: ctx.cwd, allowedDomains: config.allowedDomains, agentDir });
    if (!sandbox.ok) notify("warning", `Slack helper runs without a shell: ${sandbox.reason}`);
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
        mcpTools: readOnlyMcpTools(cachePath, config.investigativeTools, [config.tools.sendMessage]),
        sandbox,
        secrets: defaultSecretPolicy(agentDir),
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
    const message = await ctx.modelRegistry.complete(model, triageContext(input));
    if (live) pi.appendEntry(COST_RECORD_TYPE, triageCostRecord(model.provider, model.id, message.usage));
    if (message.stopReason === "error") throw new Error(`the triage model failed: ${message.errorMessage ?? "unknown error"}`);
    return { speak: triageVerdict(message), usd: message.usage?.cost?.total ?? 0 };
  };

  const startTimer = () => {
    if (timer || !engine || !config.enabled || problem || overrides.noTimer) return;
    // The first read waits for the first tick: the adapter may still be starting at session_start.
    timer = setInterval(() => void engine?.poll().catch(() => {}), config.pollSeconds * 1000);
    timer.unref?.();
  };

  const startEngine = (ctx: ExtensionContext) => {
    ctxRef = ctx;
    live = true;
    readConfig();
    if (config.enabled && !problem && !adapterPresent(pi)) problem = "pi-mcp-adapter is not installed, so Slack cannot be read from code; slack-companion cannot watch.";
    if (config.enabled && !problem) {
      const missing = missingTool(pi, config, cachePath);
      if (missing) problem = `the Slack tool "${missing}" is not among your MCP tools; set the right name under "tools" in ~/.pi/agent/slack-companion.json.`;
    }
    if (problem) notify("error", `slack-companion: ${problem}`);
    const backend = overrides.backend ? overrides.backend(pi, config) : new McpSlackBackend(pi.events, config.tools, config.server);
    const locks = new LockManager(`${agentDir}/slack-companion/locks`, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId() }, undefined, Math.max(10 * 60_000, 5 * config.pollSeconds * 1000), now);
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
      engine.restore(saved?.type === "custom" ? (saved.data as EngineState) : undefined);
    }
    overrides.onEngine?.(engine);
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
    if (timer) clearInterval(timer);
    timer = undefined;
    engine?.dispose();
    engine = undefined;
    requestRender = undefined;
  });

  // The owner typing in main is owner input: counts reset, paused watches resume.
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
    const call = sendCallOf(event.toolName, event.input as Record<string, unknown>, config.tools.sendMessage);
    if (!call || !engine.sendWillBeWatched(call.channelId, call.threadTs)) return;
    if (config.marker && call.message.startsWith(`${config.marker} `)) return; // already marked (a proxy's nested call)
    let ownerName = "the owner";
    try {
      ownerName = (await engine.owner()).name;
    } catch {
      /* the watch will report the backend problem; mark with a neutral name */
    }
    call.setMessage(markMessage(call.message, config.marker, ownerName, !engine.agentLineSentFor(call.channelId, call.threadTs)));
  });

  pi.on("tool_result", async (event) => {
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
        notify("warning", "Slack: a message was sent but its result named no message, so its conversation is not watched.");
      }
      return;
    }
    await engine.onMainSend({ channelId: sent.channelId, ts: sent.ts, addressedTo: call.channelId, text: call.message, ...(call.threadTs ? { threadTs: call.threadTs } : {}) });
  });

  const attachLink = async (link: string): Promise<string> => {
    if (problem) return `slack-companion cannot watch: ${problem}`;
    if (!config.enabled) return "slack-companion is off; /slack on turns it on.";
    const parsed = parseSlackLink(link);
    if (!parsed) return `Not a Slack message link: ${link}`;
    const watch = await engine?.attach(parsed);
    return watch ? `Watching ${watch.partner?.name ? `the conversation with ${watch.partner.name}` : "that conversation"}.` : "Could not watch that conversation (see the notice).";
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
      if (params.action === "watch") text = await attachLink(params.link);
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
    panelSeenAt = now();
    requestRender?.();
    await ctx.ui.custom<void>((tui, theme, _kb, done) => new Panel(surface, paintFrom(theme), (action) => {
      if (!engine) return;
      engine.ownerInput();
      if (action.kind === "approve") void engine.approve(action.id).catch((e) => notify("error", `Slack: approving failed: ${(e as Error).message}`));
      else if (action.kind === "deny") void engine.deny(action.id).catch((e) => notify("error", `Slack: declining failed: ${(e as Error).message}`));
      else if (action.kind === "stop") engine.stop(action.key);
      else if (action.kind === "resume") engine.resume(action.key);
      else engine.rewatch(action.key);
      tui.requestRender();
    }, () => done(), tui), { overlay: true, overlayOptions: { maxHeight: "80%" } });
    panelSeenAt = now();
    requestRender?.();
  };

  pi.registerCommand("slack", {
    description: "Slack companion: /slack (panel) · /slack <link> · /slack on · /slack off · /slack stop",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) return openPanel(ctx);
      if (arg === "on") {
        enableInConfig(agentDir);
        readConfig();
        if (config.enabled && !problem && !adapterPresent(pi)) problem = "pi-mcp-adapter is not installed, so Slack cannot be read from code; slack-companion cannot watch.";
        if (problem) {
          notify("error", `slack-companion is on, but cannot watch: ${problem}`);
          return;
        }
        if (engine && !engine.liveWatches().length) {
          const saved = [...(ctx.sessionManager.getBranch() as SessionEntry[])].reverse().find((e) => e.type === "custom" && e.customType === STATE_ENTRY);
          engine.restore(saved?.type === "custom" ? (saved.data as EngineState) : undefined);
        }
        engine?.setAutoStart(true);
        startTimer();
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
      notify("info", await attachLink(arg));
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
