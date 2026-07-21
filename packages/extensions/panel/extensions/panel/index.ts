// /panel — parallel multi-model consultation for pi.
//
// `/panel <question>` forks the current conversation's context, runs the
// question through several independently-running panelist models in parallel
// (isolated in-process SDK sessions, prompt-level read-only guardrails), and
// returns each panelist's final answer verbatim and attributed into the main
// session before the main model responds. Honest framing: independent peer
// opinions over shared history — not clean-room re-derivation.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";
import { forkMessagesFromEntries, type ContextEntryLike } from "./fork.ts";
import { spawnPanelistSession } from "./host.ts";
import { panelistSystemPrompt } from "./prompts.ts";
import { buildInjectionPlan, ANSWER_MESSAGE_TYPE, META_ENTRY_TYPE } from "./results.ts";
import { runPanel } from "./runner.ts";
import type { PanelistSpec, PanelistState, SpawnPanelist } from "./types.ts";
import {
  formatCost,
  formatDuration,
  formatTokens,
  formatWidgetLines,
  OverlayModel,
  PanelInspectOverlay,
  PanelPickerComponent,
  PickerState,
} from "./ui.ts";

const WIDGET_KEY = "panel";
const WIDGET_TICK_MS = 1_000;

interface PanelDeps {
  spawn: SpawnPanelist;
  /** Session storage dir override for panelist sessions (tests/smokes). */
  sessionDir?: string;
  /** Config file override (tests/smokes); default is ~/.pi/agent/panel.json. */
  configPath?: string;
}

/** Live run state shared between the command handler and the inspect shortcut. */
interface ActiveRun {
  states: readonly PanelistState[];
}

export function activate(pi: ExtensionAPI, deps: PanelDeps = { spawn: spawnPanelistSession }): void {
  let activeRun: ActiveRun | undefined;

  registerRenderers(pi);

  pi.registerCommand("panel", {
    description: "Consult a panel of independent models in parallel over a fork of this conversation",
    handler: async (args, ctx) => {
      await runPanelCommand(pi, ctx, args ?? "", deps, {
        setActiveRun: (run) => {
          activeRun = run;
        },
      });
    },
  });

  const { config } = loadConfig();
  pi.registerShortcut(config.inspectKeybinding as KeyId, {
    description: "Inspect a running panelist",
    handler: async (ctx) => {
      if (!activeRun || !ctx.hasUI) return;
      const model = new OverlayModel(activeRun.states);
      await ctx.ui.custom<undefined>(
        (_tui, theme, _keybindings, done) => new PanelInspectOverlay(theme, model, done),
        { overlay: true },
      );
    },
  });
}

export async function runPanelCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  deps: PanelDeps,
  hooks: { setActiveRun: (run: ActiveRun | undefined) => void },
): Promise<void> {
  const question = args.trim();
  const cwd = ctx.cwd ?? process.cwd();
  if (!question) {
    ctx.ui.notify("Usage: /panel <question>", "error");
    return;
  }

  const loaded = loadConfig(deps.configPath);
  if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");

  // Lineup picker: config-sourced lineup, fallback lineup preselected when
  // config is missing/empty; effort adjustable per row; enter runs.
  let specs: PanelistSpec[] | null;
  if (ctx.hasUI) {
    const picker = new PickerState(loaded.config.panelists, loaded.config.preselected);
    specs = await ctx.ui.custom<PanelistSpec[] | null>(
      (_tui, theme, _keybindings, done) => new PanelPickerComponent(theme, picker, done),
      { overlay: true },
    );
  } else {
    specs = new PickerState(loaded.config.panelists, loaded.config.preselected).selection();
  }
  if (!specs || specs.length === 0) {
    ctx.ui.setEditorText(`/panel ${question}`);
    return;
  }

  const entries = ctx.sessionManager.buildContextEntries() as unknown as ContextEntryLike[];
  const forkMessages = forkMessagesFromEntries(entries);

  const startedAt = Date.now();
  let latestStates: readonly PanelistState[] = [];
  const renderWidget = () => {
    if (!ctx.hasUI || latestStates.length === 0) return;
    ctx.ui.setWidget(WIDGET_KEY, formatWidgetLines(latestStates, Date.now(), loaded.config.inspectKeybinding));
  };
  const ticker = setInterval(renderWidget, WIDGET_TICK_MS);

  try {
    const results = await runPanel({
      specs,
      question,
      forkMessages,
      systemPrompt: panelistSystemPrompt(),
      cwd,
      sessionDir: deps.sessionDir,
      timeoutMs: loaded.config.timeoutMs,
      spawn: deps.spawn,
      signal: ctx.signal,
      onUpdate: (states) => {
        latestStates = states;
        hooks.setActiveRun({ states });
        renderWidget();
      },
    });

    if (ctx.signal?.aborted) {
      // Cancelled: nothing enters context; the typed question returns to the
      // editor unsent so the user can re-send or edit it.
      ctx.ui.setEditorText(`/panel ${question}`);
      ctx.ui.notify("Panel cancelled — question restored to the editor", "info");
      return;
    }

    const plan = buildInjectionPlan(question, results);
    pi.appendEntry(plan.metaEntry.customType, plan.metaEntry.data);
    plan.messages.forEach((message, index) => {
      pi.sendMessage(
        {
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        },
        { deliverAs: "followUp", triggerTurn: index === plan.triggerIndex },
      );
    });
  } finally {
    clearInterval(ticker);
    hooks.setActiveRun(undefined);
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  }
}

function registerRenderers(pi: ExtensionAPI): void {
  // Panelist answers participate in LLM context (custom messages) but render
  // collapsed like tool rows: attributed summary line, expandable to the
  // verbatim answer.
  pi.registerMessageRenderer(ANSWER_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = (message.details ?? {}) as {
      model?: string;
      thinking?: string;
      ok?: boolean;
      cancelled?: boolean;
      elapsedMs?: number;
      tokens?: number;
      cost?: number;
    };
    const glyph = details.ok ? "◆" : details.cancelled ? "◌" : "✗";
    const stateText = details.ok ? "answered" : details.cancelled ? "cancelled" : "failed";
    const stats = [
      formatDuration(details.elapsedMs ?? 0),
      formatTokens(details.tokens ?? 0),
      ...(formatCost(details.cost) ? [formatCost(details.cost) as string] : []),
    ].join(" · ");
    const header = theme.fg(
      details.ok ? "accent" : "warning",
      `${glyph} panelist ${details.model ?? "?"} ${details.thinking ?? ""} · ${stats} · ${stateText}`,
    );
    if (!expanded) return new Text(theme.fg("dim", "▸ ") + header, 0, 0);
    const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return new Text([theme.fg("dim", "▾ ") + header, ...body.split("\n")].join("\n"), 0, 0);
  });

  // Metadata (session paths, timing, cost) renders but never enters context.
  pi.registerEntryRenderer(META_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = (entry.data ?? {}) as {
      panelists?: Array<{ model?: string; sessionFile?: string; elapsedMs?: number; cost?: number }>;
    };
    const count = data.panelists?.length ?? 0;
    if (!expanded) {
      return new Text(theme.fg("dim", `▸ panel run · ${count} panelist${count === 1 ? "" : "s"} · sessions saved`), 0, 0);
    }
    const lines = [theme.fg("dim", "▾ panel run")];
    for (const p of data.panelists ?? []) {
      lines.push(theme.fg("dim", `  ${p.model}: ${p.sessionFile ?? "(no session file)"}`));
    }
    return new Text(lines.join("\n"), 0, 0);
  });
}

export default function panelExtension(pi: ExtensionAPI): void {
  activate(pi);
}
