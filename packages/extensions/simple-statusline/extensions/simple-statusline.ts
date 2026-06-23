// simple-statusline.ts — local custom Pi footer for Aviram.
// Design goal: ambient, low-hierarchy footer. No emoji, no tool activity.
// Left side is quiet location context; the π marker glows (accent) while the agent
// works and rests dim when idle. Right side carries model/context/cost — grayscale
// at rest, color only under pressure (context ≥70% warning, ≥90% error).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const STATUSLINE_KEY = "simple-statusline";
const GPT_FAST_STATUS_KEY = "gpt-fast";
const GPT_FAST_STATE_PATH = join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent", "gpt-fast-toggle.json");

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type TokenTotals = { input: number; output: number; cost: number };
type CacheUsage = { input: number; read: number; write: number; rate: number };
type RuntimeState = { thinkingLevel: ThinkingLevel; turnCount: number; active: boolean; requestRender?: () => void };
type ModelSignal = { plain: string; colored: string };

export default function simpleStatusline(pi: any) {
  const runtime: RuntimeState = { thinkingLevel: "off", turnCount: 0, active: false };
  const refresh = () => runtime.requestRender?.();

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
          const line = renderMainLine(width, ctx, theme, footerData, runtime);
          const statusLine = renderExtensionStatuses(width, theme, footerData);
          return statusLine ? [line, statusLine] : [line];
        },
      };
    });
  };

  pi.on("session_start", (_event: any, ctx: any) => {
    runtime.thinkingLevel = pi.getThinkingLevel?.() ?? "off";
    installFooter(ctx);
  });
  pi.on("session_tree", (_event: any, ctx: any) => {
    installFooter(ctx);
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
  pi.on("turn_end", () => refresh());
  pi.on("message_update", () => refresh());
  pi.on("agent_end", () => {
    runtime.active = false;
    refresh();
  });
}

function renderMainLine(width: number, ctx: any, theme: any, footerData: any, runtime: RuntimeState): string {
  const usage = ctx.getContextUsage?.();
  const totals = getTokenTotals(ctx);
  const cacheUsage = getLatestCacheUsage(ctx, ctx.model);

  const project = basename(ctx.cwd) || ctx.cwd;
  const branch = footerData.getGitBranch?.() || "";
  const model = shortenModel(ctx.model?.id ?? "no-model");
  const level = runtime.thinkingLevel;
  const pct = usage?.percent;
  const ctxStr = formatContextUsage(usage, ctx.model?.contextWindow);
  const costStr = totals.cost > 0 ? `$${totals.cost.toFixed(totals.cost >= 1 ? 2 : 3)}` : "";
  const modelSignal = formatModelSignal(ctx.model, model, level, isGptPriorityEnabled(), theme);
  const cacheSignal = cacheUsage ? formatCacheSignal(cacheUsage, theme) : undefined;

  const sep = "  ·  ";
  // Right cluster: the operational signals. It gets priority, but the final line still clamps for narrow terminals.
  const rightTokens = [
    modelSignal.plain,
    ctxStr,
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
    ctxStr ? color(theme, contextColor(pct), ctxStr) : "",
    cacheSignal?.colored ?? "",
    costStr ? color(theme, "muted", costStr) : "",
  ]
    .filter((t) => t.length > 0)
    .join(color(theme, "dim", sep));

  const gap = Math.max(minGap, width - visibleLength(leftPlain) - visibleLength(rightPlain));
  return fitLine(`${left}${" ".repeat(gap)}${right}`, width);
}

function renderExtensionStatuses(width: number, theme: any, footerData: any): string | undefined {
  const statuses: Map<string, string> | undefined = footerData.getExtensionStatuses?.();
  if (!statuses) return undefined;

  const visible = [...statuses.entries()]
    .filter(([key, value]) => ![STATUSLINE_KEY, GPT_FAST_STATUS_KEY].includes(key) && value.trim().length > 0)
    // Hide noisy/ambient statuses. They are useful in /mcp, but too loud in the footer.
    .filter(([key, value]) => !/mcp/i.test(`${key} ${value}`))
    // Keep goal-like statuses if present; dim everything else.
    .slice(0, 3)
    .map(([key, value]) => formatExtensionStatus(key, value, theme));

  if (visible.length === 0) return undefined;
  return fitLine(color(theme, "dim", visible.join("  ·  ")), width);
}

function formatExtensionStatus(key: string, value: string, theme: any): string {
  const trimmed = value.trim().replace(new RegExp(`^${escapeRegExp(key)}\\s*:\\s*`, "iu"), "");
  const plain = trimmed.replace(/^\S+\s+/, (first) => (isEmojiOnlyToken(first.trim()) ? "" : first));
  const normalized = `${key} ${value}`.toLowerCase();
  const tone = /goal|active|running|complete/.test(normalized) ? "muted" : "dim";
  return color(theme, tone, compact(plain || trimmed, 42));
}

function getTokenTotals(ctx: any): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const usage = entry.message.usage;
    totals.input += usage?.input ?? 0;
    totals.output += usage?.output ?? 0;
    totals.cost += usage?.cost?.total ?? 0;
  }
  return totals;
}

