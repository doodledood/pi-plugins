import assert from "node:assert/strict";
import test from "node:test";
import {
  CacheKeepalive,
  DAILY_BUDGET_USD,
  isNonApiKeyAnthropicAuth,
  isPingablePayload,
  isPingableRoute,
  MIN_PROMPT_TOKENS,
  PER_GAP_MAX_PINGS,
  PING_AFTER_IDLE_MS,
  type KeepaliveDeps,
  type RequestRoute,
} from "./keepalive.ts";

const CC = { type: "ephemeral" } as const;

const DIRECT_ROUTE: RequestRoute = { provider: "anthropic" };

function anthropicPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    model: "claude-fable-5",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [{ name: "t", input_schema: {}, cache_control: { ...CC } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { ...CC } }] }],
    max_tokens: 512,
    ...overrides,
  };
}

interface Fixture {
  keepalive: CacheKeepalive;
  clock: { now: number };
  requests: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }>;
  env: Record<string, string | undefined>;
}

function createFixture(env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-test" }): Fixture {
  const clock = { now: 1_700_000_000_000 };
  const requests: Fixture["requests"] = [];
  const deps: KeepaliveDeps = {
    now: () => clock.now,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return { ok: true };
    },
    env,
  };
  return { keepalive: new CacheKeepalive(deps), clock, requests, env };
}

/** Arm the keepalive into a pingable state: big prompt, tool in flight, stale cache. */
function arm(f: Fixture): void {
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.toolStart("tool-1");
  f.clock.now += PING_AFTER_IDLE_MS + 1;
}

test("keepalive: pings only when armed — in-flight tool, stale cache, big prompt, key present", async () => {
  const f = createFixture();
  arm(f);
  assert.equal(await f.keepalive.tick(), "pinged");
  assert.equal(f.requests.length, 1);
});

test("keepalive: never pings while idle at the prompt (no tool in flight)", async () => {
  const f = createFixture();
  arm(f);
  f.keepalive.toolEnd("tool-1");
  assert.equal(await f.keepalive.tick(), "skipped");
  assert.equal(f.requests.length, 0);
});

test("keepalive: respects the cadence — no ping until the cache is stale", async () => {
  const f = createFixture();
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.toolStart("tool-1");
  f.clock.now += PING_AFTER_IDLE_MS - 1_000;
  assert.equal(await f.keepalive.tick(), "skipped");
  f.clock.now += 2_000;
  assert.equal(await f.keepalive.tick(), "pinged");
});

test("keepalive: activation floor — small prompts are never pinged", async () => {
  const f = createFixture();
  arm(f);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS - 1);
  assert.equal(await f.keepalive.tick(), "skipped");
});

test("keepalive: no API key, no ping", async () => {
  const f = createFixture({});
  arm(f);
  assert.equal(await f.keepalive.tick(), "skipped");
  assert.equal(f.requests.length, 0);
});

test("keepalive: per-gap budget stops pings after the cap, and a real request resets the gap", async () => {
  const f = createFixture();
  arm(f);
  for (let i = 0; i < PER_GAP_MAX_PINGS; i++) {
    assert.equal(await f.keepalive.tick(), "pinged", `ping ${i + 1} within budget`);
    f.clock.now += PING_AFTER_IDLE_MS + 1;
  }
  assert.equal(await f.keepalive.tick(), "skipped", "per-gap cap reached");
  assert.equal(f.requests.length, PER_GAP_MAX_PINGS);

  // A real provider request re-anchors the gap and re-arms the budget.
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "pinged");
});

test("keepalive: daily dollar cap is a global backstop and day counters reset together", async () => {
  const f = createFixture();
  // fable read price $1/MTok -> 2M-token prompt estimates $2.00/ping; budget $3.00 allows 1 ping.
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(2_000_000);
  f.keepalive.toolStart("tool-1");
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "pinged");
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "skipped", "second $2.00 ping would exceed the $3.00 daily budget");
  assert.ok(DAILY_BUDGET_USD < 4, "test premise: budget below two 2M-token pings");
  assert.equal(f.keepalive.state.dayPings, 1);

  // Next day both spend and ping counters reset.
  f.clock.now += 24 * 60 * 60_000;
  assert.equal(await f.keepalive.tick(), "pinged");
  assert.equal(f.keepalive.state.dayPings, 1, "dayPings resets with the day");
});

