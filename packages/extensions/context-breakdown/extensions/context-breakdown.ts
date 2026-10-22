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
// For non-Anthropic models (e.g. openai/*) the total is Pi's own context usage and the
// split is a calibrated chars/token estimate (prose /4, tool JSON /2.5), labelled as such.
//
// The breakdown describes the last request Pi sent for the current model. Compaction,
// tree navigation and a model switch change the context without a request, so then the
// messages part is estimated from the session until the next request, and says so.

import {
  estimateTokens,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
  type ToolInfo,
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

const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const FALLBACK_MODEL_ID = "claude-opus-4-20250514";

/** Pi plumbing such as `__pi_deferred_placeholder__`: Pi's own, never an MCP server. */
function isPiInternalTool(name: string): boolean {
  return name.startsWith("__pi_");
}

/** Where count_tokens goes: an explicit override, else wherever Pi routes Anthropic. */
function anthropicBaseUrl(ctx: ExtensionCommandContext): string {
  const routed = ctx.model?.provider === "anthropic" ? ctx.model.baseUrl : undefined;
  return (process.env.ANTHROPIC_BASE_URL || routed || DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
}

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
  /** Beta features the request was sent with; count_tokens must see the same ones. */
  betas: string[];
  /** Tool definitions that reached the model inside the conversation, counted in Messages. */
  toolsAddedInConversation: number;
}

function roleOf(item: unknown): unknown {
  return item && typeof item === "object" ? (item as Record<string, unknown>).role : undefined;
}

/** Tool definitions carried by a conversation item (Anthropic tool_addition, OpenAI additional_tools). */
function toolsInItem(item: unknown): unknown[] {
  if (!item || typeof item !== "object") return [];
  const record = item as Record<string, unknown>;
  if (Array.isArray(record.tools)) return record.tools;
  if (!Array.isArray(record.content)) return [];
  return record.content.flatMap((block) => {
    const b = block as Record<string, any> | null;
    return b?.type === "tool_addition" && b.tool ? [b.tool.definition ?? b.tool] : [];
  });
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

// Build the inputs from the captured request payload when there is one for the current
// model, otherwise from the live system prompt and active tools, with no messages.
//
// Anthropic payloads keep every message, including Pi 1.4's mid-conversation
// role:"system" messages (tool additions, effort markers): they are request tokens.
// Other payloads (OpenAI Responses `input`, chat `messages`) carry the system prompt
// and tool declarations as system/developer items, which are split out here.
function buildInputs(
  payload: unknown,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  anthropic: boolean,
): AnthropicInputs {
  let model = ctx.model?.id ?? FALLBACK_MODEL_ID;
  let system: AnthropicSystem | undefined;
  let rawTools: unknown[] = [];
  let messages: unknown[] = [];
  let betas: string[] = [];
  let toolsAddedInConversation = 0;

  const p =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;

  if (p) {
    // The payload was captured for the current model, so its id is the one the
    // provider knows (an alias's target, for instance).
    if (typeof p.model === "string") model = p.model;
    if (Array.isArray(p.tools)) rawTools = [...p.tools];
    if (Array.isArray(p.betas)) betas = p.betas.filter((b): b is string => typeof b === "string");
    const conversation = Array.isArray(p.messages) ? p.messages : Array.isArray(p.input) ? p.input : [];
    if (anthropic) {
      if (typeof p.system === "string" || Array.isArray(p.system)) system = p.system as AnthropicSystem;
      messages = conversation;
      toolsAddedInConversation = conversation.reduce((n: number, item) => n + toolsInItem(item).length, 0);
    } else {
      const systemParts: unknown[] = [];
      if (typeof p.instructions === "string") systemParts.push(p.instructions);
      for (const item of conversation) {
        const role = roleOf(item);
        if (role === "system" || role === "developer") {
          const tools = toolsInItem(item);
          if (tools.length > 0) rawTools.push(...tools);
          else systemParts.push((item as Record<string, unknown>).content);
        } else {
          messages.push(item);
        }
      }
      if (systemParts.length > 0) {
        system = systemParts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("\n\n");
      }
    }
  }
  const haveMessages = messages.length > 0;

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
    if (PI_BUILTIN_TOOLS.has(tool.name) || isPiInternalTool(tool.name)) {
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

  return { model, system, systemTools, mcpServers, allTools, messages, haveMessages, betas, toolsAddedInConversation };
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

interface CountClient {
  apiKey: string;
  baseUrl: string;
  betas: string[];
  signal: AbortSignal | undefined;
}

async function countTokens(client: CountClient, body: CountBody): Promise<number> {
  const res = await fetch(`${client.baseUrl}/v1/messages/count_tokens`, {
    method: "POST",
    headers: {
      "x-api-key": client.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      // Mid-conversation system messages exist only under the request's betas.
      ...(client.betas.length > 0 ? { "anthropic-beta": client.betas.join(",") } : {}),
    },
    body: JSON.stringify(body),
    signal: client.signal,
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

async function measureFixed(client: CountClient, inputs: AnthropicInputs): Promise<FixedCounts> {
  const key = hash(
    client.baseUrl +
      "\u0000" +
      client.betas.join(",") +
      "\u0000" +
      inputs.model +
      "\u0000" +
      JSON.stringify(inputs.system) +
      "\u0000" +
      JSON.stringify(inputs.allTools),
  );
  const cached = fixedCache.get(key);
  if (cached) return cached;

  const m = inputs.model;
  const dot = await countTokens(client, { model: m, messages: PLACEHOLDER_MESSAGES });
  const sysOnly = await countTokens(client, { model: m, system: inputs.system, messages: PLACEHOLDER_MESSAGES });
  // Cumulative: add builtin tools, then each server in turn, taking exact deltas.
  const cumulative: AnthropicTool[] = [...inputs.systemTools];
  const afterSystemTools =
    cumulative.length > 0
      ? await countTokens(client, { model: m, system: inputs.system, tools: cumulative, messages: PLACEHOLDER_MESSAGES })
      : sysOnly;
  const systemToolsTok = afterSystemTools - sysOnly;

  let prev = afterSystemTools;
  const serverToks: Array<{ server: string; tokens: number; count: number }> = [];
  for (const { server, tools } of inputs.mcpServers) {
    cumulative.push(...tools);
    const cur = await countTokens(client, { model: m, system: inputs.system, tools: cumulative, messages: PLACEHOLDER_MESSAGES });
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

async function measureReal(client: CountClient, inputs: AnthropicInputs): Promise<RealBreakdown> {
  const fixed = await measureFixed(client, inputs);

  let totalTokens: number;
  let messagesTok: number;
  if (inputs.haveMessages) {
    const full = await countTokens(client, {
      model: inputs.model,
      system: inputs.system,
      tools: inputs.allTools,
      messages: inputs.messages,
    });
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
// Pi's own estimate for one image (ESTIMATED_IMAGE_CHARS in Pi's compaction code): an
// image costs a bounded number of tokens, not its base64 length as prose.
const IMAGE_CHARS = 4800;

function isImageBlock(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>).type;
  return type === "image" || type === "input_image";
}

/** Characters of a conversation for estimation, each image counted as one image. */
function conversationChars(messages: unknown[]): number {
  let images = 0;
  const json = JSON.stringify(messages, (_key, value) => {
    if (isImageBlock(value)) {
      images += 1;
      return null;
    }
    return value;
  });
  return json.length + images * IMAGE_CHARS;
}

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
  const messagesChars = inputs.haveMessages ? conversationChars(inputs.messages) : 0;
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

/** Pi's effective compaction reserve for the model: none when compaction is off. */
function readReserve(pi: ExtensionAPI, ctx: ExtensionCommandContext): { tokens: number; enabled: boolean } {
  const settings = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
  return { tokens: settings.enabled ? settings.reserveTokens : 0, enabled: settings.enabled };
}

/**
 * Pi's estimate of the conversation now, for when the last request no longer describes
 * it: the non-system messages of the session's context, sized as Pi sizes them.
 */
function estimateSessionMessages(ctx: ExtensionCommandContext): number {
  let tokens = 0;
  for (const message of ctx.sessionManager.buildSessionProjection().messages) {
    if (message.role !== "system") tokens += estimateTokens(message);
  }
  return tokens;
}

function withMessages(breakdown: RealBreakdown, messagesTok: number): RealBreakdown {
  return {
    ...breakdown,
    messagesTok,
    totalTokens: breakdown.systemTok + breakdown.systemToolsTok + breakdown.mcpToolsTok + messagesTok,
  };
}

/**
 * Fit an estimated split to a known total. Whatever the estimated system prompt and tools leave of the
 * total is the conversation. When they alone come to more than the total (the estimate runs high, as with
 * large tool schemas early in a session), every part is scaled down in proportion instead, and the
 * conversation keeps a share as long as there is one.
 */
function withTotal(breakdown: RealBreakdown, total: number): RealBreakdown {
  const fixed = breakdown.systemTok + breakdown.systemToolsTok + breakdown.mcpToolsTok;
  if (total > fixed) return withMessages(breakdown, total - fixed);
  const estimated = fixed + breakdown.messagesTok;
  if (estimated <= 0) return withMessages(breakdown, total);
  const scale = total / estimated;
  const systemTok = Math.floor(breakdown.systemTok * scale);
  const systemToolsTok = Math.floor(breakdown.systemToolsTok * scale);
  const mcpToolsTok = Math.floor(breakdown.mcpToolsTok * scale);
  return withMessages({ ...breakdown, systemTok, systemToolsTok, mcpToolsTok }, total - systemTok - systemToolsTok - mcpToolsTok);
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

interface CapturedRequest {
  payload: unknown;
  provider: string | undefined;
  modelId: string | undefined;
}

export default function contextBreakdown(pi: ExtensionAPI) {
  let captured: CapturedRequest | undefined;
  const forget = () => {
    captured = undefined;
  };

  pi.on("before_provider_request", (event, ctx) => {
    captured = { payload: event.payload, provider: ctx.model?.provider, modelId: ctx.model?.id };
    // Never mutate the payload — return nothing so pi sends it unchanged.
  });
  // Each of these changes what the next request will hold without sending one.
  pi.on("session_compact", forget);
  pi.on("session_tree", forget);
  pi.on("model_select", forget);

  pi.registerCommand("context", {
    description:
      "Popup breakdown of context usage (real token counts on Anthropic)",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const usage = ctx.getContextUsage();
      const modelName = ctx.model
        ? `${ctx.model.provider}/${ctx.model.id}`
        : "unknown model";
      const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 200000;
      const reserve = readReserve(pi, ctx);

      const current =
        captured && captured.provider === ctx.model?.provider && captured.modelId === ctx.model?.id
          ? captured.payload
          : undefined;
      const isAnthropic = (ctx.model?.provider ?? "").toLowerCase() === "anthropic";
      const inputs = buildInputs(current, pi, ctx, isAnthropic);
      // No request for this context yet: the conversation (if any) comes from the session.
      const sessionMessages = current === undefined ? estimateSessionMessages(ctx) : 0;
      const apiKey = process.env.ANTHROPIC_API_KEY;

      let breakdown: RealBreakdown;
      let real = false;
      let note = "";

      if (isAnthropic && apiKey) {
        ctx.ui.notify("Counting real tokens via Anthropic…", "info");
        try {
          breakdown = await measureReal(
            { apiKey, baseUrl: anthropicBaseUrl(ctx), betas: inputs.betas, signal: ctx.signal },
            inputs,
          );
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

      const messagesFromSession = sessionMessages > 0;
      if (messagesFromSession) breakdown = withMessages(breakdown, sessionMessages);

      // Off Anthropic, Pi's own context usage is the best total there is; the parts it
      // cannot split go to Messages.
      const totalFromPi = !isAnthropic && typeof usage?.tokens === "number";
      if (totalFromPi) breakdown = withTotal(breakdown, usage.tokens as number);

      const totalTokens = breakdown.totalTokens;
      const freeTok = Math.max(0, window - totalTokens - reserve.tokens);

      const categories: Category[] = [
        { label: "System prompt", tokens: breakdown.systemTok, role: "accent", glyph: "█" },
        { label: "System tools", tokens: breakdown.systemToolsTok, role: "success", glyph: "█" },
        { label: "MCP tools", tokens: breakdown.mcpToolsTok, role: "warning", glyph: "█" },
        {
          label: inputs.toolsAddedInConversation > 0
            ? `Messages (incl. ${inputs.toolsAddedInConversation} tool${inputs.toolsAddedInConversation === 1 ? "" : "s"} added mid-session)`
            : "Messages",
          tokens: breakdown.messagesTok,
          role: "mdLink",
          glyph: "█",
        },
        { label: "Free space", tokens: freeTok, role: "dim", glyph: "·" },
        {
          label: reserve.enabled ? "Reserve (compaction headroom)" : "Reserve (compaction off)",
          tokens: reserve.tokens,
          role: "muted",
          glyph: "▒",
        },
      ];

      const pending = "messages estimated from the session until the next request";
      const sourceLabel = totalFromPi
        ? `total from Pi's context usage · split estimated (calibrated chars/token)${messagesFromSession ? ` · ${pending}` : ""}`
        : real
          ? messagesFromSession
            ? `system and tools: Anthropic count_tokens · ${pending}`
            : inputs.haveMessages
              ? "real · Anthropic count_tokens"
              : "real · Anthropic count_tokens (no messages yet)"
          : `estimated (calibrated chars/token) — ${note}${messagesFromSession ? ` · ${pending}` : ""}`;
      const estimated = !real || messagesFromSession;

      await ctx.ui.custom<undefined>(
        (_tui, theme, _keybindings, done) =>
          new ContextOverlay(theme, done, {
            modelName,
            window,
            totalTokens,
            estimated,
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
