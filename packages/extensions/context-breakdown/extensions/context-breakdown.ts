// context-breakdown.ts — a Claude-Code-style `/context` command for pi.
//
// Opens an Esc-closable popup overlay showing how the current context window is
// spent, broken down by category: System prompt, System tools, MCP tools (with
// an exact per-server split), Messages, Free space, and Reserve.
//
// TOKEN COUNTING
// --------------
// For Anthropic models the per-category numbers are REAL, not estimated: we call
// Anthropic's /v1/messages/count_tokens endpoint on cumulative prefixes of the
// actual request and take exact differences:
//
//   system        = count(system)                       − count(∅)
//   system tools  = count(system + builtin tools)        − count(system)
//   <each server> = count(system + tools…+server)        − count(prev)   (exact)
//   messages      = count(full request)                  − count(system + all tools)
//
// The fixed parts (system + tool schemas) don't change turn to turn, so their
// counts are cached (keyed by a content hash) — after the first run only the
// `messages` measurement requires a network call. Anthropic's count_tokens is
// free and fast. There is no exact local tokenizer for Claude, so this API is
// the only way to get real numbers.
//
// For non-Anthropic models (e.g. openai/*) we fall back to a calibrated chars/token
// estimate (prose /4, tool JSON /2.5), clearly labelled as estimated.
//
// Install: drop in ~/.pi/agent/extensions/ (global) and run /context.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";

// Pi-native and local extension tools (everything else is treated as an MCP tool).
const PI_BUILTIN_TOOLS = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "managed_chrome_status",
  "load_tools",
  "subagent",
  "get_subagent_result",
  "steer_subagent",
  "goal_complete",
  "ask_user",
  "ask_user_question",
  "todo",
  "web_search",
  "fetch_content",
  "get_search_content",
  "mcp",
]);

// Known MCP server prefixes (longest-match first). Tools that don't match fall
// back to grouping by their first underscore segment.
const MCP_SERVER_PREFIXES = [
  "chrome_devtools",
  "tavily",
];

const ANTHROPIC_BASE_URL =
  process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const FALLBACK_MODEL_ID = "claude-opus-4-20250514";

function detectServer(toolName: string): string {
  for (const prefix of MCP_SERVER_PREFIXES) {
    if (toolName.startsWith(`${prefix}_`)) return prefix;
  }
  const seg = toolName.split("_")[0];
  return seg || "other";
}

// Small stable string hash (FNV-1a) for cache keys.
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Anthropic tool/payload shapes (the subset we read).
// ---------------------------------------------------------------------------

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: unknown;
  type?: string;
}

type AnthropicSystem = string | unknown[];

interface AnthropicInputs {
  model: string;
  system: AnthropicSystem | undefined;
  systemTools: AnthropicTool[];
  mcpServers: Array<{ server: string; tools: AnthropicTool[] }>;
  allTools: AnthropicTool[];
  messages: unknown[];
  haveMessages: boolean;
}

function readToolName(tool: unknown): string {
  if (tool && typeof tool === "object") {
    const t = tool as Record<string, unknown>;
    if (typeof t.name === "string") return t.name;
    const fn = t.function;
    if (fn && typeof fn === "object") {
      const name = (fn as Record<string, unknown>).name;
      if (typeof name === "string") return name;
    }
  }
  return "";
}

// Normalize any tool object (Anthropic or OpenAI shape, or a pi ToolInfo) into
// the minimal Anthropic count_tokens tool shape.
function toAnthropicTool(tool: unknown): AnthropicTool {
  const t = (tool ?? {}) as Record<string, unknown>;
  const fn =
    t.function && typeof t.function === "object"
      ? (t.function as Record<string, unknown>)
      : undefined;
  const name = readToolName(tool) || "tool";
  const description =
    typeof t.description === "string"
      ? t.description
      : fn && typeof fn.description === "string"
        ? fn.description
        : undefined;
  const input_schema =
    t.input_schema ?? t.parameters ?? fn?.parameters ?? { type: "object" };
  return { name, description, input_schema, type: "custom" };
}