test("keepalive: only 5m-TTL, thinking-off Anthropic payloads are pingable", () => {
  assert.equal(isPingablePayload(anthropicPayload()), true, "default 5m markers, no thinking");
  assert.equal(
    isPingablePayload(anthropicPayload({ thinking: { type: "enabled", budget_tokens: 4096 } })),
    false,
    "thinking-enabled payloads have no cheap identical-prefix read — never ping",
  );
  assert.equal(
    isPingablePayload(anthropicPayload({ thinking: { type: "disabled" } })),
    true,
    "pi sends an explicit disabled marker on reasoning models with thinking off — still pingable",
  );
  assert.equal(isPingablePayload(anthropicPayload({ model: "gpt-5.5" })), false, "non-claude model");
  const longTtl = anthropicPayload();
  (longTtl.system as Array<Record<string, unknown>>)[0]!.cache_control = { type: "ephemeral", ttl: "1h" };
  assert.equal(isPingablePayload(longTtl), false, "1h retention handles gaps upstream — never ping");
  const noMarkers = anthropicPayload({ system: [{ type: "text", text: "sys" }], tools: [], messages: [{ role: "user", content: "hi" }] });
  assert.equal(isPingablePayload(noMarkers), false, "caching not enabled");
  assert.equal(isPingablePayload({ model: "claude-x", input: [] }), false, "not a messages payload");
});

test("keepalive: route-supplied registry pricing overrides the fallback table for budget estimates", async () => {
  const f = createFixture();
  // Registry says $2/MTok read; a 1M-token prompt estimates $2.00/ping, so the
  // $3.00 budget admits exactly one ping (table price would wrongly admit two).
  f.keepalive.noteProviderRequest(anthropicPayload(), { ...DIRECT_ROUTE, cacheReadPricePerMTok: 2.0 });
  f.keepalive.noteTurnUsage(1_000_000);
  f.keepalive.toolStart("tool-1");
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "pinged");
  f.keepalive.noteProviderRequest(anthropicPayload(), { ...DIRECT_ROUTE, cacheReadPricePerMTok: 2.0 });
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "skipped", "registry price ($2/M) exhausts the $3 budget after one ping");
});

