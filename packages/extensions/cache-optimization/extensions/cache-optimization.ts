// cache-optimization.ts — prompt-cache efficiency toolkit for Pi.
//
// Three duties, one extension:
//   1. /cache — per-turn cache report with break detection and attribution
//      (session-entry correlation + live prefix fingerprints, hashes only).
//   2. Cache keeper — stamps Anthropic's spare 4th cache_control breakpoint
//      when a burst of appended blocks would push the previous cache write
//      out of the provider's 20-block lookback window (keeper.ts).
//   3. TTL keepalive — cheap prefix re-reads during long foreground tool waits
//      or idle background-work waits so the 5-minute Anthropic cache doesn't
//      expire before the next request; structurally bounded against runaway (keepalive.ts).
//
// Privacy: fingerprint state is sha256 hashes only, in-memory only. The
// keepalive re-sends a captured payload solely to its original provider
// (api.anthropic.com) using the local ANTHROPIC_API_KEY. Nothing here enters
// LLM context except the report the user explicitly opens.

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildCacheReport,
  formatCost,
  snapshotPayload,
  type FingerprintSnapshot,
  type ReportLine,
  type SnapshotPair,
} from "./cache-optimization/cache.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyCacheKeeper, type KeeperState } from "./cache-optimization/keeper.ts";
import { CacheKeepalive, hasBackgroundLaunchFlag, isAnthropicOAuthToken, isNonApiKeyAnthropicAuth, type RequestRoute } from "./cache-optimization/keepalive.ts";

// Bound on retained fingerprint pairs (hashes only) so long sessions don't grow unboundedly.
const MAX_FINGERPRINT_PAIRS = 500;
/** Coarse keepalive scheduler cadence; the real gating lives in CacheKeepalive.tick(). */
const KEEPALIVE_TICK_MS = 30_000;

type FingerprintState = {
  /** Snapshot of the most recent outgoing provider payload, not yet paired with a turn. */
  pending?: FingerprintSnapshot;
  /** The last snapshot paired with a finished turn (previous request in this process). */
  lastPaired?: FingerprintSnapshot;
  /** Pairs keyed by assistant message timestamp (Unix ms). Hashes only — never payload content. */
  byTimestamp: Map<number, SnapshotPair>;
};

/**
 * True when ~/.pi/agent/auth.json authenticates Anthropic with something other
 * than a plain API key (e.g. OAuth). Keepalive pings use env ANTHROPIC_API_KEY,
 * and Anthropic caches are isolated per org/workspace — a ping through a
 * different identity would refresh nothing the session actually reads.
 */
function anthropicUsesNonApiKeyAuth(): boolean {
  // Pi's highest-priority auth source is a CLI --api-key runtime override; a
  // session keyed that way may bill/cache under a different identity than the
  // env key a ping would use. We can't read the override's value, so the
  // presence of the flag disables pings outright.
  if (process.argv.includes("--api-key")) return true;
  // Pi's env fallback prefers ANTHROPIC_OAUTH_TOKEN over ANTHROPIC_API_KEY,
  // and Anthropic OAuth tokens can also appear in ANTHROPIC_API_KEY
  // (`sk-ant-oat...`). Keepalive sends x-api-key, so either shape is a
  // different auth route and must disable pings.
  if (process.env.ANTHROPIC_OAUTH_TOKEN || isAnthropicOAuthToken(process.env.ANTHROPIC_API_KEY)) return true;
  const dir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent");
  const authPath = join(dir, "auth.json");
  if (!existsSync(authPath)) return false;
  try {
    return isNonApiKeyAnthropicAuth(JSON.parse(readFileSync(authPath, "utf8")));
  } catch {
    return true;
  }
}

function hasAnthropicRequestOverrides(modelRegistry: unknown, model: unknown): boolean {
  if (!model || typeof model !== "object") return true;
  const provider = (model as { provider?: unknown }).provider;
  const id = (model as { id?: unknown }).id;
  if (provider !== "anthropic") return false;
  if (typeof id !== "string") return true;
  const headers = (model as { headers?: unknown }).headers;
  if (headers && typeof headers === "object" && Object.keys(headers).length > 0) return true;
  if (!modelRegistry || typeof modelRegistry !== "object") return true;
  const authStorage = (modelRegistry as { authStorage?: unknown }).authStorage;
  if (!isPlainEnvAnthropicAuthStorage(authStorage)) return true;
  const providerConfigs = (modelRegistry as { providerRequestConfigs?: unknown }).providerRequestConfigs;
  const modelHeaders = (modelRegistry as { modelRequestHeaders?: unknown }).modelRequestHeaders;
  if (!(providerConfigs instanceof Map) || !(modelHeaders instanceof Map)) return true;
  if (providerConfigs.has("anthropic")) return true;
  if (modelHeaders.has(`anthropic:${id}`)) return true;
  return false;
}

