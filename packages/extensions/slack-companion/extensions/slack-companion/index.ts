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
import { Type } from "typebox";
import { McpSlackBackend, RUNTIME_TOOL_CALL_EVENT, type SlackBackend } from "./backend.ts";
import { ConfigError, DEFAULT_CONFIG, enableInConfig, loadConfig, type SlackCompanionConfig } from "./config.ts";
import { parseSlackLink } from "./conversation.ts";
import { Engine, type EngineDeps, type EngineState } from "./engine.ts";
import { selectForkBranch } from "./fork.ts";
import { runHelper, type HelperBatch, type HelperOutcome } from "./helper.ts";
import { LockManager } from "./locks.ts";
import { approvedActionText, infoHandoffText, MAIN_PROMPT_SECTION, markMessage } from "./messages.ts";
import { parseSendResult } from "./format.ts";
import { COST_RECORD_TYPE, costOf, triageCostRecord, writeHelperRecord } from "./records.ts";
import { startShellSandbox, type ShellSandbox } from "./sandbox.ts";
import { defaultSecretPolicy } from "./secrets.ts";
import { sendCallOf } from "./send-route.ts";
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
  return { fg: (color, text) => theme.fg(color as any, text), bold: (text) => theme.bold(text) };
}

/** Is pi-mcp-adapter listening for code calls? Any listener answers synchronously; no network. */
function adapterPresent(pi: ExtensionAPI): boolean {
  const probe: { version: 0; tool: string; result?: Promise<unknown> } = { version: 0, tool: "slack-companion-probe" };
  pi.events.emit(RUNTIME_TOOL_CALL_EVENT, probe);
  probe.result?.catch(() => {});
  return probe.result !== undefined;
}

