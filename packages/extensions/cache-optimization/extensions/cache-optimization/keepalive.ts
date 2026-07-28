// keepalive.ts — runaway-proof Anthropic prompt-cache TTL keepalive.
//
// Anthropic's 5-minute cache TTL refreshes free on every read. When the agent
// loop stalls past the TTL mid-turn (slow builds, background work that will
// wake the agent later), the next request rewrites the whole prefix at 1.25x
// input price (~$5-6 at 500k context). A tiny re-read of the same prefix costs
// 0.1x — ~12.5x cheaper — and resets the clock.
//
// Runaway is prevented structurally, not by tuning:
//   1. Pings fire only while at least one foreground tool execution is in
//      flight OR while the agent is idle with pending background work that is
//      expected to wake a later request. Idle at the prompt with no pending
//      work (user walked away) => zero pings, ever.
//   2. Per-gap budget: at most PER_GAP_MAX_PINGS pings between real provider
//      requests (~0.5x the rewrite cost the pings try to prevent), then silence.
//   3. Daily dollar cap across the whole session as a backstop for bugs.
//   4. Activation floor: below MIN_PROMPT_TOKENS the rewrite is cheap enough
//      that keepalive isn't worth the moving parts.
//   5. Anthropic 5m-TTL only: payloads with 1h markers (PI_CACHE_RETENTION=long)
//      or non-Anthropic payloads are never pinged — the 1h TTL already covers
//      these gaps, and other providers have no marker-based TTL to keep alive.
//   6. Thinking safety is payload-specific. No-thinking and
//      `thinking: { type: "disabled" }` payloads use the existing cheap
//      non-streaming 1-token read. Modern adaptive-thinking payloads use exact
//      captured-provider-payload replay with only max_tokens/stream changed,
//      then prove success from Anthropic `message_start` cache-read usage.
//      Budget-style `thinking: { type: "enabled", budget_tokens }` stays
//      excluded because max_tokens=1 is invalid and changing the budget changes
//      message-cache parameters.
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
 * Background work without a wake expires before it can run past the normal
 * per-gap ping horizon. This fail-safe biases toward fewer pings: expiry only
 * removes pending work, never extends it.
 */
export const BACKGROUND_WORK_EXPIRE_MS = (PER_GAP_MAX_PINGS + 1) * PING_AFTER_IDLE_MS;

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
const ANTHROPIC_MESSAGES_URL = `${ANTHROPIC_BASE_URL}/v1/messages`;
const CACHEABLE_MESSAGE_BLOCK_TYPES = new Set(["text", "image", "tool_result", "tool_use", "document"]);

type Dict = Record<string, unknown>;
export type KeepalivePingKind = "standard" | "adaptive";

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface KeepaliveFetchResponse {
  ok: boolean;
  status?: number;
  body?: ReadableStream<Uint8Array> | null;
  text?(): Promise<string>;
}

export interface KeepaliveDeps {
  now(): number;
  fetch(url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }): Promise<KeepaliveFetchResponse>;
  env: Record<string, string | undefined>;
  /**
   * Called once per billed ping with provider-reported usage priced from pi's model
   * rates. A keepalive ping is a real Anthropic request that no session records, so
   * without this its spend is invisible to every cost surface.
   *
   * "Billed" is the test, not "succeeded": a ping that reached the provider without
   * proving a cache read still cost money and is still reported. Only a ping that never
   * reached the provider, was skipped, or reported no usage reports nothing.
   */
  onSpend?: ((record: KeepaliveSpendRecord) => void) | undefined;
}

/** One billed keepalive ping, ready to persist as a durable cost record. */
export interface KeepaliveSpendRecord {
  /** Stable id for this ping, so a replayed record cannot be counted twice. */
  recordId: string;
  /** Provider/model the ping was billed against, used as the cost bucket. */
  key: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  };
}

/** Provider-reported usage for one ping, as far as the response revealed it. */
interface PingUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Abort a hung ping so pingInFlight can never wedge the keepalive. */
const PING_TIMEOUT_MS = 30_000;

/**
 * Classify a captured Anthropic Messages payload by the keepalive strategy that
 * can replay it safely. The body itself is treated as opaque: a refresh may only
 * change max_tokens/stream, so future provider fields ride through unchanged.
 */
