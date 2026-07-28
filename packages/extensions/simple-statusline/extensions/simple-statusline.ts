// simple-statusline.ts — local custom Pi footer for Aviram.
// Design goal: ambient, low-hierarchy footer. No emoji, no tool activity.
// Left side is quiet location context; the π marker glows (accent) while the agent
// works and rests dim when idle. Right side carries model/context/cache/cost —
// grayscale at rest, color only under pressure (context ≥50% compact-boundary hint,
// ≥90% error; cache turns warning + "!" when the latest turn broke the prompt cache).
// Full cache diagnostics (/cache report, break attribution, fingerprinting)
// live in the cache-optimization extension.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  computeSessionCacheStats,
  formatCost,
  formatTokens,
  pct,
  type SessionCacheStats,
} from "./simple-statusline/cache.ts";
import { SessionTreeScanner, type TreeCost } from "./simple-statusline/session-cost.ts";
import { branchCost, renderCostReport } from "./simple-statusline/cost-report.ts";

const STATUSLINE_KEY = "simple-statusline";
/**
 * Statuses at or under this width ride inline with the model instead of the second row.
 * A width rule rather than a list of known extensions: any extension's short status gets
 * the prominent slot, and one that isn't installed simply contributes nothing.
 *
 * Width decides placement only. It says nothing about what a status means, so the tone
 * and normalization are the same wherever a status lands — a short "goal blocked" must
 * not read as a success just because it fits.
 */
const INLINE_STATUS_MAX_WIDTH = 14;
/** How many statuses the prominent slot holds before the rest fall back to the row. */
const MAX_INLINE_STATUSES = 2;
/** First useful boundary where compaction planning beats waiting for overflow pressure. */
const COMPACT_HINT_THRESHOLD_PERCENT = 50;

/**
 * Cost is a whole-session-tree figure read off session files, so the tree scan happens
 * on session events. render() paints from the last computed value and does no I/O.
 */
const COST_REFRESH_INTERVAL_MS = 1_500;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type RuntimeState = {
  thinkingLevel: ThinkingLevel;
  turnCount: number;
  active: boolean;
  requestRender?: () => void;
  scanner: SessionTreeScanner;
  cost?: TreeCost;
  costComputedAt: number;
};
type ModelSignal = { plain: string; colored: string };
type StatusEntry = { key: string; value: string };
type ContextSignal = { plain: string; percent: number | undefined };