// Build the Anthropic-format inputs from the captured request payload when
// available, otherwise reconstruct from the live system prompt + active tools so
// /context works before any message is sent.
function buildAnthropicInputs(
  payload: unknown,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): AnthropicInputs {
  const modelFromCtx = ctx.model?.id;
  let model = modelFromCtx ?? FALLBACK_MODEL_ID;
  let system: AnthropicSystem | undefined;
  let rawTools: unknown[] = [];
  let messages: unknown[] = [];
  let haveMessages = false;

  const p =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;

  if (p) {
    if (typeof p.model === "string") model = p.model;
    if (typeof p.system === "string" || Array.isArray(p.system)) {
      system = p.system as AnthropicSystem;
    }
    if (Array.isArray(p.tools)) rawTools = p.tools;
    if (Array.isArray(p.messages)) {
      const msgs = p.messages.filter((m) => {
        const role =
          m && typeof m === "object"
            ? (m as Record<string, unknown>).role
            : undefined;
        return role !== "system";
      });
      messages = msgs;
      haveMessages = msgs.length > 0;
    }
  }

  // Fallbacks from live context (pre-request, or payload missing parts).
  if (system === undefined) system = ctx.getSystemPrompt();
  if (rawTools.length === 0) {
    const active = new Set(pi.getActiveTools());
    rawTools = pi
      .getAllTools()
      .filter((t: ToolInfo) => active.has(t.name));
  }

  const allTools = rawTools.map(toAnthropicTool);
  const systemTools: AnthropicTool[] = [];
  const serverMap = new Map<string, AnthropicTool[]>();
  for (const tool of allTools) {
    if (PI_BUILTIN_TOOLS.has(tool.name)) {
      systemTools.push(tool);
    } else {
      const server = detectServer(tool.name);
      const arr = serverMap.get(server) ?? [];
      arr.push(tool);
      serverMap.set(server, arr);
    }
  }
  const mcpServers = [...serverMap.entries()].map(([server, tools]) => ({
    server,
    tools,
  }));

  return { model, system, systemTools, mcpServers, allTools, messages, haveMessages };
}

// ---------------------------------------------------------------------------
// Anthropic count_tokens client.
// ---------------------------------------------------------------------------

const PLACEHOLDER_MESSAGES = [{ role: "user", content: "." }];

interface CountBody {
  model: string;
  system?: AnthropicSystem;
  tools?: AnthropicTool[];
  messages: unknown[];
}

async function countTokens(
  apiKey: string,
  body: CountBody,
  signal: AbortSignal | undefined,
): Promise<number> {
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages/count_tokens`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`count_tokens ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { input_tokens?: number };
  if (typeof json.input_tokens !== "number") {
    throw new Error("count_tokens: missing input_tokens");
  }
  return json.input_tokens;
}

interface FixedCounts {
  dot: number;
  systemTok: number;
  systemToolsTok: number;
  serverToks: Array<{ server: string; tokens: number; count: number }>;
  noMsg: number; // system + all tools + placeholder
}

// Cache the fixed (system + tools) measurements; only messages change per turn.
const fixedCache = new Map<string, FixedCounts>();

async function measureFixed(
  apiKey: string,
  inputs: AnthropicInputs,
  signal: AbortSignal | undefined,
): Promise<FixedCounts> {
  const key = hash(
    inputs.model +
      "\u0000" +
      JSON.stringify(inputs.system) +
      "\u0000" +
      JSON.stringify(inputs.allTools),
  );
  const cached = fixedCache.get(key);
  if (cached) return cached;

  const m = inputs.model;
  const dot = await countTokens(
    apiKey,
    { model: m, messages: PLACEHOLDER_MESSAGES },
    signal,
  );
  const sysOnly = await countTokens(
    apiKey,
    { model: m, system: inputs.system, messages: PLACEHOLDER_MESSAGES },
    signal,
  );
  // Cumulative: add builtin tools, then each server in turn, taking exact deltas.
  const cumulative: AnthropicTool[] = [...inputs.systemTools];
  const afterSystemTools =
    cumulative.length > 0
      ? await countTokens(
          apiKey,
          { model: m, system: inputs.system, tools: cumulative, messages: PLACEHOLDER_MESSAGES },
          signal,
        )
      : sysOnly;
  const systemToolsTok = afterSystemTools - sysOnly;

  let prev = afterSystemTools;
  const serverToks: Array<{ server: string; tokens: number; count: number }> = [];
  for (const { server, tools } of inputs.mcpServers) {
    cumulative.push(...tools);
    const cur = await countTokens(
      apiKey,
      { model: m, system: inputs.system, tools: cumulative, messages: PLACEHOLDER_MESSAGES },
      signal,
    );
    serverToks.push({ server, tokens: cur - prev, count: tools.length });
    prev = cur;
  }

  const result: FixedCounts = {
    dot,
    systemTok: sysOnly - dot,
    systemToolsTok,
    serverToks,
    noMsg: prev,
  };
  fixedCache.set(key, result);
  return result;
}