export function classifyPingablePayload(payload: unknown): KeepalivePingKind | undefined {
  if (!isDict(payload) || !Array.isArray(payload.messages)) return undefined;
  if (typeof payload.model !== "string" || !/claude/i.test(payload.model)) return undefined;
  const markerScan = collectCacheMarkers(payload);
  if (markerScan.invalidMarker) return undefined;
  if (markerScan.markers.length === 0) return undefined; // caching not enabled on this request
  if (!markerScan.markers.every(isFiveMinuteEphemeralMarker)) return undefined;

  const thinking = payload.thinking;
  if (thinking === undefined) return "standard";
  if (!isDict(thinking)) return undefined;
  if (thinking.type === "disabled") return "standard";
  if (thinking.type === "adaptive") return "adaptive";
  return undefined;
}

export function isPingablePayload(payload: unknown): boolean {
  return classifyPingablePayload(payload) !== undefined;
}

export function isAnthropicOAuthToken(value: unknown): boolean {
  return typeof value === "string" && value.includes("sk-ant-oat");
}

/** Route metadata for the request that produced a captured payload. */
export interface RequestRoute {
  /** Pi provider id, e.g. "anthropic" (not bedrock/vertex/proxies). */
  provider?: string;
  /** Pi provider API adapter; keepalive only matches Anthropic Messages requests. */
  api?: string;
  /** Model baseUrl override; undefined/default means api.anthropic.com. */
  baseUrl?: string;
  /** True when the session authenticates to Anthropic with something other than a plain API key (e.g. OAuth). */
  nonApiKeyAuth?: boolean;
  /** Authoritative cache-read $/MTok from pi's model registry (ctx.model.cost.cacheRead). */
  cacheReadPricePerMTok?: number;
  /** Remaining $/MTok rates from the same registry entry, used to price a ping's usage. */
  pricePerMTok?: { input?: number; output?: number; cacheWrite?: number };
  /** provider/id of the model being pinged, used as the cost bucket key. */
  modelKey?: string;
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
  if (entry === undefined || entry === null) return false; // no entry -> Pi falls back to the same process env key the keepalive uses
  // Any configured Anthropic credential wins over process-env fallback in Pi's
  // auth resolution. Even an env-indirected api_key entry can carry a
  // provider-scoped env object, so fail closed unless there is no Anthropic
  // auth entry at all.
  return true;
}

/** Pings only make sense when they land in the same cache namespace the session reads. */
export function isPingableRoute(route: RequestRoute | undefined): boolean {
  if (!route) return false;
  if (route.provider !== "anthropic") return false;
  if (route.api !== "anthropic-messages") return false;
  if (route.nonApiKeyAuth) return false;
  if (route.baseUrl && !isDefaultAnthropicBaseUrl(route.baseUrl)) return false;
  return true;
}

function truthyFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0 && Number.isFinite(value);
  if (typeof value !== "string") return false;
  return /^(true|1|yes|on)$/iu.test(value.trim());
}

function isBackgroundFlagKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return normalized === "runinbackground" || normalized === "runbackground" || normalized === "backgroundwork";
}

/**
 * Generic convention for tools that launch work and return before that work is
 * done. Package names are intentionally irrelevant: any tool carrying a truthy
 * run-in-background-style argument counts.
 */
export function hasBackgroundLaunchFlag(input: unknown, depth = 0): boolean {
  if (depth > 4) return false;
  if (Array.isArray(input)) return input.some((item) => hasBackgroundLaunchFlag(item, depth + 1));
  if (!isDict(input)) return false;
  for (const [key, value] of Object.entries(input)) {
    if (isBackgroundFlagKey(key) && truthyFlag(value)) return true;
    if ((Array.isArray(value) || isDict(value)) && hasBackgroundLaunchFlag(value, depth + 1)) return true;
  }
  return false;
}

function isDefaultAnthropicBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.origin === ANTHROPIC_BASE_URL && (url.pathname === "" || url.pathname === "/") && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function collectCacheMarkers(payload: Dict): { markers: Array<{ type?: unknown; ttl?: unknown }>; invalidMarker: boolean } {
  const markers: Array<{ type?: unknown; ttl?: unknown }> = [];
  let invalidMarker = false;
  const recordMarker = (value: Dict, cacheable: boolean): void => {
    if (!isDict(value.cache_control)) return;
    if (!cacheable) {
      invalidMarker = true;
      return;
    }
    markers.push({ type: value.cache_control.type, ttl: value.cache_control.ttl });
  };

  const system = payload.system;
  if (Array.isArray(system)) {
    for (const block of system) {
      if (isDict(block)) recordMarker(block, block.type === "text");
    }
  }
  const tools = payload.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (isDict(tool)) recordMarker(tool, true);
    }
  }
  const messages = payload.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!isDict(message)) continue;
      const content = message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (isDict(block)) recordMarker(block, typeof block.type === "string" && CACHEABLE_MESSAGE_BLOCK_TYPES.has(block.type));
      }
    }
  }
  if (countCacheControlKeys(payload) !== markers.length) invalidMarker = true;
  return { markers, invalidMarker };
}