export default function simpleStatusline(pi: any) {
  const runtime: RuntimeState = {
    thinkingLevel: "off",
    turnCount: 0,
    active: false,
    scanner: new SessionTreeScanner(),
    costComputedAt: 0,
  };
  const refresh = () => runtime.requestRender?.();
  const refreshCost = (ctx: any, force = false) => {
    const now = Date.now();
    if (!force && runtime.cost && now - runtime.costComputedAt < COST_REFRESH_INTERVAL_MS) return;
    runtime.costComputedAt = now;
    try {
      // Nothing to configure here: a tier record declares its own premium, so the
      // scanner needs no knowledge of which extension produced it.
      runtime.cost = runtime.scanner.scanTree({
        ownEntries: ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch(),
        sessionFile: ctx.sessionManager.getSessionFile?.(),
        sessionId: ctx.sessionManager.getSessionId?.(),
      });
    } catch {
      // Keep the previous total rather than blanking the footer on a scan failure.
    }
  };

  const installFooter = (ctx: any) => {
    ctx.ui.setStatus(STATUSLINE_KEY, undefined);
    ctx.ui.setFooter((tui: any, theme: any, footerData: any) => {
      runtime.requestRender = () => tui.requestRender();
      const branchUnsubscribe = footerData.onBranchChange?.(() => tui.requestRender()) ?? (() => {});

      return {
        dispose() {
          branchUnsubscribe();
        },
        invalidate() {},
        render(width: number): string[] {
          // One partition drives both rows, so a status lands in exactly one of them.
          const statuses = partitionStatuses(footerData);
          const line = renderMainLine(width, ctx, theme, footerData, runtime, statuses.inline);
          const statusLine = renderExtensionStatuses(width, theme, statuses.row);
          return statusLine ? [line, statusLine] : [line];
        },
      };
    });
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    runtime.thinkingLevel = pi.getThinkingLevel?.() ?? "off";
    installFooter(ctx);
    refreshCost(ctx, true);
  });
  pi.on("session_tree", (_event: any, ctx: any) => {
    installFooter(ctx);
    refreshCost(ctx, true);
    refresh();
  });
  pi.on("session_compact", (_event: any, ctx: any) => {
    refreshCost(ctx, true);
    refresh();
  });
  pi.on("session_shutdown", (_event: any, ctx: any) => {
    ctx.ui.setFooter(undefined);
    ctx.ui.setStatus(STATUSLINE_KEY, undefined);
    runtime.requestRender = undefined;
  });
  pi.on("model_select", () => refresh());
  pi.on("thinking_level_select", (event: any) => {
    runtime.thinkingLevel = event.level;
    refresh();
  });
  pi.on("turn_start", () => {
    runtime.turnCount += 1;
    runtime.active = true;
    refresh();
  });
  pi.on("turn_end", (_event: any, ctx: any) => {
    refreshCost(ctx, true);
    refresh();
  });
  pi.on("message_update", (_event: any, ctx: any) => {
    // Throttled: background children append while a turn streams, so spend still
    // moves mid-turn without scanning on every delta.
    refreshCost(ctx);
    refresh();
  });
  pi.on("agent_end", (_event: any, ctx: any) => {
    runtime.active = false;
    refreshCost(ctx, true);
    refresh();
  });

  pi.registerCommand("cost", {
    description: "Session-tree cost breakdown: this session plus every run it spawned.",
    handler: async (_args: string, ctx: any) => {
      refreshCost(ctx, true);
      // The branch subtotal uses the same accounting rules as the lifetime figure, so
      // the two numbers in one report can be reasoned about against each other.
      const activeBranchCost = branchCost(ctx.sessionManager.getBranch());
      ctx.ui.notify(renderCostReport(runtime.cost, { activeBranchCost, scan: runtime.scanner.stats }), "info");
    },
  });
}

function renderMainLine(
  width: number,
  ctx: any,
  theme: any,
  footerData: any,
  runtime: RuntimeState,
  inline: StatusEntry[],
): string {
  const usage = ctx.getContextUsage?.();
  const cacheStats = computeSessionCacheStats(ctx.sessionManager.getBranch());

  const project = basename(ctx.cwd) || ctx.cwd;
  const branch = footerData.getGitBranch?.() || "";
  const model = shortenModel(ctx.model?.id ?? "no-model");
  const level = runtime.thinkingLevel;
  const contextSignal = formatContextUsage(usage, ctx.model?.contextWindow);
  const costStr = formatTreeCost(runtime.cost);
  const modelSignal = formatModelSignal(model, level, inline.map((status) => formatStatusSignal(status, theme)), theme);
  const cacheSignal = cacheStats.visible ? formatCacheSignal(cacheStats, theme) : undefined;

  const sep = "  ·  ";
  // Right cluster: the operational signals. It gets priority, but the final line still clamps for narrow terminals.
  const rightTokens = [
    modelSignal.plain,
    contextSignal.plain,
    cacheSignal?.plain ?? "",
    costStr,
  ].filter((t) => t.length > 0);
  const rightPlain = rightTokens.join(sep);

  // Left cluster: quiet identity. π marker identifies the pi harness at a glance;
  // it glows while pi thinks and dims when idle.
  const marker = "π ";
  const minGap = 3;
  let leftBudget = width - visibleLength(rightPlain) - minGap - visibleLength(marker);
  let shownProject = project;
  let shownBranch = branch;
  if (leftBudget < visibleLength(`${shownProject}  ${shownBranch}`)) {
    const branchBudget = Math.max(0, leftBudget - visibleLength(shownProject) - 2);
    shownBranch = branch ? compact(branch, branchBudget) : "";
    if (visibleLength(`${shownProject}  ${shownBranch}`) > leftBudget) {
      shownProject = compact(shownProject, Math.max(0, leftBudget));
      shownBranch = "";
    }
  }
  const leftPlain = [marker + shownProject, shownBranch].filter((t) => t.trim().length > 0).join("  ");

  const left =
    color(theme, runtime.active ? "accent" : "dim", marker) +
    shownProject +
    (shownBranch ? color(theme, "dim", `  ${shownBranch}`) : "");
  const right = [
    modelSignal.colored,
    contextSignal.plain ? color(theme, contextColor(contextSignal.percent), contextSignal.plain) : "",
    cacheSignal?.colored ?? "",
    costStr ? color(theme, "muted", costStr) : "",
  ]
    .filter((t) => t.length > 0)
    .join(color(theme, "dim", sep));

  const gap = Math.max(minGap, width - visibleLength(leftPlain) - visibleLength(rightPlain));
  return fitLine(`${left}${" ".repeat(gap)}${right}`, width);
}