function getLatestCacheUsage(ctx: any, model: any): CacheUsage | undefined {
  if (!isCacheCapableModel(model)) return undefined;

  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;

    const usage = entry.message.usage;
    if (!usage) continue;

    const input = usage.input ?? 0;
    const read = usage.cacheRead ?? 0;
    const write = usage.cacheWrite ?? 0;
    const total = input + read + write;
    if (total < 1024) return undefined;

    return { input, read, write, rate: read / total };
  }
  return undefined;
}

function isCacheCapableModel(model: any): boolean {
  const provider = `${model?.provider ?? ""}`.toLowerCase();
  return provider === "openai" || provider === "anthropic" || provider === "google" || provider === "google-vertex";
}

function formatCacheSignal(usage: CacheUsage, theme: any): ModelSignal {
  const pct = `${Math.round(usage.rate * 100)}%`;
  const write = usage.write > 0 ? ` W${formatCount(usage.write)}` : "";
  const plain = `cache ${pct}${write}`;
  return {
    plain,
    colored: color(theme, "dim", plain),
  };
}

function formatModelSignal(rawModel: any, model: string, level: ThinkingLevel, priorityFast: boolean, theme: any): ModelSignal {
  const thinkingSignal = color(theme, thinkingColor(level), level);

  if (isGptModel(rawModel)) {
    const plainParts = [model, level, priorityFast ? "FAST" : ""];
    const coloredParts = [color(theme, "dim", model), thinkingSignal, priorityFast ? color(theme, "success", "FAST") : ""];

    return {
      plain: plainParts.filter((part) => part.length > 0).join(" "),
      colored: coloredParts.filter((part) => part.length > 0).join(" "),
    };
  }

  return {
    plain: `${model} ${level}`,
    colored: `${color(theme, "dim", model)} ${thinkingSignal}`,
  };
}

function isGptPriorityEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(GPT_FAST_STATE_PATH, "utf8"));
    return parsed?.mode === "fast";
  } catch {
    return false;
  }
}

function isGptModel(model: any): boolean {
  if (!model?.provider || !model?.id) return false;
  const fullId = `${model.provider}/${model.id}`;
  return /(^|\/)gpt-/i.test(fullId);
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

// Ambient at rest: color (and the bar) appear only when context pressure is actionable.
function contextColor(percent: number | null | undefined): string {
  if (percent == null) return "dim";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "dim";
}

function contextBar(percent: number): string {
  const slots = 5;
  const filled = Math.max(0, Math.min(slots, Math.round((percent / 100) * slots)));
  return `${"▰".repeat(filled)}${"▱".repeat(slots - filled)}`;
}

function formatContextUsage(usage: any, fallbackContextWindow?: number): string {
  const contextWindow = usage?.contextWindow ?? fallbackContextWindow ?? 0;
  if (!usage && contextWindow <= 0) return "";

  const tokens = typeof usage?.tokens === "number" ? usage.tokens : undefined;
  const percent = typeof usage?.percent === "number" ? usage.percent : undefined;
  const tokenPair = `${tokens == null ? "?" : formatCount(tokens)}/${contextWindow > 0 ? formatCount(contextWindow) : "?"}`;

  if (percent == null) return tokenPair;
  const bar = percent >= 70 ? `${contextBar(percent)} ` : "";
  return `${bar}${percent.toFixed(0)}% ${tokenPair}`;
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

function formatCount(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
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
