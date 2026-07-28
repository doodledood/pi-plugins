import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The module resolves its state path from HOME at import time, so point HOME at a
// temp dir before importing it.
const home = mkdtempSync(join(tmpdir(), "gpt-fast-"));
process.env.HOME = home;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
const statePath = join(home, ".pi", "agent", "gpt-fast-toggle.json");
const { default: gptFastToggle, PRICE_TIER_RECORD_TYPE, effectiveTier } = await import("./gpt-fast-toggle.ts");

test.after(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

interface Harness {
  handlers: Map<string, (event: any, ctx: any) => unknown>;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>;
  entries: Array<{ customType: string; data: unknown }>;
  statuses: Array<string | undefined>;
  notices: string[];
  ctx: any;
}

function createHarness(model: any): Harness {
  const harness: Harness = { handlers: new Map(), commands: new Map(), entries: [], statuses: [], notices: [], ctx: undefined };
  harness.ctx = {
    model,
    ui: {
      setStatus: (_key: string, value: string | undefined) => harness.statuses.push(value),
      notify: (message: string) => harness.notices.push(message),
    },
  };
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      harness.handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      harness.commands.set(name, options);
    },
    appendEntry(customType: string, data: unknown) {
      harness.entries.push({ customType, data });
    },
  };
  gptFastToggle(pi as any);
  return harness;
}

function setMode(mode: "fast" | "deep" | undefined): void {
  if (mode === undefined) {
    writeFileSync(statePath, "{}\n");
    return;
  }
  writeFileSync(statePath, `${JSON.stringify({ mode })}\n`);
}

const gpt = { provider: "openai", id: "gpt-5.6-sol" };
const claude = { provider: "anthropic", id: "claude-opus-5" };

test("effectiveTier is priority only when fast mode applies to the current model", () => {
  assert.equal(effectiveTier(gpt, "fast"), "priority");
  assert.equal(effectiveTier(gpt, "deep"), "standard");
  assert.equal(effectiveTier(claude, "fast"), "standard", "priority tier is OpenAI GPT only");
  assert.equal(effectiveTier(undefined, "fast"), "standard");
});

test("session start records the tier turns will actually be billed at", () => {
  const harness = createHarness(gpt);
  setMode("fast");
  harness.handlers.get("session_start")!({}, harness.ctx);
  assert.deepEqual(harness.entries, [{ customType: PRICE_TIER_RECORD_TYPE, data: { tier: "priority" } }]);
});

test("a repeated tier is not appended again", () => {
  const harness = createHarness(gpt);
  setMode("deep");
  harness.handlers.get("session_start")!({}, harness.ctx);
  harness.handlers.get("model_select")!({}, harness.ctx);
  harness.handlers.get("model_select")!({}, harness.ctx);
  assert.equal(harness.entries.length, 1, "one record while the tier is unchanged");
});

test("toggling fast mode mid-session records each tier change in order", async () => {
  const harness = createHarness(gpt);
  setMode("deep");
  harness.handlers.get("session_start")!({}, harness.ctx);
  await harness.commands.get("gpt-fast")!.handler("on", harness.ctx);
  await harness.commands.get("gpt-fast")!.handler("off", harness.ctx);
  assert.deepEqual(
    harness.entries.map((e) => (e.data as { tier: string }).tier),
    ["standard", "priority", "standard"],
  );
});

test("switching to a model without priority billing records the tier dropping back", () => {
  const harness = createHarness(gpt);
  setMode("fast");
  harness.handlers.get("session_start")!({}, harness.ctx);
  harness.ctx.model = claude;
  harness.handlers.get("model_select")!({}, harness.ctx);
  assert.deepEqual(
    harness.entries.map((e) => (e.data as { tier: string }).tier),
    ["priority", "standard"],
  );
});

test("an unavailable session does not break the toggle", async () => {
  const harness = createHarness(gpt);
  setMode("fast");
  const pi = {
    on() {},
    registerCommand() {},
    appendEntry() {
      throw new Error("session is ephemeral");
    },
  };
  gptFastToggle(pi as any);
  assert.doesNotThrow(() => harness.handlers.get("session_start")!({}, harness.ctx));
});

test("priority payload injection is unchanged and still model-gated", () => {
  const harness = createHarness(gpt);
  setMode("fast");
  const hook = harness.handlers.get("before_provider_request")!;
  assert.deepEqual(hook({ payload: { model: "gpt-5.6-sol" } }, harness.ctx), { model: "gpt-5.6-sol", service_tier: "priority" });
  assert.equal(hook({ payload: { model: "x" } }, { model: claude }), undefined, "no injection off OpenAI GPT");
  setMode("deep");
  assert.equal(hook({ payload: { model: "gpt-5.6-sol" } }, harness.ctx), undefined, "no injection in deep mode");
});
