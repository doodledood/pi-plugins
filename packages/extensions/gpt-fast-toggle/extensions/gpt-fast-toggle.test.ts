import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The module resolves its state path from HOME at import time, so point HOME at a
// temp dir before importing it.
const home = mkdtempSync(join(tmpdir(), "gpt-fast-"));
process.env.HOME = home;
mkdirSync(join(home, ".pi", "agent"), { recursive: true });
const statePath = join(home, ".pi", "agent", "gpt-fast-toggle.json");
const { default: gptFastToggle, PRICE_TIER_RECORD_TYPE, effectiveTier, readPriorityMultiplier } = await import("./gpt-fast-toggle.ts");

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

test("the record carries the configured premium, so readers need no knowledge of this extension", () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, `${JSON.stringify({ mode: "fast", priorityMultiplier: 2 })}\n`);
  harness.handlers.get("session_start")!({}, harness.ctx);
  assert.deepEqual(harness.entries, [{ customType: PRICE_TIER_RECORD_TYPE, data: { tier: "priority", multiplier: 2 } }]);
  assert.equal(readPriorityMultiplier(), 2);
});

test("changing the premium mid-session is recorded, so later turns are priced correctly", () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, `${JSON.stringify({ mode: "fast", priorityMultiplier: 2 })}\n`);
  harness.handlers.get("session_start")!({}, harness.ctx);
  writeFileSync(statePath, `${JSON.stringify({ mode: "fast", priorityMultiplier: 3 })}\n`);
  harness.handlers.get("model_select")!({}, harness.ctx);
  assert.deepEqual(
    harness.entries.map((e) => e.data),
    [{ tier: "priority", multiplier: 2 }, { tier: "priority", multiplier: 3 }],
  );
});

test("an absent or nonsense premium is simply omitted from the record", () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, `${JSON.stringify({ mode: "fast", priorityMultiplier: "two" })}\n`);
  harness.handlers.get("session_start")!({}, harness.ctx);
  assert.deepEqual(harness.entries[0]?.data, { tier: "priority" });
  assert.equal(readPriorityMultiplier(), undefined);
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
  // The throwing pi must be the one whose handler runs, or this proves nothing: with a
  // no-op `on`, the assertion would silently exercise a different, working instance.
  setMode("fast");
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> | void }>();
  let appendAttempts = 0;
  const pi = {
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> | void }) {
      commands.set(name, options);
    },
    appendEntry() {
      appendAttempts += 1;
      throw new Error("session is ephemeral");
    },
  };
  gptFastToggle(pi as any);

  const notices: string[] = [];
  const ctx = { model: gpt, ui: { setStatus() {}, notify: (m: string) => notices.push(m) } };
  assert.doesNotThrow(() => handlers.get("session_start")!({}, ctx));
  assert.equal(appendAttempts, 1, "it really did try to record the tier on this instance");

  // The toggle itself still works when the session cannot take the record.
  await assert.doesNotReject(() => Promise.resolve(commands.get("gpt-fast")!.handler("off", ctx)));
  assert.equal(readSavedModeFromDisk(), "deep");
  assert.ok(notices.some((n) => /fast mode disabled/i.test(n)));
});

function readSavedModeFromDisk(): string | undefined {
  return JSON.parse(readFileSync(statePath, "utf8")).mode;
}

test("priority payload injection is unchanged and still model-gated", () => {
  const harness = createHarness(gpt);
  setMode("fast");
  const hook = harness.handlers.get("before_provider_request")!;
  assert.deepEqual(hook({ payload: { model: "gpt-5.6-sol" } }, harness.ctx), { model: "gpt-5.6-sol", service_tier: "priority" });
  assert.equal(hook({ payload: { model: "x" } }, { model: claude }), undefined, "no injection off OpenAI GPT");
  setMode("deep");
  assert.equal(hook({ payload: { model: "gpt-5.6-sol" } }, harness.ctx), undefined, "no injection in deep mode");
});

test("toggling preserves the configured priority premium and any other keys", async () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, `${JSON.stringify({ mode: "deep", priorityMultiplier: 2, somethingElse: "keep me" })}\n`);

  await harness.commands.get("gpt-fast")!.handler("on", harness.ctx);
  const afterOn = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(afterOn.mode, "fast");
  assert.equal(afterOn.priorityMultiplier, 2, "the premium the cost surfaces read must survive the toggle");
  assert.equal(afterOn.somethingElse, "keep me");

  await harness.commands.get("gpt-fast")!.handler("off", harness.ctx);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).priorityMultiplier, 2);
});

test("a corrupt state file does not block the toggle", async () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, "not json\n");
  await harness.commands.get("gpt-fast")!.handler("on", harness.ctx);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).mode, "fast");
});

test("a configured premium survives a toggle and is still put into the record", async () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, `${JSON.stringify({ mode: "deep", priorityMultiplier: 2 })}\n`);
  harness.handlers.get("session_start")!({}, harness.ctx);
  await harness.commands.get("gpt-fast")!.handler("on", harness.ctx);

  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).priorityMultiplier, 2);
  assert.deepEqual(harness.entries.at(-1)?.data, { tier: "priority", multiplier: 2 });
});