function renderExtensionStatuses(width: number, theme: any, row: StatusEntry[]): string | undefined {
  if (row.length === 0) return undefined;
  const visible = row.slice(0, 3).map((status) => formatExtensionStatus(status.key, status.value, theme));
  return fitLine(color(theme, "dim", visible.join("  ·  ")), width);
}

/**
 * Split extension statuses between the prominent slot beside the model and the second
 * row. Placement is by width only — short statuses are easier to read inline — and no
 * status is ever shown in both places. The footer stays quiet by holding at most two
 * inline and three in the row, and by hiding MCP loadout statuses, which belong in /mcp.
 */
function partitionStatuses(footerData: any): { inline: StatusEntry[]; row: StatusEntry[] } {
  const statuses: Map<string, string> | undefined = footerData.getExtensionStatuses?.();
  if (!statuses) return { inline: [], row: [] };
  const candidates: StatusEntry[] = [...statuses.entries()]
    .filter(([key, value]) => key !== STATUSLINE_KEY && value.trim().length > 0 && !/mcp/i.test(`${key} ${value}`))
    .map(([key, value]) => ({ key, value }));

  const inline = candidates.filter((status) => isInlineStatus(status.value)).slice(0, MAX_INLINE_STATUSES);
  const row = candidates.filter((status) => !inline.includes(status));
  return { inline, row };
}

