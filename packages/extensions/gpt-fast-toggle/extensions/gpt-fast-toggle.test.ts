import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A temporary agent directory and HOME; the extension resolves its state file per call.
const home = mkdtempSync(join(tmpdir(), "gpt-fast-"));
const agentDir = join(home, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
const statePath = join(agentDir, "gpt-fast-toggle.json");
const { default: gptFastToggle, effectiveTier, readSavedMode } = await import("./gpt-fast-toggle.ts");

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
  writeFileSync(statePath, mode === undefined ? "{}\n" : `${JSON.stringify({ mode })}\n`);
}

const gpt = { provider: "openai", id: "gpt-5.6-sol" };
const claude = { provider: "anthropic", id: "claude-opus-5" };

test("effectiveTier is priority only when fast mode applies to the current model", () => {
  assert.equal(effectiveTier(gpt, "fast"), "priority");
  assert.equal(effectiveTier(gpt, "deep"), "standard");
  assert.equal(effectiveTier(claude, "fast"), "standard", "priority tier is OpenAI GPT only");
  assert.equal(effectiveTier(undefined, "fast"), "standard");
});

// pi-ai prices each turn at the tier the provider billed, so a tier record would make
// any cost surface that honoured it apply the premium a second time.
test("no tier or price record is written to the session at any point", async () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, `${JSON.stringify({ mode: "deep", priorityMultiplier: 2 })}\n`);
  harness.handlers.get("session_start")!({}, harness.ctx);
  await harness.commands.get("gpt-fast")!.handler("on", harness.ctx);
  harness.handlers.get("model_select")!({}, harness.ctx);
  harness.handlers.get("before_provider_request")!({ payload: { model: "gpt-5.6-sol" } }, harness.ctx);
  harness.handlers.get("model_select")!({}, { ...harness.ctx, model: claude });
  await harness.commands.get("gpt-fast")!.handler("off", harness.ctx);
  assert.deepEqual(harness.entries, []);
});

test("priority payload injection is model-gated and follows the saved mode per request", () => {
  const harness = createHarness(gpt);
  setMode("fast");
  const hook = harness.handlers.get("before_provider_request")!;
  assert.deepEqual(hook({ payload: { model: "gpt-5.6-sol" } }, harness.ctx), { model: "gpt-5.6-sol", service_tier: "priority" });
  assert.equal(hook({ payload: { model: "x" } }, { model: claude }), undefined, "no injection off OpenAI GPT");
  // Another pi process toggles the shared file: the next request follows it.
  setMode("deep");
  assert.equal(hook({ payload: { model: "gpt-5.6-sol" } }, harness.ctx), undefined, "no injection in deep mode");
});

test("toggling preserves other keys in the state file", async () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, `${JSON.stringify({ mode: "deep", somethingElse: "keep me" })}\n`);
  await harness.commands.get("gpt-fast")!.handler("on", harness.ctx);
  const afterOn = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(afterOn.mode, "fast");
  assert.equal(afterOn.somethingElse, "keep me");
  assert.equal(readSavedMode(), "fast");
});

test("a corrupt state file does not block the toggle", async () => {
  const harness = createHarness(gpt);
  writeFileSync(statePath, "not json\n");
  await harness.commands.get("gpt-fast")!.handler("on", harness.ctx);
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).mode, "fast");
});

test("toggling off an OpenAI GPT model is refused with a hint", async () => {
  const harness = createHarness(claude);
  setMode("deep");
  await harness.commands.get("gpt-fast")!.handler("on", harness.ctx);
  assert.equal(readSavedMode(), "deep");
  assert.ok(harness.notices.some((n) => /only applies to direct OpenAI GPT/.test(n)));
});