function countCacheControlKeys(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countCacheControlKeys(item), 0);
  if (!isDict(value)) return 0;
  let count = 0;
  for (const [key, child] of Object.entries(value)) {
    if (key === "cache_control") {
      count += 1;
    } else if (key !== "input_schema") {
      // Tool input_schema is user JSON Schema; a parameter named
      // `cache_control` is not an Anthropic cache marker.
      count += countCacheControlKeys(child);
    }
  }
  return count;
}

function isFiveMinuteEphemeralMarker(marker: { type?: unknown; ttl?: unknown }): boolean {
  return marker.type === "ephemeral" && (marker.ttl === undefined || marker.ttl === "5m");
}

interface CapturedPayload {
  payload: Dict;
  kind: KeepalivePingKind;
}

interface AnthropicUsage {
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number | null;
  input_tokens?: number;
  output_tokens?: number;
}

/** Provider usage field names mapped to the neutral shape cost records use. */
function fromAnthropicUsage(usage: AnthropicUsage): PingUsage {
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
  };
}

export class CacheKeepalive {
  private lastCapture?: CapturedPayload;
  private lastActivityAt = 0;
  private lastPromptTokens = 0;
  private gapPings = 0;
  private daySpendUsd = 0;
  private dayPings = 0;
  private dayKey = "";
  private lastPingOk: boolean | undefined;
  private readonly inFlightTools = new Set<string>();
  private readonly backgroundWork = new Map<string, { startedAt: number; wakeArmed: boolean }>();
  private pingInFlight = false;

  constructor(private readonly deps: KeepaliveDeps) {}

  /**
   * Install the spend reporter after construction. Lets the wiring layer attach its
   * record-writing callback to a keepalive it did not build — so a test can fake the
   * network while the production reporting path still runs.
   */
  setSpendReporter(onSpend: (record: KeepaliveSpendRecord) => void): void {
    this.deps.onSpend = onSpend;
  }

  private lastReadPricePerMTok: number | undefined;
  private lastPrices: { input?: number; output?: number; cacheWrite?: number } | undefined;
  private lastModelKey: string | undefined;
  private pingSequence = 0;

  /** A real provider request went out: re-anchor the gap and capture the payload. */
  noteProviderRequest(payload: unknown, route?: RequestRoute): void {
    this.lastActivityAt = this.deps.now();
    this.gapPings = 0;
    this.completeOneBackgroundWake();
    this.lastCapture = undefined;
    const kind = isPingableRoute(route) ? classifyPingablePayload(payload) : undefined;
    this.lastCapture = kind && isDict(payload) ? { payload, kind } : undefined;
    this.lastReadPricePerMTok =
      typeof route?.cacheReadPricePerMTok === "number" && route.cacheReadPricePerMTok > 0 ? route.cacheReadPricePerMTok : undefined;
    this.lastPrices = route?.pricePerMTok;
    this.lastModelKey = route?.modelKey;
  }