function isPlainEnvAnthropicAuthStorage(authStorage: unknown): boolean {
  if (!authStorage || typeof authStorage !== "object") return false;
  const runtimeOverrides = (authStorage as { runtimeOverrides?: unknown }).runtimeOverrides;
  const data = (authStorage as { data?: unknown }).data;
  const loadError = (authStorage as { loadError?: unknown }).loadError;
  if (loadError !== null && loadError !== undefined) return false;
  if (!(runtimeOverrides instanceof Map)) return false;
  if (runtimeOverrides.has("anthropic")) return false;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return !("anthropic" in data);
}

export default function cacheOptimization(pi: any) {
  activate(pi);
}

/** Testable entry: inject a CacheKeepalive with fake deps to observe the wiring. */
export function activate(
  pi: any,
  keepalive: CacheKeepalive = new CacheKeepalive({
    now: () => Date.now(),
    fetch: (url, init) => fetch(url, init),
    env: process.env,
  }),
) {
  let fingerprints: FingerprintState = { byTimestamp: new Map() };
  let keeperState: KeeperState = {};
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  pi.on("session_start", () => {
    fingerprints = { byTimestamp: new Map() };
    keeperState = {};
    if (!keepaliveTimer) {
      keepaliveTimer = setInterval(() => void keepalive.tick(), KEEPALIVE_TICK_MS);
      keepaliveTimer.unref?.();
    }
  });

  pi.on("session_shutdown", () => {
    keepalive.shutdown();
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  });

  pi.on("session_tree", () => {
    keepalive.branchSwitch();
  });

  // One handler, three concerns: fingerprint the outgoing payload (hashes only),
  // let the keeper stamp its breakpoint when needed, and re-anchor the keepalive.
  pi.on("before_provider_request", (event: any, ctx: any) => {
    let outgoing = event?.payload;
    let replacement: unknown | undefined;
    try {
      const result = applyCacheKeeper(outgoing, keeperState);
      if (result.action === "stamped" && result.payload !== undefined) {
        replacement = result.payload;
        outgoing = result.payload;
      }
    } catch {
      replacement = undefined; // keeper must never break a request
    }
    try {
      fingerprints.pending = snapshotPayload(outgoing);
    } catch {
      fingerprints.pending = undefined;
    }
    try {
      const route: RequestRoute = {
        provider: ctx?.model?.provider,
        api: ctx?.model?.api,
        baseUrl: ctx?.model?.baseUrl,
        nonApiKeyAuth: anthropicUsesNonApiKeyAuth() || hasAnthropicRequestOverrides(ctx?.modelRegistry, ctx?.model),
        cacheReadPricePerMTok: ctx?.model?.cost?.cacheRead,
      };
      keepalive.noteProviderRequest(outgoing, route);
    } catch {
      keepalive.clearCapture();
    }
    return replacement;
  });

  pi.on("turn_end", (event: any) => {
    const message = event?.message;
    if (fingerprints.pending && message?.role === "assistant" && typeof message.timestamp === "number") {
      fingerprints.byTimestamp.set(message.timestamp, { prev: fingerprints.lastPaired, curr: fingerprints.pending });
      fingerprints.lastPaired = fingerprints.pending;
      fingerprints.pending = undefined;
      while (fingerprints.byTimestamp.size > MAX_FINGERPRINT_PAIRS) {
        const oldest = fingerprints.byTimestamp.keys().next().value;
        if (oldest === undefined) break;
        fingerprints.byTimestamp.delete(oldest);
      }
    }
    const usage = message?.usage;
    if (usage) {
      // Aborted/errored turns persist zero-initialized usage; letting a zero
      // overwrite a real prompt size would silently disarm the keepalive floor
      // for the next gap (mirrors collectTurnStats' zero-usage exclusion).
      const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      if (promptTokens > 0) keepalive.noteTurnUsage(promptTokens);
    }
  });

  pi.on("tool_execution_start", (event: any) => {
    const id = toolExecutionId(event);
    keepalive.toolStart(id);
    if (hasBackgroundLaunchFlag(event?.args ?? event?.input)) keepalive.backgroundWorkStart(id);
  });
  pi.on("tool_call", (event: any) => {
    const id = toolExecutionId(event);
    if (hasBackgroundLaunchFlag(event?.input ?? event?.args)) keepalive.backgroundWorkStart(id);
  });
  pi.on("tool_execution_end", (event: any) => {
    keepalive.toolEnd(toolExecutionId(event));
  });
  pi.on("agent_end", () => {
    keepalive.agentEnd();
  });

  pi.registerCommand?.("cache", {
    description: "Session cache report: per-turn hit rates, breaks, and why they happened",
    handler: async (_args: string, ctx: any) => {
      const report = buildCacheReport({
        branch: ctx.sessionManager.getBranch(),
        snapshots: fingerprints.byTimestamp,
        longRetention: process.env.PI_CACHE_RETENTION === "long",
      });
      // Keepalive spend must stay auditable: surface today's pings in the report.
      const ka = keepalive.state;
      report.lines.push({ text: "", tone: "text" });
      report.lines.push({
        text:
          ka.dayPings > 0
            ? `TTL keepalive: ${ka.dayPings} ping${ka.dayPings === 1 ? "" : "s"} today · est ${formatCost(ka.daySpendUsd)}${ka.lastPingOk === false ? " · last ping FAILED" : ""}`
            : "TTL keepalive: no pings today",
        tone: ka.lastPingOk === false ? "warning" : "muted",
      });
      // Display-only overlay: the report never enters LLM context.
      await ctx.ui.custom(
        (tui: any, theme: any, _keybindings: any, done: (result: undefined) => void) =>
          new CacheReportOverlay(theme, done, report.lines, overlayViewportRows(tui), tui?.terminal),
        { overlay: true },
      );
    },
  });
}

