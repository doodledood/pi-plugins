import test from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { activate, consult, modelsDiffer, resolveModel, resolveTimeout } from "./index.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { HARD_DENIED_TOOLS } from "./child-profile.ts";
import type { AdvisorResult, AdvisorRunInput, AdvisorRunner } from "./types.ts";

function recordingRunner(result: AdvisorResult): { runner: AdvisorRunner; last: () => AdvisorRunInput | undefined } {
  let last: AdvisorRunInput | undefined;
  return {
    runner: {
      run: async (input) => {
        last = input;
        return result;
      },
    },
    last: () => last,
  };
}

const ok: AdvisorResult = { ok: true, advice: "Ship it behind a flag; back out is one toggle.", model: "anthropic/claude-fable-5", elapsedMs: 42_000 };

function deps(runner: AdvisorRunner, over: Partial<Parameters<typeof consult>[1]> = {}): Parameters<typeof consult>[1] {
  return {
    runner,
    config: DEFAULT_CONFIG,
    cwd: "/tmp/project",
    parentModelPattern: "openai/gpt-5.5",
    bootstrapExtensionPath: "/abs/child-bootstrap.ts",
    ...over,
  };
}

test("consult returns advice with a model/duration header on success", async () => {
  const { runner, last } = recordingRunner(ok);
  const out = await consult({ query: "Should we ship the migration behind a flag?" }, deps(runner));
  assert.equal(out.details.ok, true);
  assert.match(out.text, /advisor · model: anthropic\/claude-fable-5/);
  assert.match(out.text, /Ship it behind a flag/);
  // Hard denies always flow to the subprocess.
  for (const name of HARD_DENIED_TOOLS) assert.ok(last()?.excludedTools.includes(name));
});

test("consult refuses an empty query without running the subprocess", async () => {
  const { runner, last } = recordingRunner(ok);
  const out = await consult({ query: "   " }, deps(runner));
  assert.equal(out.details.ok, false);
  assert.equal(out.details.error, "empty_query");
  assert.equal(last(), undefined);
});

test("consult surfaces a timeout as an explicit non-advice result", async () => {
  const timeout: AdvisorResult = { ok: false, timedOut: true, elapsedMs: 600_000, error: "Advisor produced no reliable advice: the subprocess timed out." };
  const { runner } = recordingRunner(timeout);
  const out = await consult({ query: "deep question" }, deps(runner));
  assert.equal(out.details.ok, false);
  assert.equal(out.details.timedOut, true);
  assert.match(out.text, /no reliable advice/i);
});

test("consult flags when the advisor ran on a different model than requested", async () => {
  const mismatched: AdvisorResult = { ok: true, advice: "advice", model: "openai/gpt-5.5", elapsedMs: 1000 };
  const { runner } = recordingRunner(mismatched);
  const out = await consult({ query: "q", model: "anthropic/claude-fable-5" }, deps(runner));
  assert.match(out.text, /requested model 'anthropic\/claude-fable-5' was not used/);
});

test("resolveModel honors overrides, config default, and inherit", () => {
  assert.deepEqual(resolveModel("provider/x", DEFAULT_CONFIG, "openai/gpt-5.5"), { model: "provider/x", inherited: false });
  assert.deepEqual(resolveModel(undefined, DEFAULT_CONFIG, "openai/gpt-5.5"), { model: "anthropic/claude-fable-5", inherited: false });
  assert.deepEqual(resolveModel("inherit", DEFAULT_CONFIG, "openai/gpt-5.5"), { model: "openai/gpt-5.5", inherited: true });
  assert.deepEqual(resolveModel(undefined, { ...DEFAULT_CONFIG, defaultModel: "inherit" }, "openai/gpt-5.5"), {
    model: "openai/gpt-5.5",
    inherited: true,
  });
});

test("resolveTimeout applies default, clamp, and invalid handling", () => {
  assert.equal(resolveTimeout(undefined, DEFAULT_CONFIG).timeoutMs, DEFAULT_CONFIG.defaultTimeoutMs);
  assert.equal(resolveTimeout(5_000, DEFAULT_CONFIG).timeoutMs, DEFAULT_CONFIG.minTimeoutMs);
  assert.match(resolveTimeout(5_000, DEFAULT_CONFIG).note ?? "", /clamped/i);
  assert.match(resolveTimeout(-1, DEFAULT_CONFIG).note ?? "", /invalid/i);
});

test("modelsDiffer tolerates provider/id vs bare id", () => {
  assert.equal(modelsDiffer("anthropic/claude-fable-5", "claude-fable-5"), false);
  assert.equal(modelsDiffer("anthropic/claude-fable-5", "openai/gpt-5.5"), true);
});

test("activate registers advisor_consult and drives the runner through the tool seam", async () => {
  let captured: ToolDefinition<TSchema> | undefined;
  const { runner } = recordingRunner(ok);
  activate({ registerTool: (t) => (captured = t as ToolDefinition<TSchema>) }, runner);
  assert.ok(captured, "tool registered");
  assert.equal(captured?.name, "advisor_consult");

  const notes: string[] = [];
  const ctx = { cwd: "/tmp/project", model: { provider: "openai", id: "gpt-5.5" }, ui: { notify: (m: string) => notes.push(m) } };
  const result = await captured!.execute("call-1", { query: "Should we ship it?" }, undefined, undefined, ctx as never);
  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { text: string }).text, /Ship it behind a flag/);
});