  /** Explicitly abandon the current captured provider payload after a fail-closed wiring error. */
  clearCapture(): void {
    this.lastCapture = undefined;
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

  /** A tool launched background work by generic convention. Idempotent per tool call id. */
  backgroundWorkStart(id: string): void {
    if (!this.backgroundWork.has(id)) {
      this.backgroundWork.set(id, { startedAt: this.deps.now(), wakeArmed: false });
    }
  }

  /** The current agent turn ended; launched background work may now wake a later request. */
  agentEnd(): void {
    const now = this.deps.now();
    for (const work of this.backgroundWork.values()) {
      if (!work.wakeArmed) {
        work.startedAt = now;
        work.wakeArmed = true;
      }
    }
  }

  /** Branch/tree navigation rewrites the prefix; any pending work belongs to the old branch. */
  branchSwitch(): void {
    this.inFlightTools.clear();
    this.backgroundWork.clear();
    this.lastCapture = undefined;
  }

  shutdown(): void {
    this.inFlightTools.clear();
    this.backgroundWork.clear();
    this.lastCapture = undefined;
    // A new session in the same process must re-earn the activation floor;
    // stale prompt sizes would misprice pings and defeat the floor.
    this.lastPromptTokens = 0;
  }

  /** Diagnostic surface consumed by the /cache report footer line and tests. */
  get state(): {
    inFlight: number;
    pendingBackground: number;
    armedBackground: number;
    gapPings: number;
    dayPings: number;
    daySpendUsd: number;
    lastPingOk: boolean | undefined;
  } {
    this.expireBackgroundWork(this.deps.now());
    return {
      inFlight: this.inFlightTools.size,
      pendingBackground: this.backgroundWork.size,
      armedBackground: this.armedBackgroundCount(),
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
    this.expireBackgroundWork(now);
    const apiKey = this.deps.env.ANTHROPIC_API_KEY;
    const estimate = this.estimatePingCostUsd();
    if (
      this.pingInFlight ||
      this.armedWorkCount() === 0 || // idle at the prompt with no work: never ping
      !this.lastCapture ||
      !apiKey ||
      isAnthropicOAuthToken(apiKey) ||
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
    // is in flight and re-arm lastCapture for a NEW gap — a stale failure must
    // abandon only the gap it belongs to, never the freshly captured one.
    const pinged = this.lastCapture;
    // Snapshot the prices for the same reason: a request landing mid-flight would
    // otherwise bill this ping at the newly-active model's rates.
    const pricing = { read: this.lastReadPricePerMTok, prices: this.lastPrices, modelKey: this.lastModelKey };
    try {
      const outcome = await this.pingCapturedPayload(pinged, apiKey);
      const success = outcome.ok;
      this.lastPingOk = success;
      // A ping that reached the provider was billed whether or not it proved a cache
      // read, so it is recorded either way; only a throw or a non-OK response is free.
      this.reportSpend(outcome.usage, pricing);
      if (success) {
        // Only a confirmed cache read refreshes the TTL clock.
        this.lastActivityAt = this.deps.now();
      } else if (this.lastCapture === pinged) {
        // The real cache may expire while we believe otherwise — a later "ping"
        // against a cold cache would be a full-price write, not a cheap read.
        // Abandon the gap; the next real request pays the normal rewrite.
        this.lastCapture = undefined;
      }
    } catch {
      // Keepalive is best-effort; a failed ping must never disturb the session.
      this.lastPingOk = false;
      if (this.lastCapture === pinged) this.lastCapture = undefined;
    } finally {
      this.pingInFlight = false;
    }
    return "pinged";
  }

  private async pingCapturedPayload(captured: CapturedPayload, apiKey: string): Promise<{ ok: boolean; usage?: PingUsage }> {
    if (captured.kind === "adaptive") return this.pingAdaptivePayload(captured.payload, apiKey);
    return this.pingStandardPayload(captured.payload, apiKey);
  }

  private async pingStandardPayload(payload: Dict, apiKey: string): Promise<{ ok: boolean; usage?: PingUsage }> {
    // Standard payloads carry no thinking or only the explicit disabled marker,
    // replayed unchanged — the only deltas vs the cached request are
    // max_tokens/stream, neither of which is hashed into the cache prefix.
    const body: Dict = { ...payload, max_tokens: 1, stream: false };
    const response = await this.deps.fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: directAnthropicHeaders(apiKey),
      body: JSON.stringify(body),
      signal: timeoutSignal(),
    });
    if (!response.ok) return { ok: false };
    // The non-streaming reply carries usage in its body; read it so the ping's real
    // spend is recorded rather than estimated. An unreadable body still pinged.
    const usage = await readNonStreamingUsage(response);
    return usage ? { ok: true, usage } : { ok: true };
  }

  private async pingAdaptivePayload(payload: Dict, apiKey: string): Promise<{ ok: boolean; usage?: PingUsage }> {
    // Adaptive-thinking refreshes must preserve the exact captured provider body
    // and prove that the request read the existing cache. A 200 that writes a new
    // entry is not a keepalive; it is the cold-cache rewrite we are avoiding.
    const body: Dict = { ...payload, max_tokens: 1, stream: true };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    try {
      const response = await this.deps.fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: directAnthropicHeaders(apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false };
      const usage = await readMessageStartUsage(response, () => controller.abort());
      const ok =
        usage.cache_read_input_tokens !== undefined &&
        usage.cache_read_input_tokens > 0 &&
        (usage.cache_creation_input_tokens === 0 || usage.cache_creation_input_tokens === null);
      return { ok, usage: fromAnthropicUsage(usage) };

    } finally {
      clearTimeout(timeout);
    }
  }

  private armedWorkCount(): number {
    return this.inFlightTools.size + this.armedBackgroundCount();
  }

  private armedBackgroundCount(): number {
    let count = 0;
    for (const work of this.backgroundWork.values()) {
      if (work.wakeArmed) count += 1;
    }
    return count;
  }

  private completeOneBackgroundWake(): void {
    for (const [id, work] of this.backgroundWork.entries()) {
      if (work.wakeArmed) {
        this.backgroundWork.delete(id);
        return;
      }
    }
  }

  private expireBackgroundWork(now: number): void {
    for (const [id, work] of this.backgroundWork.entries()) {
      if (now - work.startedAt >= BACKGROUND_WORK_EXPIRE_MS) this.backgroundWork.delete(id);
    }
  }

  /**
   * Price provider-reported ping usage with pi's model rates and hand it to the
   * wiring layer as a durable cost record. Silent when the ping reported no usage.
   */
  private reportSpend(
    usage: PingUsage | undefined,
    pricing: { read?: number; prices?: { input?: number; output?: number; cacheWrite?: number }; modelKey?: string },
  ): void {
    if (!this.deps.onSpend || !usage) return;
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    if (input + output + cacheRead + cacheWrite === 0) return;
    const perMTok = (tokens: number, price: number | undefined) => (price && price > 0 ? (tokens / 1_000_000) * price : 0);
    const cost = {
      input: perMTok(input, pricing.prices?.input),
      output: perMTok(output, pricing.prices?.output),
      cacheRead: perMTok(cacheRead, pricing.read),
      cacheWrite: perMTok(cacheWrite, pricing.prices?.cacheWrite),
    };
    this.pingSequence += 1;
    this.deps.onSpend({
      recordId: `keepalive-${this.dayKey}-${this.pingSequence}-${Math.round(this.deps.now())}`,
      key: pricing.modelKey ? `${pricing.modelKey} (cache keepalive)` : "cache keepalive",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
      },
    });
  }