test("keepalive: auth.json predicate distinguishes env-indirected API keys from every other identity", () => {
  assert.equal(isNonApiKeyAnthropicAuth(undefined), false, "no auth.json");
  assert.equal(isNonApiKeyAnthropicAuth({}), false, "no anthropic entry -> env-key auth, same key as the ping");
  assert.equal(isNonApiKeyAnthropicAuth({ anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY" } }), false, "env-indirected api key matches the ping identity");
  assert.equal(isNonApiKeyAnthropicAuth({ anthropic: { type: "oauth", access: "tok" } }), true, "OAuth session != ping identity");
  assert.equal(isNonApiKeyAnthropicAuth({ anthropic: { type: "api_key", key: "sk-ant-literal" } }), true, "literal key may differ from env key");
  assert.equal(isNonApiKeyAnthropicAuth({ anthropic: "garbage" }), true, "unrecognized entry shape fails closed");
});

test("keepalive: pings only ride the session's own direct API-key route", async () => {
  assert.equal(isPingableRoute({ provider: "anthropic" }), true, "direct anthropic, default baseUrl, api-key auth");
  assert.equal(isPingableRoute({ provider: "anthropic", baseUrl: "https://api.anthropic.com" }), true);
  assert.equal(isPingableRoute(undefined), false, "unknown route is never pinged");
  assert.equal(isPingableRoute({ provider: "bedrock" }), false, "non-anthropic provider");
  assert.equal(isPingableRoute({ provider: "anthropic", baseUrl: "https://proxy.example.com" }), false, "custom baseUrl = different cache namespace");
  assert.equal(isPingableRoute({ provider: "anthropic", nonApiKeyAuth: true }), false, "OAuth session must not be pinged with the env API key");

  // End to end: an armed keepalive with an OAuth route never pings.
  const f = createFixture();
  f.keepalive.noteProviderRequest(anthropicPayload(), { provider: "anthropic", nonApiKeyAuth: true });
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.toolStart("tool-1");
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "skipped");
  assert.equal(f.requests.length, 0);
});

test("keepalive: 1h-TTL payloads are never pinged even when armed", async () => {
  const f = createFixture();
  const longTtl = anthropicPayload();
  (longTtl.messages as Array<Record<string, unknown>>).forEach((m) => {
    ((m.content as Array<Record<string, unknown>>) ?? []).forEach((b) => (b.cache_control = { type: "ephemeral", ttl: "1h" }));
  });
  (longTtl.system as Array<Record<string, unknown>>)[0]!.cache_control = { type: "ephemeral", ttl: "1h" };
  (longTtl.tools as Array<Record<string, unknown>>)[0]!.cache_control = { type: "ephemeral", ttl: "1h" };
  f.keepalive.noteProviderRequest(longTtl, DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.toolStart("tool-1");
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "skipped");
});

test("keepalive: the ping is a 1-token identical-prefix read to the Anthropic endpoint only", async () => {
  const f = createFixture();
  arm(f);
  await f.keepalive.tick();
  const request = f.requests[0]!;
  assert.match(request.url, /^https:\/\/api\.anthropic\.com\/v1\/messages$/);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-api-key"], "sk-test");
  assert.equal(request.init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(request.init.body);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.stream, false);
  assert.equal(body.thinking, undefined, "pingable payloads never carry thinking");
  assert.equal(body.model, "claude-fable-5", "same prefix re-read");
  // Everything except max_tokens/stream is byte-identical to the captured
  // request — neither field is hashed into the cache prefix.
  const { max_tokens: _mt, stream: _s, ...pingRest } = body;
  const { max_tokens: _omt, ...origRest } = anthropicPayload();
  assert.deepEqual(pingRest, origRest, "identical prefix");
});

test("keepalive: a disabled-thinking marker rides the ping unchanged (byte-identical replay)", async () => {
  const f = createFixture();
  f.keepalive.noteProviderRequest(anthropicPayload({ thinking: { type: "disabled" } }), DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.toolStart("tool-1");
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "pinged", "disabled-thinking payloads must ping (all modern Claude models carry the marker)");
  const body = JSON.parse(f.requests[0]!.init.body);
  assert.deepEqual(body.thinking, { type: "disabled" }, "marker preserved so the prefix stays identical");
});

test("keepalive: shutdown clears in-flight state so no ping can fire afterwards", async () => {
  const f = createFixture();
  arm(f);
  f.keepalive.shutdown();
  assert.equal(await f.keepalive.tick(), "skipped");
  assert.equal(f.requests.length, 0);
});

test("keepalive: shutdown resets the prompt-size floor so a new session cannot ride stale tokens", async () => {
  const f = createFixture();
  arm(f);
  f.keepalive.shutdown();
  // New session in the same process: payload re-armed, tool running, cache
  // stale — but no turn usage recorded yet, so the floor must block pings.
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.keepalive.toolStart("tool-2");
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await f.keepalive.tick(), "skipped", "stale lastPromptTokens must not satisfy the floor");
  assert.equal(f.requests.length, 0);
});

test("keepalive: a failed ping abandons the gap — no cold-cache full-price ping can follow", async () => {
  const clock = { now: 1_700_000_000_000 };
  let calls = 0;
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async () => {
      calls++;
      throw new Error("network down");
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("tool-1");
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged", "attempt made");
  assert.equal(calls, 1);
  assert.equal(keepalive.state.gapPings, 1, "failed attempt still consumes the gap budget");
  assert.equal(keepalive.state.lastPingOk, false, "failure recorded for the /cache status line");

  // After a failure the real cache may be cold; a further "ping" would be a
  // full-price write masquerading as a read. The gap must be abandoned.
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "gap abandoned after failure");
  assert.equal(calls, 1);

  // A new real request re-arms as usual.
  keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged");
});

test("keepalive: a stale ping failure never clobbers a freshly captured payload", async () => {
  const clock = { now: 1_700_000_000_000 };
  let rejectPing: ((err: Error) => void) | undefined;
  let fetchCalls = 0;
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: () => {
      fetchCalls++;
      if (fetchCalls === 1) return new Promise((_resolve, reject) => (rejectPing = reject));
      return Promise.resolve({ ok: true });
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("tool-1");
  clock.now += PING_AFTER_IDLE_MS + 1;
  const pingPromise = keepalive.tick(); // hangs on the deferred fetch

  // While the ping is in flight, the tool finishes and a real request re-arms a NEW gap.
  keepalive.toolEnd("tool-1");
  keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  keepalive.toolStart("tool-2");

  rejectPing!(new Error("stale ping failed"));
  assert.equal(await pingPromise, "pinged");

  // The stale failure must abandon only its own gap — the new gap still pings.
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged", "fresh payload survives a stale ping failure");
});

test("keepalive: a non-ok HTTP response also abandons the gap", async () => {
  const clock = { now: 1_700_000_000_000 };
  let calls = 0;
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async () => {
      calls++;
      return { ok: false };
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });
  keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("tool-1");
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged", "attempt made");
  assert.equal(keepalive.state.lastPingOk, false, "HTTP error recorded");

  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "skipped", "gap abandoned after non-ok response");
  assert.equal(calls, 1, "no cold-cache full-price ping can follow");

  keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged", "fresh real request re-arms");
});