export function activate(pi: ExtensionAPI, overrides: Overrides = {}): void {
  const agentDir = overrides.agentDir ?? getAgentDir();
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
  let timer: ReturnType<typeof setInterval> | undefined;
  let requestRender: (() => void) | undefined;
  let warnedUnattributed = false;
  // The main session's prompt options as of its last turn: the helper rebuilds the same skills and context files.
  let lastPromptOptions: BuildSystemPromptOptions | undefined;

  const surface = (): SurfaceState => ({
    enabled: config.enabled,
    ...(problem ? { problem } : {}),
    engine: engine?.snapshot() ?? { version: 1, autoStart: true, watches: [], approvals: [], ledger: [], tombstones: [] },
    panelKey: config.panelKey,
  });

  const notify = (level: "info" | "warning" | "error", text: string) => {
    overrides.onNotify?.(level, text);
    if (ctxRef?.hasUI) ctxRef.ui.notify(text, level);
  };

  const runHelperFor: EngineDeps["runHelper"] = async ({ batch }: { batch: HelperBatch }) => {
    const ctx = ctxRef;
    if (!ctx?.model) throw new Error("the main session has no model");
    const sandbox = overrides.sandbox
      ? await overrides.sandbox(ctx.cwd, config)
      : await startShellSandbox({ cwd: ctx.cwd, allowedDomains: config.allowedDomains, agentDir });
    if (!sandbox.ok) notify("warning", `Slack helper runs without a shell: ${sandbox.reason}`);
    const outcome: HelperOutcome = await runHelper({
      cwd: ctx.cwd,
      agentDir,
      model: ctx.model,
      thinkingLevel: pi.getThinkingLevel(),
      streamSimple: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
      branch: selectForkBranch(ctx.sessionManager.getBranch() as SessionEntry[], ctx.isIdle()),
      systemPromptOptions: lastPromptOptions ?? { cwd: ctx.cwd },
      events: pi.events,
      mainTools: pi.getAllTools(),
      investigativeTools: config.investigativeTools,
      slackToolNames: Object.values(config.tools),
      ...(config.server ? { mcpServer: config.server } : {}),
      sandbox,
      secrets: defaultSecretPolicy(),
    }, batch);
    const recorded = writeHelperRecord(ctx.sessionManager.getSessionFile(), ctx.cwd, outcome.ownEntries);
    if (!recorded && outcome.ownEntries.length && !warnedUnattributed) {
      warnedUnattributed = true;
      notify("info", "Slack helper spend is not attributable: this session is not saved to a file.");
    }
    return { ...outcome, usd: costOf(outcome.ownEntries) };
  };

  const triageFor: EngineDeps["triage"] = async ({ watch, batch, addressed, ownerName }) => {
    const ctx = ctxRef;
    if (!ctx?.model) throw new Error("the main session has no model");
    const { model, note } = chooseTriageModel(config.triageModel, ctx.model, ctx.modelRegistry.getAvailable());
    if (note) notify("info", `Slack: ${note}`);
    const ownPosts = new Set(watch.ownPosts);
    const context = triageContext({
      label: watch.label,
      ownerName,
      addressed,
      agentMessages: watch.context.filter((m) => ownPosts.has(m.ts)).slice(-3),
      recent: watch.context.filter((m) => !batch.some((b) => b.ts === m.ts)).slice(-6),
      batch,
    });
    const message = await ctx.modelRegistry.complete(model, context, {} as any);
    pi.appendEntry(COST_RECORD_TYPE, triageCostRecord(model.provider, model.id, message.usage));
    if (message.stopReason === "error") throw new Error(`triage model failed: ${message.errorMessage ?? "unknown error"}`);
    return { speak: triageVerdict(message), usd: message.usage?.cost?.total ?? 0 };
  };

  const startEngine = (ctx: ExtensionContext) => {
    ctxRef = ctx;
    readConfig();
    if (config.enabled && !adapterPresent(pi)) problem = "pi-mcp-adapter is not installed, so Slack cannot be read from code; slack-companion cannot watch.";
    if (problem) notify("error", `slack-companion: ${problem}`);
    const backend = overrides.backend ? overrides.backend(pi, config) : new McpSlackBackend(pi.events, config.tools, config.server);
    const locks = new LockManager(`${agentDir}/slack-companion/locks`, { pid: process.pid, sessionId: ctx.sessionManager.getSessionId() });
    engine = new Engine({
      backend,
      config: () => config,
      now: overrides.now ?? Date.now,
      persist: (state: EngineState) => pi.appendEntry(STATE_ENTRY, state),
      notify,
      changed: () => requestRender?.(),
      deliverInfo: ({ watch, senders, text }) => pi.sendMessage(
        { customType: HANDOFF_MESSAGE, content: infoHandoffText({ label: watch.label, senders, text }), display: true, details: { kind: "info", watch: watch.key } },
        { triggerTurn: true, deliverAs: "steer" },
      ),
      deliverApproved: ({ watch, approval, ownerName }) => pi.sendMessage(
        { customType: HANDOFF_MESSAGE, content: approvedActionText({ label: watch.label, requester: approval.requester, ownerName, text: approval.text }), display: true, details: { kind: "approved", watch: watch.key, approval: approval.id } },
        { triggerTurn: true, deliverAs: "steer" },
      ),
      triage: triageFor,
      runHelper: runHelperFor,
      locks,
    });
    const saved = [...(ctx.sessionManager.getBranch() as SessionEntry[])].reverse().find((e) => e.type === "custom" && e.customType === STATE_ENTRY);
    engine.restore(saved?.type === "custom" ? (saved.data as EngineState) : undefined);
    overrides.onEngine?.(engine);
    if (ctx.hasUI) {
      ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
        requestRender = () => tui.requestRender();
        return { invalidate() {}, render: (width: number) => renderLine(surface(), paintFrom(theme), width) };
      });
    }
    if (config.enabled && !problem && !overrides.noTimer) {
      timer = setInterval(() => void engine?.poll(), config.pollSeconds * 1000);
      timer.unref?.();
      void engine.poll();
    }
  };

  pi.on("session_start", (_event, ctx) => startEngine(ctx));
  pi.on("session_shutdown", () => {
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
    lastPromptOptions = { ...event.systemPromptOptions };
    const sections = event.systemPromptOptions.sections ?? {};
    if (config.enabled) sections[PROMPT_SECTION] = MAIN_PROMPT_SECTION;
    else delete sections[PROMPT_SECTION];
    event.systemPromptOptions.sections = sections;
  });

  // Mark every message main sends into a watched conversation, or one that starts a watch.
  pi.on("tool_call", async (event) => {
    if (!config.enabled || problem || !engine) return;
    const call = sendCallOf(event.toolName, event.input as Record<string, unknown>, config.tools.sendMessage);
    if (!call || !engine.sendWillBeWatched(call.channelId, call.threadTs)) return;
    if (config.marker && call.message.startsWith(`${config.marker} `)) return; // already marked (the proxy's nested call)
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
      return; // not a send result (an error text, or the proxy's wrapper); the nested call carries it
    }
    await engine.onMainSend({ channelId: sent.channelId, ts: sent.ts, ...(call.threadTs ? { threadTs: call.threadTs } : {}) });
  });

  const attachLink = async (link: string): Promise<string> => {
    if (!config.enabled) return "slack-companion is off; /slack on turns it on.";
    if (problem) return `slack-companion cannot watch: ${problem}`;
    const parsed = parseSlackLink(link);
    if (!parsed) return `Not a Slack message link: ${link}`;
    const watch = await engine?.attach(parsed);
    return watch ? `Watching ${watch.label}.` : "Could not watch that conversation (see the notice).";
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
        const key = parsed ? `${parsed.channelId}/${parsed.threadTs ?? parsed.messageTs}` : undefined;
        if (key && engine?.watch(key)) {
          engine.stop(key, "stopped by the session");
          text = "Stopped watching.";
        } else text = "That conversation is not being watched.";
      }
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  const openPanel = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    await ctx.ui.custom<void>((tui, theme, _kb, done) => new Panel(surface, paintFrom(theme), (action) => {
      if (!engine) return;
      engine.ownerInput();
      if (action.kind === "approve") void engine.approve(action.id);
      else if (action.kind === "deny") void engine.deny(action.id);
      else if (action.kind === "stop") engine.stop(action.key);
      else engine.resume(action.key);
    }, () => done(), tui), { overlay: true });
  };

  pi.registerCommand("slack", {
    description: "Slack companion: /slack (panel) · /slack <link> · /slack on · /slack off · /slack stop",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (!arg) return openPanel(ctx);
      if (arg === "on") {
        enableInConfig(agentDir);
        if (timer) clearInterval(timer);
        engine?.dispose();
        startEngine(ctx);
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
      notify("info", await attachLink(arg));
    },
  });

  pi.registerShortcut(config.panelKey as any, {
    description: "Open the Slack companion panel",
    handler: (ctx) => openPanel(ctx),
  });
}

export default function slackCompanion(pi: ExtensionAPI): void {
  activate(pi);
}