/** Size the report viewport to the terminal so the tail stays reachable on short screens. */
function toolExecutionId(event: any): string {
  return String(event?.toolCallId ?? event?.id ?? "tool");
}

function overlayViewportRows(tui: any): number {
  const rows = tui?.terminal?.rows;
  if (typeof rows !== "number" || rows <= 0) return 30;
  // Leave headroom for the border, title, and hint rows.
  return Math.max(8, Math.min(30, rows - 6));
}

// SGR mouse reporting: enabled only while the overlay is open so the wheel
// scrolls the report instead of the terminal scrollback. Always disabled on
// close/dispose to restore native terminal selection behavior.
const MOUSE_ENABLE = "\x1b[?1006h\x1b[?1000h";
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1006l";
const WHEEL_SCROLL_LINES = 3;

/** Net wheel movement in an input chunk: negative = up, positive = down. */
function wheelDelta(data: string): number {
  let delta = 0;
  const sequence = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
  let match: RegExpExecArray | null;
  while ((match = sequence.exec(data))) {
    const base = Number(match[1]) & ~28; // strip shift/alt/ctrl modifier bits
    if (base === 64) delta -= 1;
    else if (base === 65) delta += 1;
  }
  return delta;
}

// Bordered report panel styled after the context-breakdown overlay: rounded
// border, bold title, tone-tagged body rows, dim hint row inside the frame.
class CacheReportOverlay {
  readonly width = 78;
  focused = false;
  private scroll = 0;
  private readonly viewport: number;
  private mouseEnabled = false;

  constructor(
    private readonly theme: any,
    private readonly done: (result: undefined) => void,
    readonly lines: ReportLine[],
    viewport = 30,
    private readonly terminal?: { write(data: string): void },
  ) {
    this.viewport = viewport;
    if (this.terminal) {
      this.terminal.write(MOUSE_ENABLE);
      this.mouseEnabled = true;
    }
  }

  private releaseMouse(): void {
    if (this.mouseEnabled) {
      this.terminal?.write(MOUSE_DISABLE);
      this.mouseEnabled = false;
    }
  }

  private scrollBy(delta: number): void {
    const maxScroll = Math.max(0, this.lines.length - this.viewport);
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + delta));
  }

  handleInput(data: string): void {
    const wheel = wheelDelta(data);
    if (wheel !== 0) {
      this.scrollBy(wheel * WHEEL_SCROLL_LINES);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
      this.releaseMouse();
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) this.scrollBy(-1);
    else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) this.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scrollBy(-this.viewport);
    else if (matchesKey(data, "pageDown")) this.scrollBy(this.viewport);
  }

  dispose(): void {
    this.releaseMouse();
  }

  render(width: number): string[] {
    const th = this.theme;
    const w = Math.min(this.width, Math.max(40, width));
    const innerW = w - 2;
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) =>
      color(th, "border", "│") + pad(` ${truncateToWidth(content, innerW - 1)}`, innerW) + color(th, "border", "│");

    const out: string[] = [];
    out.push(color(th, "border", `╭${"─".repeat(innerW)}╮`));
    out.push(row(bold(th, color(th, "text", "Cache report"))));
    out.push(row(""));
    for (const line of this.lines.slice(this.scroll, this.scroll + this.viewport)) {
      out.push(row(color(th, line.tone, line.text)));
    }
    out.push(row(""));
    const hint =
      this.lines.length > this.viewport
        ? `↑↓/wheel scroll • PgUp/PgDn page (${this.scroll + 1}-${Math.min(this.scroll + this.viewport, this.lines.length)}/${this.lines.length}) • Esc close`
        : "Esc close";
    out.push(row(color(th, "dim", hint)));
    out.push(color(th, "border", `╰${"─".repeat(innerW)}╯`));
    return out;
  }

  invalidate(): void {}
}

function bold(theme: any, text: string): string {
  try {
    return theme.bold(text);
  } catch {
    return text;
  }
}

function color(theme: any, tone: string, text: string): string {
  try {
    return theme.fg(tone, text);
  } catch {
    return text;
  }
}
