import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_WORK_EXPIRE_MS,
  CacheKeepalive,
  classifyPingablePayload,
  DAILY_BUDGET_USD,
  hasBackgroundLaunchFlag,
  isAnthropicOAuthToken,
  isNonApiKeyAnthropicAuth,
  isPingablePayload,
  isPingableRoute,
  MIN_PROMPT_TOKENS,
  PER_GAP_MAX_PINGS,
  PING_AFTER_IDLE_MS,
  type KeepaliveDeps,
  type KeepaliveSpendRecord,
  type RequestRoute,
} from "./keepalive.ts";

const CC = { type: "ephemeral" } as const;

const DIRECT_ROUTE: RequestRoute = { provider: "anthropic", api: "anthropic-messages" };

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
  requests: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal } }>;
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

function adaptivePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return anthropicPayload({
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "low" },
    experimental_future_field: { preserve: true },
    ...overrides,
  });
}

function sseResponse(usage: Record<string, unknown>, lineEnding = "\n"): { ok: true; body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  const data = JSON.stringify({ type: "message_start", message: { id: "msg-test", usage } });
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(["event: message_start", `data: ${data}`, ""].join(lineEnding) + lineEnding));
      },
    }),
  };
}

function splitSseResponse(usage: Record<string, unknown>): { ok: true; body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  const data = JSON.stringify({ type: "message_start", message: { id: "msg-test", usage } });
  const chunks = [`event: mes`, `sage_start\ndata: ${data.slice(0, 12)}`, `${data.slice(12)}\n`, `\n`];
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      },
    }),
  };
}

function sseErrorResponse(): { ok: true; body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: error\ndata: {"type":"error","error":{"message":"boom"}}\n\n'));
      },
    }),
  };
}