interface RealBreakdown {
  systemTok: number;
  systemToolsTok: number;
  mcpToolsTok: number;
  messagesTok: number;
  totalTokens: number;
  serverToks: Array<{ server: string; tokens: number; count: number }>;
  systemToolCount: number;
  mcpToolCount: number;
}

async function measureReal(
  apiKey: string,
  inputs: AnthropicInputs,
  signal: AbortSignal | undefined,
): Promise<RealBreakdown> {
  const fixed = await measureFixed(apiKey, inputs, signal);

  let totalTokens: number;
  let messagesTok: number;
  if (inputs.haveMessages) {
    const full = await countTokens(
      apiKey,
      {
        model: inputs.model,
        system: inputs.system,
        tools: inputs.allTools,
        messages: inputs.messages,
      },
      signal,
    );
    // full = system + tools + realMessages; fixed.noMsg = system + tools + dot.
    messagesTok = Math.max(0, full - fixed.noMsg + fixed.dot);
    totalTokens = full;
  } else {
    messagesTok = 0;
    totalTokens = fixed.noMsg - fixed.dot;
  }

  const mcpToolsTok = fixed.serverToks.reduce((s, x) => s + x.tokens, 0);
  return {
    systemTok: fixed.systemTok,
    systemToolsTok: fixed.systemToolsTok,
    mcpToolsTok,
    messagesTok,
    totalTokens,
    serverToks: [...fixed.serverToks].sort((a, b) => b.tokens - a.tokens),
    systemToolCount: inputs.systemTools.length,
    mcpToolCount: inputs.mcpServers.reduce((s, x) => s + x.tools.length, 0),
  };
}

// ---------------------------------------------------------------------------
// Estimate fallback (non-Anthropic providers or count_tokens failure).
// ---------------------------------------------------------------------------

// Calibrated chars-per-token. Prose (system prompt, messages) is ~4 chars/token;
// dense tool-schema JSON is ~2.5 (measured against Anthropic count_tokens — the same
// calibration the mcp-tool-loadout extension uses). Applying a single divisor to both
// would undercount tools by ~1.6x or overcount prose, so we split them.
const CPT_PROSE = 4;
const CPT_JSON = 2.5;

function estimateBreakdown(inputs: AnthropicInputs): RealBreakdown {
  const proseTok = (chars: number) => Math.round(chars / CPT_PROSE);
  const jsonTok = (chars: number) => Math.round(chars / CPT_JSON);
  const sysChars =
    typeof inputs.system === "string"
      ? inputs.system.length
      : JSON.stringify(inputs.system ?? "").length;
  const systemToolsChars = inputs.systemTools.reduce(
    (s, t) => s + JSON.stringify(t).length,
    0,
  );
  const serverToks = inputs.mcpServers
    .map(({ server, tools }) => ({
      server,
      tokens: jsonTok(tools.reduce((s, t) => s + JSON.stringify(t).length, 0)),
      count: tools.length,
    }))
    .sort((a, b) => b.tokens - a.tokens);
  const messagesChars = inputs.haveMessages
    ? JSON.stringify(inputs.messages).length
    : 0;
  const systemTok = proseTok(sysChars);
  const systemToolsTok = jsonTok(systemToolsChars);
  const mcpToolsTok = serverToks.reduce((s, x) => s + x.tokens, 0);
  const messagesTok = proseTok(messagesChars);
  return {
    systemTok,
    systemToolsTok,
    mcpToolsTok,
    messagesTok,
    totalTokens: systemTok + systemToolsTok + mcpToolsTok + messagesTok,
    serverToks,
    systemToolCount: inputs.systemTools.length,
    mcpToolCount: inputs.mcpServers.reduce((s, x) => s + x.tools.length, 0),
  };
}

