// keepalive.ts — runaway-proof Anthropic prompt-cache TTL keepalive.
//
// Anthropic's 5-minute cache TTL refreshes free on every read. When the agent
// loop stalls past the TTL mid-turn (long subagent runs, slow builds), the
// next request rewrites the whole prefix at 1.25x input price (~$5-6 at 500k
// context). A tiny re-read of the same prefix costs 0.1x — ~12.5x cheaper —
// and resets the clock.
//
// Runaway is prevented structurally, not by tuning:
//   1. Pings fire only while at least one tool execution is in flight — the
//      one state where the next real request is near-certain. Idle at the
//      prompt (user walked away) => zero pings, ever.
//   2. Per-gap budget: at most PER_GAP_MAX_PINGS pings between real provider
//      requests (~0.5x the rewrite cost the pings try to prevent), then silence.
//   3. Daily dollar cap across the whole session as a backstop for bugs.
//   4. Activation floor: below MIN_PROMPT_TOKENS the rewrite is cheap enough
//      that keepalive isn't worth the moving parts.
//   5. Anthropic 5m-TTL only: payloads with 1h markers (PI_CACHE_RETENTION=long)
//      or non-Anthropic payloads are never pinged — the 1h TTL already covers
//      these gaps, and other providers have no marker-based TTL to keep alive.
//   6. Extended-thinking payloads are never pinged: Anthropic invalidates the
//      messages-level cache when thinking parameters change, and max_tokens=1
//      cannot carry the original thinking budget — a stripped ping would miss
//      the real cache entirely and write a parallel entry at full price.
//   7. Same-route only: pings fire only when the session's own request went to
//      the default Anthropic API with API-key auth (caller-supplied route
//      metadata) — caches are isolated per org/workspace, so pinging through a
//      different identity or base URL would refresh nothing the session reads.
//
// Worst case ever: one hung tool costs PER_GAP_MAX_PINGS reads (~half of one
// rewrite) and then the rewrite anyway — bounded at ~1.5x one break, once.

/** Ping when the cache is this old and still in use (TTL is 5 minutes). */
export const PING_AFTER_IDLE_MS = 4.5 * 60_000;
/**
 * Max pings per gap between real provider requests. Rewrite = prompt x 1.25x
 * input price; ping = prompt x 0.1x. 6 pings ~= half of one rewrite.
 */
export const PER_GAP_MAX_PINGS = 6;
/**
 * Daily budget backstop across all gaps (estimated read cost, USD). Sized to
 * fit at least one full gap budget at the headline scale (6 pings x ~$0.50 at
 * 500k fable tokens) so the per-gap cap — not this backstop — is the operating
 * bound; the backstop exists for bugs and pathological days. Per pi process.
 */
export const DAILY_BUDGET_USD = 3.0;
/** Don't bother below this prompt size — the rewrite it saves is < ~$1. */
export const MIN_PROMPT_TOKENS = 100_000;

/**
 * Fallback cache-read $/MTok by model substring (Anthropic list prices; 0.1x
 * input). First match wins — specific generations before generic families.
 * The authoritative price is ctx.model.cost.cacheRead, plumbed per-request via
 * RequestRoute; this table only covers requests without route pricing.
 */
const READ_PRICE_PER_MTOK: ReadonlyArray<readonly [string, number]> = [
  ["fable", 1.0],
  ["mythos", 1.0],
  ["opus-4-1", 1.5],
  ["opus-4-0", 1.5],
  ["opus-4-2025", 1.5],
  ["3-opus", 1.5],
  ["opus", 0.5],
  ["sonnet-5", 0.2],
  ["sonnet", 0.3],
  ["haiku", 0.1],
];
const DEFAULT_READ_PRICE_PER_MTOK = 1.0;

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface KeepaliveDeps {
  now(): number;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<{ ok: boolean }>;
  env: Record<string, string | undefined>;
}

/** Abort a hung ping so pingInFlight can never wedge the keepalive. */
const PING_TIMEOUT_MS = 30_000;