  private estimatePingCostUsd(): number {
    if (this.lastReadPricePerMTok !== undefined) {
      return (this.lastPromptTokens / 1_000_000) * this.lastReadPricePerMTok;
    }
    const model = typeof this.lastCapture?.payload.model === "string" ? this.lastCapture.payload.model : "";
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

function directAnthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(PING_TIMEOUT_MS) : undefined;
}

/**
 * Usage from a non-streaming Anthropic reply. Best-effort: a body that cannot be
 * read or parsed simply yields no usage, and the ping is then recorded as unpriced
 * rather than failing.
 */
async function readNonStreamingUsage(response: KeepaliveFetchResponse): Promise<PingUsage | undefined> {
  if (!response.text) return undefined;
  try {
    const parsed = safeJsonParse(await response.text());
    const usage = isDict(parsed) && isDict(parsed.usage) ? parsed.usage : undefined;
    if (!usage) return undefined;
    return fromAnthropicUsage({
      cache_read_input_tokens: numberValue(usage.cache_read_input_tokens),
      cache_creation_input_tokens: numberValue(usage.cache_creation_input_tokens),
      input_tokens: numberValue(usage.input_tokens),
      output_tokens: numberValue(usage.output_tokens),
    });
  } catch {
    return undefined;
  }
}

async function readMessageStartUsage(response: KeepaliveFetchResponse, abort: () => void): Promise<AnthropicUsage> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return {};
      buffer += decoder.decode(value, { stream: true });
      const parsed = consumeSseEvents(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.event === "error") return {};
        const data = safeJsonParse(event.data);
        if (isDict(data) && data.type === "message_start") {
          const message = data.message;
          const usage = isDict(message) && isDict(message.usage) ? message.usage : undefined;
          await reader.cancel().catch(() => undefined);
          abort();
          return isDict(usage)
            ? {
                cache_read_input_tokens: numberValue(usage.cache_read_input_tokens),
                cache_creation_input_tokens: usage.cache_creation_input_tokens === null ? null : numberValue(usage.cache_creation_input_tokens),
                input_tokens: numberValue(usage.input_tokens),
                output_tokens: numberValue(usage.output_tokens),
              }
            : {};
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function consumeSseEvents(buffer: string): { events: Array<{ event: string; data: string }>; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const chunks = normalized.split("\n\n");
  const rest = chunks.pop() ?? "";
  const events: Array<{ event: string; data: string }> = [];
  for (const chunk of chunks) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
    }
    if (dataLines.length > 0) events.push({ event, data: dataLines.join("\n") });
  }
  return { events, rest };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