function emptySseResponse(): { ok: true; body: ReadableStream<Uint8Array> } {
  return {
    ok: true,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
  };
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

test("keepalive: generic background-launch flag arms idle background work", async () => {
  const f = createFixture();
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.backgroundWorkStart("generic-tool-call");
  f.keepalive.agentEnd();
  f.clock.now += PING_AFTER_IDLE_MS + 1;

  assert.equal(await f.keepalive.tick(), "pinged", "no foreground tool is in flight; background work alone arms keepalive");
  assert.equal(f.requests.length, 1);
  assert.equal(f.keepalive.state.armedBackground, 1);
});

test("keepalive: generic background wake bookkeeping disarms pending work", async () => {
  const f = createFixture();
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.backgroundWorkStart("generic-tool-call");
  f.keepalive.agentEnd();
  assert.equal(f.keepalive.state.armedBackground, 1);

  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(f.keepalive.state.pendingBackground, 0, "wake consumed the pending background item");
  assert.equal(await f.keepalive.tick(), "skipped", "pending-zero disarms keepalive");
});

test("keepalive: background expiry only removes work and cannot extend pinging", async () => {
  const f = createFixture();
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.backgroundWorkStart("generic-tool-call");
  f.keepalive.agentEnd();
  f.clock.now += BACKGROUND_WORK_EXPIRE_MS + 1;

  assert.equal(f.keepalive.state.pendingBackground, 0, "expiry drops stale background work");
  assert.equal(await f.keepalive.tick(), "skipped", "expired background work cannot keep pings alive");
  assert.equal(f.requests.length, 0);
});

test("keepalive: later agent turns do not extend already-armed background expiry", async () => {
  const f = createFixture();
  f.keepalive.noteProviderRequest(anthropicPayload(), DIRECT_ROUTE);
  f.keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  f.keepalive.backgroundWorkStart("generic-tool-call");
  f.keepalive.agentEnd();

  f.clock.now += BACKGROUND_WORK_EXPIRE_MS - 1_000;
  f.keepalive.agentEnd(); // unrelated later turn: must not move the original expiry horizon
  f.clock.now += 1_001;

  assert.equal(f.keepalive.state.pendingBackground, 0, "already-armed work expires on its original horizon");
  assert.equal(await f.keepalive.tick(), "skipped");
});

test("keepalive: branch switch clears foreground and background arming", async () => {
  const f = createFixture();
  arm(f);
  f.keepalive.backgroundWorkStart("generic-tool-call");
  f.keepalive.agentEnd();
  f.keepalive.branchSwitch();

  assert.equal(f.keepalive.state.inFlight, 0);
  assert.equal(f.keepalive.state.pendingBackground, 0);
  assert.equal(await f.keepalive.tick(), "skipped");
});

test("keepalive: background-launch flag detection is package-agnostic", () => {
  assert.equal(hasBackgroundLaunchFlag({ run_in_background: true }), true);
  assert.equal(hasBackgroundLaunchFlag({ options: { runInBackground: "yes" } }), true);
  assert.equal(hasBackgroundLaunchFlag({ background_work: 1 }), true);
  assert.equal(hasBackgroundLaunchFlag({ run_in_background: false }), false);
  assert.equal(hasBackgroundLaunchFlag({ background: true }), false, "plain background is too broad and not treated as a launch convention");
  assert.equal(hasBackgroundLaunchFlag({ unrelated: { nested: true } }), false);
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

test("keepalive: no plain API key, no ping", async () => {
  const noKey = createFixture({});
  arm(noKey);
  assert.equal(await noKey.keepalive.tick(), "skipped");
  assert.equal(noKey.requests.length, 0);

  const oauthKey = createFixture({ ANTHROPIC_API_KEY: "sk-ant-oat-test" });
  arm(oauthKey);
  assert.equal(await oauthKey.keepalive.tick(), "skipped", "OAuth tokens in ANTHROPIC_API_KEY are not plain API-key auth");
  assert.equal(oauthKey.requests.length, 0);
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

test("keepalive: classifies only 5m direct Anthropic payload shapes that have a safe refresh strategy", () => {
  assert.equal(classifyPingablePayload(anthropicPayload()), "standard", "default 5m markers, no thinking");
  assert.equal(
    classifyPingablePayload(anthropicPayload({ thinking: { type: "disabled" } })),
    "standard",
    "pi sends an explicit disabled marker on reasoning models with thinking off — still pingable",
  );
  assert.equal(classifyPingablePayload(adaptivePayload()), "adaptive", "adaptive thinking uses the streaming usage-proven strategy");
  assert.equal(isPingablePayload(adaptivePayload()), true);
  assert.equal(
    classifyPingablePayload(anthropicPayload({ thinking: { type: "enabled", budget_tokens: 4096 } })),
    undefined,
    "budget-style thinking is invalid with max_tokens=1 and must stay excluded",
  );
  assert.equal(classifyPingablePayload(anthropicPayload({ thinking: { type: "adaptive", budget_tokens: 4096 } })), "adaptive", "unknown adaptive fields are preserved opaquely");
  assert.equal(classifyPingablePayload(anthropicPayload({ thinking: "adaptive" })), undefined, "unknown thinking shape fails closed");
  assert.equal(classifyPingablePayload(anthropicPayload({ model: "gpt-5.5" })), undefined, "GPT/OpenAI models never enter Anthropic keepalive");
  const longTtl = anthropicPayload();
  (longTtl.system as Array<Record<string, unknown>>)[0]!.cache_control = { type: "ephemeral", ttl: "1h" };
  assert.equal(classifyPingablePayload(longTtl), undefined, "1h retention handles gaps upstream — never ping");
  const unknownTtl = anthropicPayload();
  (unknownTtl.system as Array<Record<string, unknown>>)[0]!.cache_control = { type: "ephemeral", ttl: "30m" };
  assert.equal(classifyPingablePayload(unknownTtl), undefined, "unknown TTL fails closed");
  const missingType = anthropicPayload();
  (missingType.system as Array<Record<string, unknown>>)[0]!.cache_control = { ttl: "5m" };
  assert.equal(classifyPingablePayload(missingType), undefined, "unknown cache marker type fails closed");
  const noMarkers = anthropicPayload({ system: [{ type: "text", text: "sys" }], tools: [], messages: [{ role: "user", content: "hi" }] });
  assert.equal(classifyPingablePayload(noMarkers), undefined, "caching not enabled");
  assert.equal(
    classifyPingablePayload(
      anthropicPayload({
        system: [],
        tools: [],
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private", cache_control: { ...CC } }] }],
      }),
    ),
    undefined,
    "thinking blocks cannot carry cache_control markers",
  );
  assert.equal(
    classifyPingablePayload(
      anthropicPayload({
        system: [],
        tools: [],
        messages: [{ role: "user", content: [{ type: "future_block", text: "hi", cache_control: { ...CC } }] }],
      }),
    ),
    undefined,
    "unknown content-block markers fail closed",
  );
  assert.equal(
    classifyPingablePayload(anthropicPayload({ some_future_field: { cache_control: { type: "ephemeral", ttl: "1h" } } })),
    undefined,
    "cache_control markers outside known cacheable positions fail closed",
  );
  assert.equal(classifyPingablePayload(anthropicPayload({ some_future_field: { cache_control: "ephemeral" } })), undefined, "non-object cache_control shapes fail closed");
  assert.equal(
    classifyPingablePayload(
      anthropicPayload({
        tools: [{ name: "t", input_schema: { type: "object", properties: { cache_control: { type: "string" } } }, cache_control: { ...CC } }],
      }),
    ),
    "standard",
    "tool schema properties named cache_control are not provider cache markers",
  );
  assert.equal(classifyPingablePayload({ model: "claude-x", input: [] }), undefined, "not a messages payload");
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

test("keepalive: auth.json predicate permits only pure env fallback for Anthropic", () => {
  assert.equal(isNonApiKeyAnthropicAuth(undefined), false, "no auth.json");
  assert.equal(isNonApiKeyAnthropicAuth({}), false, "no anthropic entry -> process env-key fallback, same key as the ping");
  assert.equal(
    isNonApiKeyAnthropicAuth({ anthropic: { type: "api_key", key: "$ANTHROPIC_API_KEY" } }),
    true,
    "any auth.json Anthropic entry wins over fallback and may carry provider-scoped env, so fail closed",
  );
  assert.equal(isNonApiKeyAnthropicAuth({ anthropic: { type: "oauth", access: "tok" } }), true, "OAuth session != ping identity");
  assert.equal(isNonApiKeyAnthropicAuth({ anthropic: { type: "api_key", key: "sk-ant-literal" } }), true, "literal key may differ from env key");
  assert.equal(isNonApiKeyAnthropicAuth({ anthropic: "garbage" }), true, "unrecognized entry shape fails closed");
  assert.equal(isAnthropicOAuthToken("sk-ant-oat-test"), true, "Anthropic OAuth token marker");
  assert.equal(isAnthropicOAuthToken("sk-ant-api03-test"), false, "plain API key marker");
});

test("keepalive: pings only ride the session's own direct API-key route", async () => {
  assert.equal(isPingableRoute({ provider: "anthropic", api: "anthropic-messages" }), true, "direct Anthropic Messages, default baseUrl, api-key auth");
  assert.equal(isPingableRoute({ provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }), true);
  assert.equal(isPingableRoute({ provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/" }), true);
  assert.equal(isPingableRoute({ provider: "anthropic" }), false, "unknown provider API fails closed");
  assert.equal(isPingableRoute({ provider: "anthropic", api: "openai-completions" }), false, "provider alone is insufficient; API adapter must be Anthropic Messages");
  assert.equal(isPingableRoute({ provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" }), false, "same-origin path override is still a custom route");
  assert.equal(isPingableRoute({ provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com?x=1" }), false, "same-origin query override is a custom route");
  assert.equal(isPingableRoute(undefined), false, "unknown route is never pinged");
  assert.equal(isPingableRoute({ provider: "bedrock", api: "anthropic-messages" }), false, "non-anthropic provider");
  assert.equal(isPingableRoute({ provider: "anthropic", api: "anthropic-messages", baseUrl: "https://proxy.example.com" }), false, "custom baseUrl = different cache namespace");
  assert.equal(isPingableRoute({ provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com.proxy.example" }), false, "prefix-confusable baseUrl is not the default origin");
  assert.equal(isPingableRoute({ provider: "anthropic", api: "anthropic-messages", nonApiKeyAuth: true }), false, "OAuth session must not be pinged with the env API key");

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

test("keepalive: adaptive thinking replays the captured provider payload opaquely and streams for usage proof", async () => {
  const clock = { now: 1_700_000_000_000 };
  const requests: Fixture["requests"] = [];
  const payload = adaptivePayload({
    max_tokens: 16,
    stream: false,
    tool_choice: { type: "auto" },
    context_management: { future: "field" },
  });
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return sseResponse({ cache_read_input_tokens: 123_456, cache_creation_input_tokens: 0 });
    },
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });

  keepalive.noteProviderRequest(payload, DIRECT_ROUTE);
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("tool-1");
  clock.now += PING_AFTER_IDLE_MS + 1;

  assert.equal(await keepalive.tick(), "pinged");
  assert.equal(keepalive.state.lastPingOk, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.anthropic.com/v1/messages");
  const body = JSON.parse(requests[0]!.init.body);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.deepEqual(body.context_management, { future: "field" }, "unknown future provider fields must be preserved");

  const { max_tokens: _mt, stream: _stream, ...refreshRest } = body;
  const { max_tokens: _origMt, stream: _origStream, ...origRest } = payload;
  assert.deepEqual(refreshRest, origRest, "adaptive refresh differs only by max_tokens/stream");
});

test("keepalive: adaptive refresh treats nullable creation usage as no cache write", async () => {
  const clock = { now: 1_700_000_000_000 };
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async () => sseResponse({ cache_read_input_tokens: 123_456, cache_creation_input_tokens: null }),
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });

  keepalive.noteProviderRequest(adaptivePayload(), DIRECT_ROUTE);
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("tool-1");
  clock.now += PING_AFTER_IDLE_MS + 1;

  assert.equal(await keepalive.tick(), "pinged");
  assert.equal(keepalive.state.lastPingOk, true, "Anthropic usage null means no cache creation, not unknown usage");
});

test("keepalive: adaptive refresh parses split-chunk message_start SSE events", async () => {
  const clock = { now: 1_700_000_000_000 };
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async () => splitSseResponse({ cache_read_input_tokens: 123_456, cache_creation_input_tokens: 0 }),
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });

  keepalive.noteProviderRequest(adaptivePayload(), DIRECT_ROUTE);
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("tool-1");
  clock.now += PING_AFTER_IDLE_MS + 1;

  assert.equal(await keepalive.tick(), "pinged");
  assert.equal(keepalive.state.lastPingOk, true, "SSE parser buffers message_start across chunks");
});

test("keepalive: adaptive refresh parses CRLF-framed message_start SSE events", async () => {
  const clock = { now: 1_700_000_000_000 };
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async () => sseResponse({ cache_read_input_tokens: 123_456, cache_creation_input_tokens: 0 }, "\r\n"),
    env: { ANTHROPIC_API_KEY: "sk-test" },
  });

  keepalive.noteProviderRequest(adaptivePayload(), DIRECT_ROUTE);
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("tool-1");
  clock.now += PING_AFTER_IDLE_MS + 1;

  assert.equal(await keepalive.tick(), "pinged");
  assert.equal(keepalive.state.lastPingOk, true, "CRLF-framed SSE is valid and should parse as message_start");
});

test("keepalive: adaptive refresh success requires cache-read usage and no cache creation", async () => {
  for (const usage of [
    { cache_read_input_tokens: 0, cache_creation_input_tokens: 55_000 },
    { cache_read_input_tokens: 55_000, cache_creation_input_tokens: 1 },
    { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    { cache_read_input_tokens: 55_000 },
    { cache_read_input_tokens: 55_000, cache_creation_input_tokens: "0" },
  ]) {
    const clock = { now: 1_700_000_000_000 };
    let calls = 0;
    const keepalive = new CacheKeepalive({
      now: () => clock.now,
      fetch: async () => {
        calls++;
        return sseResponse(usage);
      },
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });

    keepalive.noteProviderRequest(adaptivePayload(), DIRECT_ROUTE);
    keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
    keepalive.toolStart("tool-1");
    clock.now += PING_AFTER_IDLE_MS + 1;

    assert.equal(await keepalive.tick(), "pinged", "attempt made");
    assert.equal(keepalive.state.lastPingOk, false, "zero cache-read usage is not a successful keepalive");
    clock.now += PING_AFTER_IDLE_MS + 1;
    assert.equal(await keepalive.tick(), "skipped", "gap abandoned after non-read/cold-write evidence");
    assert.equal(calls, 1, "no repeated cold-cache writes masquerading as pings");
  }
});

test("keepalive: adaptive refresh fails closed on HTTP error, SSE error, or missing message_start", async () => {
  for (const response of [{ ok: false } as const, sseErrorResponse(), emptySseResponse()]) {
    const clock = { now: 1_700_000_000_000 };
    let calls = 0;
    const keepalive = new CacheKeepalive({
      now: () => clock.now,
      fetch: async () => {
        calls++;
        return response;
      },
      env: { ANTHROPIC_API_KEY: "sk-test" },
    });
    keepalive.noteProviderRequest(adaptivePayload(), DIRECT_ROUTE);
    keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
    keepalive.toolStart("tool-1");
    clock.now += PING_AFTER_IDLE_MS + 1;

    assert.equal(await keepalive.tick(), "pinged", "attempt made");
    assert.equal(keepalive.state.lastPingOk, false);
    clock.now += PING_AFTER_IDLE_MS + 1;
    assert.equal(await keepalive.tick(), "skipped", "failed stream parse abandons gap");
    assert.equal(calls, 1);
  }
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

test("a billed ping reports provider usage priced from pi's model rates", async () => {
  const clock = { now: Date.parse("2026-07-28T09:00:00.000Z") };
  const records: KeepaliveSpendRecord[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 0 },
        }),
    }),
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
    onSpend: (record) => records.push(record),
  });

  keepalive.noteProviderRequest(anthropicPayload(), {
    provider: "anthropic",
    api: "anthropic-messages",
    cacheReadPricePerMTok: 0.6,
    pricePerMTok: { input: 6, output: 30, cacheWrite: 7.5 },
    modelKey: "anthropic/claude-fable-5",
  });
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("t1");
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged");

  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.match(record.key, /anthropic\/claude-fable-5/);
  assert.equal(record.usage.cacheRead, 500_000);
  assert.equal(record.usage.input, 12);
  // 500k cache-read tokens at $0.60/MTok = $0.30, plus 12 input at $6/MTok and 1 output at $30/MTok.
  assert.ok(Math.abs(record.usage.cost.cacheRead - 0.3) < 1e-9, `cacheRead cost ${record.usage.cost.cacheRead}`);
  assert.ok(Math.abs(record.usage.cost.total - (0.3 + (12 / 1e6) * 6 + (1 / 1e6) * 30)) < 1e-9);
  assert.ok(record.recordId.length > 0, "carries a stable id so a replay cannot double count");
});

test("a failed or skipped ping records no spend", async () => {
  const clock = { now: Date.parse("2026-07-28T09:00:00.000Z") };
  const records: KeepaliveSpendRecord[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async () => ({ ok: false, status: 500 }),
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
    onSpend: (record) => records.push(record),
  });

  // Skipped: nothing armed.
  assert.equal(await keepalive.tick(), "skipped");
  assert.equal(records.length, 0);

  keepalive.noteProviderRequest(anthropicPayload(), { provider: "anthropic", api: "anthropic-messages", cacheReadPricePerMTok: 0.6 });
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("t1");
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged");
  assert.equal(records.length, 0, "a non-OK response was never billed as a read");
});

test("a ping whose response reveals no usage records nothing rather than a guess", async () => {
  const clock = { now: Date.parse("2026-07-28T09:00:00.000Z") };
  const records: KeepaliveSpendRecord[] = [];
  const keepalive = new CacheKeepalive({
    now: () => clock.now,
    fetch: async () => ({ ok: true, text: async () => "not json" }),
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-test" },
    onSpend: (record) => records.push(record),
  });
  keepalive.noteProviderRequest(anthropicPayload(), { provider: "anthropic", api: "anthropic-messages", cacheReadPricePerMTok: 0.6 });
  keepalive.noteTurnUsage(MIN_PROMPT_TOKENS);
  keepalive.toolStart("t1");
  clock.now += PING_AFTER_IDLE_MS + 1;
  assert.equal(await keepalive.tick(), "pinged");
  assert.equal(records.length, 0);
});
