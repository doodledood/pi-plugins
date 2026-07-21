// /panel — parallel multi-model consultation for pi.
//
// `/panel <question>` forks the current conversation's context, runs the
// question through several independently-running panelist models in parallel
// (isolated in-process SDK sessions, prompt-level read-only guardrails), and
// returns each panelist's final answer verbatim and attributed into the main
// session — explicitly framed as fallible opinions — before the main model
// responds. Honest framing: independent peer opinions over shared history,
// not clean-room re-derivation.
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";
import { forkMessagesFromEntries } from "./fork.ts";
import { spawnPanelistSession } from "./host.ts";
import { panelistSystemPrompt } from "./prompts.ts";
import { buildInjectionPlan, ANSWER_MESSAGE_TYPE, META_ENTRY_TYPE } from "./results.ts";
import { runPanel } from "./runner.ts";
import type { PanelistResult, PanelistSpec, PanelistState, SpawnPanelist } from "./types.ts";
import {
  estimatePanelCostUsd,
  stripThinkingSuffix,
  formatAnswerLines,
  formatMetaLines,
  PanelMonitorComponent,
  PanelPickerComponent,
  PickerState,
  type AnswerDetailsLike,
  type MetaDataLike,
} from "./ui.ts";

interface PanelDeps {
  spawn: SpawnPanelist;
  /** Session storage dir override for panelist sessions (tests/smokes). */
  sessionDir?: string;
  /** Config file override (tests/smokes); default is ~/.pi/agent/panel.json. */
  configPath?: string;
  /** RNG override for the answer shuffle (tests); default Math.random. */
  rng?: () => number;
}

/** Live run state exposed to hooks (smokes assert on it). */
interface ActiveRun {
  states: readonly PanelistState[];
}

export function activate(pi: ExtensionAPI, deps: PanelDeps = { spawn: spawnPanelistSession }): void {
  registerRenderers(pi);
  pi.registerCommand("panel", {
    description: "Consult a panel of independent models in parallel over a fork of this conversation",
    handler: async (args, ctx) => {
      await runPanelCommand(pi, ctx, args ?? "", deps, { setActiveRun: () => {} });
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

  // Terminal-only UI (picker, monitor) is gated on TUI mode specifically:
  // in RPC mode hasUI is true but ctx.ui.custom() resolves undefined, so
  // non-TUI modes run the preselected lineup directly instead.
  const isTui = ctx.hasUI && ctx.mode === "tui";

  const forkMessages = forkMessagesFromEntries(ctx.sessionManager.buildContextEntries());
  // Rough, display-only cost estimate for the picker header: fork size in
  // ~tokens (chars/4) × each selected model's input price from pi's registry.
  const forkTokens = Math.ceil(JSON.stringify(forkMessages).length / 4);
  const priceLookup = (modelRef: string): number | undefined => {
    // The config contract allows "provider/id:level" refs; the registry needs
    // the bare provider/id.
    const bare = stripThinkingSuffix(modelRef);
    const slash = bare.indexOf("/");
    if (slash <= 0) return undefined;
    const model = ctx.modelRegistry.find(bare.slice(0, slash), bare.slice(slash + 1));
    return model?.cost?.input;
  };

  // Lineup picker: config-sourced lineup, fallback lineup preselected when
  // config is missing/empty; effort adjustable per row; enter runs.
  let specs: PanelistSpec[] | null;
  if (isTui) {
    const picker = new PickerState(loaded.config.panelists, loaded.config.preselected);
    specs = await ctx.ui.custom<PanelistSpec[] | null>(
      (_tui, theme, _keybindings, done) =>
        new PanelPickerComponent(theme, picker, (selection) => estimatePanelCostUsd(selection, forkTokens, priceLookup), done),
      { overlay: true },
    );
    if (!specs || specs.length === 0) {
      ctx.ui.setEditorText(`/panel ${question}`);
      return;
    }
  } else {
    specs = new PickerState(loaded.config.panelists, loaded.config.preselected).selection();
    if (specs.length === 0) {
      ctx.ui.notify("panel: no panelists selected in config", "error");
      return;
    }
  }

  // Cancellation is owned here: pi provides no abort signal to idle command
  // handlers, so Esc is delivered through the focused monitor component below.
  // A turn-scoped ctx.signal (when one exists) is still honored as a fallback.
  const controller = new AbortController();
  const propagateAbort = () => controller.abort();
  if (ctx.signal?.aborted) controller.abort();
  else ctx.signal?.addEventListener("abort", propagateAbort, { once: true });

  let latestStates: readonly PanelistState[] = [];

  const runPromise = runPanel({
    specs,
    question,
    forkMessages,
    systemPrompt: panelistSystemPrompt(),
    cwd,
    sessionDir: deps.sessionDir,
    timeoutMs: loaded.config.timeoutMs,
    spawn: deps.spawn,
    signal: controller.signal,
    onUpdate: (states) => {
      latestStates = states;
      hooks.setActiveRun({ states });
    },
  });

  let results: PanelistResult[];
  try {
    if (isTui) {
      // The monitor runs as a NON-overlay custom component: it replaces the
      // editor slot while the chat transcript stays visible above it (the
      // ambient bar), owns input for Esc-cancel, and switches in place to the
      // drill-in split view on the inspect key.
      let closeMonitor: ((value: undefined) => void) | undefined;
      const monitorClosed = ctx.ui.custom<undefined>((tui, theme, _keybindings, done) => {
        closeMonitor = done;
        return new PanelMonitorComponent(
          theme,
          () => latestStates,
          loaded.config.inspectKeybinding,
          () => controller.abort(),
          () => tui.requestRender(),
        );
      });
      try {
        results = await runPromise;
      } finally {
        // The monitor must never outlive the run — a stuck focused component
        // would own the chat's input until restart.
        closeMonitor?.(undefined);
      }
      await monitorClosed;
    } else {
      results = await runPromise;
    }
  } finally {
    ctx.signal?.removeEventListener("abort", propagateAbort);
    hooks.setActiveRun(undefined);
  }

  if (controller.signal.aborted) {
    // Cancelled: nothing enters context; the typed question returns to the
    // editor unsent so the user can re-send or edit it.
    ctx.ui.setEditorText(`/panel ${question}`);
    ctx.ui.notify("Panel cancelled — question restored to the editor", "info");
    return;
  }

  const plan = buildInjectionPlan(question, results, deps.rng ?? Math.random);
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
}

function registerRenderers(pi: ExtensionAPI): void {
  // Panelist answers participate in LLM context (custom messages) but render
  // collapsed like tool rows: attributed summary line, expandable to the
  // verbatim answer.
  pi.registerMessageRenderer(ANSWER_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = (message.details ?? {}) as AnswerDetailsLike;
    const body = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    return new Text(formatAnswerLines(details, body, expanded, theme).join("\n"), 0, 0);
  });

  // Metadata (session paths, timing, cost) renders but never enters context.
  pi.registerEntryRenderer(META_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = (entry.data ?? {}) as MetaDataLike;
    return new Text(formatMetaLines(data, expanded, theme).join("\n"), 0, 0);
  });
}

export default function panelExtension(pi: ExtensionAPI): void {
  activate(pi);
}