/**
 * Inspect a captured payload: is this an Anthropic request whose cache markers
 * carry the default 5-minute TTL, with extended thinking off? 1h markers mean
 * retention is handled upstream (PI_CACHE_RETENTION=long). An *enabled*
 * thinking param makes the payload unpingable: thinking-setting changes
 * invalidate the messages-level cache, and a 1-token ping cannot reproduce the
 * original thinking budget — so no cheap identical-prefix read exists. Pi
 * sends an explicit `thinking: { type: "disabled" }` marker on every
 * reasoning-capable Claude model when thinking is off; the ping replays it
 * byte-identically, so disabled-marker payloads stay pingable.
 */
export function isPingablePayload(payload: unknown): boolean {
  if (!isDict(payload) || !Array.isArray(payload.messages)) return false;
  if (typeof payload.model !== "string" || !/claude/i.test(payload.model)) return false;
  const thinking = payload.thinking;
  if (thinking !== undefined && !(isDict(thinking) && thinking.type === "disabled")) return false;
  const markers = collectCacheMarkers(payload);
  if (markers.length === 0) return false; // caching not enabled on this request
  return markers.every((marker) => marker.ttl === undefined || marker.ttl === "5m");
}

/** Route metadata for the request that produced a captured payload. */
export interface RequestRoute {
  /** Pi provider id, e.g. "anthropic" (not bedrock/vertex/proxies). */
  provider?: string;
  /** Model baseUrl override; undefined/default means api.anthropic.com. */
  baseUrl?: string;
  /** True when the session authenticates to Anthropic with something other than a plain API key (e.g. OAuth). */
  nonApiKeyAuth?: boolean;
  /** Authoritative cache-read $/MTok from pi's model registry (ctx.model.cost.cacheRead). */
  cacheReadPricePerMTok?: number;
}

/**
 * Pure predicate over a parsed ~/.pi/agent/auth.json: does the Anthropic entry
 * authenticate with anything other than the plain env-indirected API key? Such
 * sessions live in a different cache namespace than a ping sent with
 * ANTHROPIC_API_KEY would reach.
 */
export function isNonApiKeyAnthropicAuth(parsedAuth: unknown): boolean {
  if (!isDict(parsedAuth)) return false;
  const entry = parsedAuth.anthropic;
  if (entry === undefined || entry === null) return false; // env-key auth: same key the keepalive uses
  if (!isDict(entry)) return true;
  return entry.type !== "api_key" || (typeof entry.key === "string" && entry.key !== "$ANTHROPIC_API_KEY");
}

/** Pings only make sense when they land in the same cache namespace the session reads. */
export function isPingableRoute(route: RequestRoute | undefined): boolean {
  if (!route) return false;
  if (route.provider !== "anthropic") return false;
  if (route.nonApiKeyAuth) return false;
  if (route.baseUrl && !String(route.baseUrl).startsWith(ANTHROPIC_BASE_URL)) return false;
  return true;
}

function collectCacheMarkers(payload: Dict): Array<{ ttl?: unknown }> {
  const markers: Array<{ ttl?: unknown }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isDict(value)) return;
    if (isDict(value.cache_control)) {
      markers.push({ ttl: value.cache_control.ttl });
    }
    for (const key of ["messages", "content", "system", "tools"]) {
      if (key in value) visit(value[key]);
    }
  };
  visit(payload);
  return markers;
}

export class CacheKeepalive {
  private lastPayload?: Dict;
  private lastActivityAt = 0;
  private lastPromptTokens = 0;
  private gapPings = 0;
  private daySpendUsd = 0;
  private dayPings = 0;
  private dayKey = "";
  private lastPingOk: boolean | undefined;
  private readonly inFlightTools = new Set<string>();
  private pingInFlight = false;

  constructor(private readonly deps: KeepaliveDeps) {}

  private lastReadPricePerMTok: number | undefined;

  /** A real provider request went out: re-anchor the gap and capture the payload. */
  noteProviderRequest(payload: unknown, route?: RequestRoute): void {
    this.lastActivityAt = this.deps.now();
    this.gapPings = 0;
    this.lastPayload = isPingableRoute(route) && isPingablePayload(payload) ? (payload as Dict) : undefined;
    this.lastReadPricePerMTok =
      typeof route?.cacheReadPricePerMTok === "number" && route.cacheReadPricePerMTok > 0 ? route.cacheReadPricePerMTok : undefined;
  }