function readReserveTokens(cwd: string): number {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const candidates = [
    join(home, ".pi", "agent", "settings.json"),
    join(cwd, ".pi", "settings.json"),
  ];
  let reserve = 16384;
  for (const path of candidates) {
    try {
      const json = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      const compaction = json.compaction as Record<string, unknown> | undefined;
      const value = compaction?.reserveTokens;
      if (typeof value === "number" && value >= 0) reserve = value;
    } catch {
      // missing/unreadable settings file — keep default
    }
  }
  return reserve;
}

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

interface Category {
  label: string;
  tokens: number;
  role: ThemeColor;
  glyph: string;
}

export default function contextBreakdown(pi: ExtensionAPI) {
  let lastPayload: unknown;

  pi.on("before_provider_request", (event) => {
    lastPayload = event.payload;
    // Never mutate the payload — return nothing so pi sends it unchanged.
  });

  pi.registerCommand("context", {
    description:
      "Popup breakdown of context usage (real token counts on Anthropic)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const usage = ctx.getContextUsage();
      const modelName = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "unknown model";
      const window = usage?.contextWindow ?? 200000;
      const reserve = readReserveTokens(ctx.cwd);

      const inputs = buildAnthropicInputs(lastPayload, pi, ctx);
      const isAnthropic = (ctx.model?.provider ?? "").toLowerCase() === "anthropic";
      const apiKey = process.env.ANTHROPIC_API_KEY;

      let breakdown: RealBreakdown;
      let real = false;
      let note = "";

      if (isAnthropic && apiKey) {
        ctx.ui.notify("Counting real tokens via Anthropic…", "info");
        try {
          breakdown = await measureReal(apiKey, inputs, ctx.signal);
          real = true;
        } catch (err) {
          breakdown = estimateBreakdown(inputs);
          note =
            err instanceof Error
              ? `count_tokens failed: ${err.message.slice(0, 60)}`
              : "count_tokens failed";
        }
      } else {
        breakdown = estimateBreakdown(inputs);
        note = isAnthropic
          ? "no ANTHROPIC_API_KEY"
          : `${ctx.model?.provider ?? "provider"} has no exact local tokenizer`;
      }

      const totalTokens = breakdown.totalTokens;
      const freeTok = Math.max(0, window - totalTokens - reserve);

      const categories: Category[] = [
        { label: "System prompt", tokens: breakdown.systemTok, role: "accent", glyph: "█" },
        { label: "System tools", tokens: breakdown.systemToolsTok, role: "success", glyph: "█" },
        { label: "MCP tools", tokens: breakdown.mcpToolsTok, role: "warning", glyph: "█" },
        { label: "Messages", tokens: breakdown.messagesTok, role: "mdLink", glyph: "█" },
        { label: "Free space", tokens: freeTok, role: "dim", glyph: "·" },
        { label: "Reserve (compaction headroom)", tokens: reserve, role: "muted", glyph: "▒" },
      ];

      const sourceLabel = real
        ? inputs.haveMessages
          ? "real · Anthropic count_tokens"
          : "real · Anthropic count_tokens (no messages yet)"
        : `estimated (calibrated chars/token) — ${note}`;

      await ctx.ui.custom<undefined>(
        (_tui, theme, _keybindings, done) =>
          new ContextOverlay(theme, done, {
            modelName,
            window,
            totalTokens,
            estimated: !real,
            sourceLabel,
            categories,
            mcpServers: breakdown.serverToks,
            mcpToolCount: breakdown.mcpToolCount,
            systemToolCount: breakdown.systemToolCount,
          }),
        { overlay: true },
      );
    },
  });
}

interface OverlayData {
  modelName: string;
  window: number;
  totalTokens: number;
  estimated: boolean;
  sourceLabel: string;
  categories: Category[];
  mcpServers: Array<{ server: string; tokens: number; count: number }>;
  mcpToolCount: number;
  systemToolCount: number;
}

class ContextOverlay {
  readonly width = 78;
  focused = false;

  private scroll = 0;
  private readonly viewport = 36;