/** Status text as displayed: own key prefix and a leading emoji token removed. */
function normalizeStatus(key: string, value: string): string {
  const trimmed = value.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*`, "iu"), "");
  const stripped = trimmed.replace(/^\S+\s+/, (first) => (isEmojiOnlyToken(first.trim()) ? "" : first));
  return compact(stripped || trimmed, 42);
}

function formatExtensionStatus(key: string, value: string, theme: any): string {
  const normalized = `${key} ${value}`.toLowerCase();
  const tone = /goal|active|running|complete/.test(normalized) ? "muted" : "dim";
  return color(theme, tone, normalizeStatus(key, value));
}

/**
 * Lifetime spend for the whole session tree. A leading "~" says the figure is a
 * floor rather than an exact number — unpriced models or an uncorrected priority
 * premium — with the reasons available in /cost.
 */
function formatTreeCost(cost: TreeCost | undefined): string {
  if (!cost || cost.totalCost <= 0) return "";
  return `${cost.approximate ? "~" : ""}${formatCost(cost.totalCost)}`;
}

// Session cache rate (converging cumulative %) with a break flag: when the latest
// turn read back far less than the established prefix, the token turns warning + "!".
// Write totals live in /cache, not here — the footer stays ambient.
function formatCacheSignal(stats: SessionCacheStats, theme: any): ModelSignal {
  const breakMark = stats.latestBreak ? "!" : "";
  const plain = `cache ${pct(stats.sessionRate)}${breakMark}`;
  return {
    plain,
    colored: color(theme, stats.latestBreak ? "warning" : "dim", plain),
  };
}

/**
 * Model, thinking level, and any short extension status, in the prominent slot.
 * Extension-agnostic: a status is shown because it is short, not because the footer
 * recognizes the extension that set it.
 */
function formatModelSignal(model: string, level: ThinkingLevel, inline: ModelSignal[], theme: any): ModelSignal {
  const thinkingSignal = color(theme, thinkingColor(level), level);
  return {
    plain: [model, level, ...inline.map((part) => part.plain)].join(" "),
    colored: [color(theme, "dim", model), thinkingSignal, ...inline.map((part) => part.colored)].join(" "),
  };
}

/** An inline status, formatted by the same rules the row uses. */
function formatStatusSignal(status: StatusEntry, theme: any): ModelSignal {
  return { plain: normalizeStatus(status.key, status.value), colored: formatExtensionStatus(status.key, status.value, theme) };
}

function isInlineStatus(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && visibleLength(trimmed) <= INLINE_STATUS_MAX_WIDTH && !/mcp/i.test(trimmed);
}

function thinkingColor(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
  }
}

// Ambient at rest: color (and the hint) appear only when context pressure is actionable.
function contextColor(percent: number | null | undefined): string {
  if (percent == null) return "dim";
  if (percent >= 90) return "error";
  if (percent >= COMPACT_HINT_THRESHOLD_PERCENT) return "warning";
  return "dim";
}

function contextBar(percent: number): string {
  const slots = 5;
  const filled = Math.max(0, Math.min(slots, Math.round((percent / 100) * slots)));
  return `${"▰".repeat(filled)}${"▱".repeat(slots - filled)}`;
}

function formatContextUsage(usage: any, fallbackContextWindow?: number): ContextSignal {
  const contextWindow = usage?.contextWindow ?? fallbackContextWindow ?? 0;
  if (!usage && contextWindow <= 0) return { plain: "", percent: undefined };

  const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
  const explicitPercent = typeof usage?.percent === "number" ? usage.percent : undefined;
  const computedPercent = explicitPercent ?? (tokens != null && contextWindow > 0 ? (tokens / contextWindow) * 100 : undefined);
  const tokenPair = `${tokens == null ? "?" : formatTokens(tokens)}/${contextWindow > 0 ? formatTokens(contextWindow) : "?"}`;

  if (computedPercent == null) return { plain: tokenPair, percent: undefined };
  const bar = computedPercent >= 70 ? `${contextBar(computedPercent)} ` : "";
  const hint = computedPercent >= COMPACT_HINT_THRESHOLD_PERCENT ? " · compact at boundary" : "";
  return { plain: `${bar}${computedPercent.toFixed(0)}% ${tokenPair}${hint}`, percent: computedPercent };
}

function color(theme: any, tone: string, text: string): string {
  try {
    return theme.fg(tone, text);
  } catch {
    return text;
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function shortenModel(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/^gpt-/, "gpt ")
    .replace(/-20\d{6}$/, "")
    .replace(/-latest$/, "");
}

function compact(value: string, max: number): string {
  if (max <= 0) return "";
  const cleaned = value.replace(/\s+/g, " ").trim();
  return visibleLength(cleaned) <= max ? cleaned : truncateToWidth(cleaned, max, "…");
}

function visibleLength(value: string): number {
  return visibleWidth(value);
}

function fitLine(value: string, width: number): string {
  return truncateToWidth(value, width, "", true);
}

function isEmojiOnlyToken(value: string): boolean {
  return /^(?=.*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\ufe0f?\u20e3))(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|[0-9#*]\ufe0f?\u20e3)+$/u.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