  /** Latest turn's total prompt tokens (input + cacheRead + cacheWrite). */
  noteTurnUsage(promptTokens: number): void {
    if (Number.isFinite(promptTokens) && promptTokens >= 0) {
      this.lastPromptTokens = promptTokens;
    }
  }

  toolStart(id: string): void {
    this.inFlightTools.add(id);
  }

  toolEnd(id: string): void {
    this.inFlightTools.delete(id);
  }

  shutdown(): void {
    this.inFlightTools.clear();
    this.lastPayload = undefined;
    // A new session in the same process must re-earn the activation floor;
    // stale prompt sizes would misprice pings and defeat the floor.
    this.lastPromptTokens = 0;
  }

  /** Diagnostic surface consumed by the /cache report footer line and tests. */
  get state(): { inFlight: number; gapPings: number; dayPings: number; daySpendUsd: number; lastPingOk: boolean | undefined } {
    return {
      inFlight: this.inFlightTools.size,
      gapPings: this.gapPings,
      dayPings: this.dayPings,
      daySpendUsd: this.daySpendUsd,
      lastPingOk: this.lastPingOk,
    };
  }

  /**
   * Called on a coarse interval (and safe to call any time). Sends at most one
   * ping when every structural condition holds. Returns what happened so the
   * wiring layer and tests can observe decisions without reaching inside.
   */
  async tick(): Promise<"pinged" | "skipped"> {
    const now = this.deps.now();
    this.rollDay(now);
    const apiKey = this.deps.env.ANTHROPIC_API_KEY;
    const estimate = this.estimatePingCostUsd();
    if (
      this.pingInFlight ||
      this.inFlightTools.size === 0 || // idle at the prompt: never ping
      !this.lastPayload ||
      !apiKey ||
      this.lastPromptTokens < MIN_PROMPT_TOKENS ||
      now - this.lastActivityAt < PING_AFTER_IDLE_MS ||
      this.gapPings >= PER_GAP_MAX_PINGS ||
      this.daySpendUsd + estimate > DAILY_BUDGET_USD
    ) {
      return "skipped";
    }

    this.gapPings += 1;
    this.dayPings += 1;
    this.daySpendUsd += estimate;
    this.pingInFlight = true;
    // Snapshot what we ping: a real provider request can land while the fetch
    // is in flight and re-arm lastPayload for a NEW gap — a stale failure must
    // abandon only the gap it belongs to, never the freshly captured one.
    const pinged = this.lastPayload;
    try {
      // Pingable payloads carry no thinking or only the explicit disabled
      // marker (isPingablePayload), replayed unchanged — the only deltas vs the
      // cached request are max_tokens/stream, neither of which is hashed into
      // the cache prefix, so this is a pure identical-prefix read.
      const body: Dict = { ...pinged, max_tokens: 1, stream: false };
      const response = await this.deps.fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(PING_TIMEOUT_MS) : undefined,
      });
      this.lastPingOk = response.ok;
      if (response.ok) {
        // Only a confirmed read refreshes the TTL clock.
        this.lastActivityAt = this.deps.now();
      } else if (this.lastPayload === pinged) {
        // The real cache may expire while we believe otherwise — a later "ping"
        // against a cold cache would be a full-price write, not a cheap read.
        // Abandon the gap; the next real request pays the normal rewrite.
        this.lastPayload = undefined;
      }
    } catch {
      // Keepalive is best-effort; a failed ping must never disturb the session.
      this.lastPingOk = false;
      if (this.lastPayload === pinged) this.lastPayload = undefined;
    } finally {
      this.pingInFlight = false;
    }
    return "pinged";
  }

  private estimatePingCostUsd(): number {
    if (this.lastReadPricePerMTok !== undefined) {
      return (this.lastPromptTokens / 1_000_000) * this.lastReadPricePerMTok;
    }
    const model = typeof this.lastPayload?.model === "string" ? this.lastPayload.model : "";
    const priceEntry = READ_PRICE_PER_MTOK.find(([needle]) => model.toLowerCase().includes(needle));
    const price = priceEntry ? priceEntry[1] : DEFAULT_READ_PRICE_PER_MTOK;
    return (this.lastPromptTokens / 1_000_000) * price;
  }

  private rollDay(now: number): void {
    const key = new Date(now).toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.daySpendUsd = 0;
      this.dayPings = 0;
    }
  }
}