  constructor(
    private readonly theme: Theme,
    private readonly done: (result: undefined) => void,
    private readonly data: OverlayData,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.scroll += 1;
    } else if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.scroll = Math.max(0, this.scroll - 1);
    }
  }

  // 10x10 grid; each cell ≈ 1% of the window, filled in category order.
  private buildGrid(): string[] {
    const th = this.theme;
    const win = this.data.window || 1;
    const cells: Array<{ role: ThemeColor; ch: string }> = [];
    const push = (tokens: number, role: ThemeColor, ch: string) => {
      const n = Math.round((tokens / win) * 100);
      for (let i = 0; i < n && cells.length < 100; i++) cells.push({ role, ch });
    };
    for (const cat of this.data.categories) push(cat.tokens, cat.role, cat.glyph);
    while (cells.length < 100) cells.push({ role: "dim", ch: "·" });

    const rows: string[] = [];
    for (let r = 0; r < 10; r++) {
      const parts: string[] = [];
      for (let c = 0; c < 10; c++) {
        const cell = cells[r * 10 + c]!;
        parts.push(th.fg(cell.role, cell.ch));
      }
      rows.push(parts.join(" "));
    }
    return rows;
  }

  private buildLegend(): string[] {
    const th = this.theme;
    const d = this.data;
    const win = d.window || 1;
    const lines: string[] = [];

    const pct = win > 0 ? d.totalTokens / win : 0;
    lines.push(th.bold(th.fg("text", "Context Usage")));
    lines.push(th.fg("dim", d.modelName));
    lines.push(
      th.fg(
        "text",
        `${fmtTokens(d.totalTokens)}/${fmtTokens(win)} tokens (${fmtPct(pct)})`,
      ),
    );
    lines.push(
      d.estimated
        ? th.fg("warning", `≈ ${d.sourceLabel}`)
        : th.fg("success", `✓ ${d.sourceLabel}`),
    );
    lines.push("");
    lines.push(th.fg("dim", "Usage by category"));

    for (const cat of d.categories) {
      const frac = win > 0 ? cat.tokens / win : 0;
      let label = cat.label;
      if (cat.label === "System tools") label += ` (${d.systemToolCount})`;
      if (cat.label === "MCP tools") label += ` (${d.mcpToolCount})`;
      lines.push(
        `${th.fg(cat.role, cat.glyph)} ${th.fg("text", label)}: ${th.fg(
          "text",
          `${fmtTokens(cat.tokens)}`,
        )} ${th.fg("dim", `(${fmtPct(frac)})`)}`,
      );
    }

    if (d.mcpServers.length > 0) {
      lines.push("");
      lines.push(th.fg("dim", "MCP tools by server"));
      for (const s of d.mcpServers) {
        const frac = win > 0 ? s.tokens / win : 0;
        lines.push(
          `  ${th.fg("warning", "▸")} ${th.fg("text", s.server)} ${th.fg(
            "dim",
            `(${s.count})`,
          )}: ${th.fg("text", fmtTokens(s.tokens))} ${th.fg(
            "dim",
            `(${fmtPct(frac)})`,
          )}`,
        );
      }
    }

    return lines;
  }

  render(_width: number): string[] {
    const th = this.theme;
    const w = this.width;
    const innerW = w - 2;
    const pad = (s: string, len: number) =>
      s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) =>
      th.fg("border", "│") + pad(` ${content}`, innerW) + th.fg("border", "│");

    const grid = this.buildGrid();
    const legend = this.buildLegend();
    const gridWidth = visibleWidth(grid[0] ?? "");

    const bodyRows: string[] = [];
    const total = Math.max(grid.length, legend.length);
    for (let i = 0; i < total; i++) {
      const left = grid[i] ?? "";
      const leftPadded =
        left + " ".repeat(Math.max(0, gridWidth - visibleWidth(left)));
      const right = legend[i] ?? "";
      bodyRows.push(`${leftPadded}   ${right}`);
    }

    const visible =
      bodyRows.length > this.viewport
        ? bodyRows.slice(this.scroll, this.scroll + this.viewport)
        : bodyRows;

    const lines: string[] = [];
    lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
    for (const r of visible) lines.push(row(r));
    lines.push(row(""));
    const hint =
      bodyRows.length > this.viewport ? "↑↓ scroll • Esc close" : "Esc close";
    lines.push(row(th.fg("dim", hint)));
    lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}
