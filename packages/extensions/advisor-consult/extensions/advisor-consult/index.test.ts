import test from "node:test";
import assert from "node:assert/strict";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
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

const renderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function plainLines(lines: string[]): string {
  return lines
    .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").trimEnd())
    .join("\n");
}

function captureAdvisorTool(config = DEFAULT_CONFIG): ToolDefinition<TSchema> {
  let captured: ToolDefinition<TSchema> | undefined;
  const { runner } = recordingRunner(ok);
  activate(
    { registerTool: (tool) => (captured = tool as ToolDefinition<TSchema>) },
    runner,
    () => ({ config, path: "/tmp/advisor-consult-test.json" }),
  );
  assert.ok(captured, "tool registered");
  return captured;
}

function renderAdvisorCall(
  tool: ToolDefinition<TSchema>,
  args: Record<string, unknown>,
  options: {
    width?: number;
    expanded?: boolean;
    argsComplete?: boolean;
    isPartial?: boolean;
    executionStarted?: boolean;
    isError?: boolean;
    lastComponent?: unknown;
  } = {},
) {
  assert.ok(tool.renderCall, "renderCall registered");
  const context = {
    args,
    state: {},
    lastComponent: options.lastComponent,
    executionStarted: options.executionStarted ?? false,
    isError: options.isError ?? false,
    argsComplete: options.argsComplete ?? true,
    isPartial: options.isPartial ?? true,
    expanded: options.expanded ?? false,
    showImages: false,
    cwd: "/tmp/project",
    toolCallId: "call-render",
    invalidate() {},
  };
  const component = tool.renderCall(args as never, renderTheme as never, context as never);
  return { component, lines: component.render(options.width ?? 120) };
}

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
  const out = await consult({ query: "Should we ship the migration behind a flag?", thinking: "high" }, deps(runner));
  assert.equal(out.details.ok, true);
  assert.match(out.text, /advisor · model: anthropic\/claude-fable-5 · 42\.0s/);
  assert.match(out.text, /Ship it behind a flag/);
  assert.equal(last()?.thinking, "high");
  // Hard denies always flow to the subprocess.
  for (const name of HARD_DENIED_TOOLS) assert.ok(last()?.excludedTools.includes(name));
});

test("consult normalizes rounded minute rollover in the result header", async () => {
  const boundary: AdvisorResult = { ...ok, elapsedMs: 119_999 };
  const { runner } = recordingRunner(boundary);
  const out = await consult({ query: "Should we ship?" }, deps(runner));
  assert.match(out.text, / · 2m\]/);
  assert.doesNotMatch(out.text, /1m 60s/);
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
  const captured = captureAdvisorTool();
  assert.equal(captured.name, "advisor_consult");
  assert.equal(captured.renderResult, undefined, "raw result fallback remains authoritative");

  const notes: string[] = [];
  const ctx = { cwd: "/tmp/project", model: { provider: "openai", id: "gpt-5.5" }, ui: { notify: (m: string) => notes.push(m) } };
  const result = await captured.execute("call-1", { query: "Should we ship it?" }, undefined, undefined, ctx as never);
  assert.equal(result.content[0]?.type, "text");
  assert.match((result.content[0] as { text: string }).text, /Ship it behind a flag/);
});

test("renderCall shows explicit invocation metadata and a compact query preview", () => {
  const tool = captureAdvisorTool();
  const { lines } = renderAdvisorCall(tool, {
    query: "Objective: validate the plan.\nEvidence: staging passed.",
    model: "openai/gpt-5.6-sol",
    thinking: "high",
    timeout_ms: 90_000,
  });

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /Advisor Consult · openai\/gpt-5\.6-sol · high · 1m 30s/);
  assert.match(lines[1]!, /query: Objective: validate the plan\. Evidence: staging passed\./);
});

test("renderCall expands configured defaults and the complete multiline query", () => {
  const config = { ...DEFAULT_CONFIG, defaultModel: "provider/custom-advisor", defaultThinking: "medium" as const, defaultTimeoutMs: 120_000 };
  const tool = captureAdvisorTool(config);
  const { lines } = renderAdvisorCall(
    tool,
    { query: "Objective: challenge the rollout.\nEvidence: canary is healthy.\nDecision: ship or wait?" },
    { expanded: true, width: 120 },
  );
  const rendered = plainLines(lines);

  assert.match(rendered, /model: provider\/custom-advisor \(configured default\)/);
  assert.match(rendered, /effort: medium \(configured default\)/);
  assert.match(rendered, /timeout: 2m \(configured default\)/);
  assert.match(rendered, /query:\nObjective: challenge the rollout\.\nEvidence: canary is healthy\.\nDecision: ship or wait\?/);
});

test("renderCall shows configured inheritance as a default parent model", () => {
  const tool = captureAdvisorTool({ ...DEFAULT_CONFIG, defaultModel: "inherit" });
  const collapsed = renderAdvisorCall(tool, { query: "Challenge this." });
  assert.match(collapsed.lines[0]!, /Advisor Consult · parent model/);

  const expanded = plainLines(renderAdvisorCall(tool, { query: "Challenge this." }, { expanded: true }).lines);
  assert.match(expanded, /model: parent model \(configured default\)/);
});

test("renderCall labels inherited models and clamped timeouts accurately", () => {
  const tool = captureAdvisorTool();
  const { lines } = renderAdvisorCall(
    tool,
    { query: "Challenge this.", model: "inherit", thinking: "xhigh", timeout_ms: 5_000 },
    { expanded: true },
  );
  const rendered = plainLines(lines);

  assert.match(rendered, /model: parent model \(requested\)/);
  assert.match(rendered, /effort: xhigh \(requested\)/);
  assert.match(rendered, /timeout: 30\.0s \(clamped\)/);

  const boundary = plainLines(
    renderAdvisorCall(
      tool,
      { query: "Challenge this.", model: "inherit", thinking: "xhigh", timeout_ms: 119_999 },
      { expanded: true },
    ).lines,
  );
  assert.match(boundary, /timeout: 2m \(requested\)/);
  assert.doesNotMatch(boundary, /1m 60s/);
});

test("renderCall tolerates partial and malformed streaming arguments and reuses its component", () => {
  const tool = captureAdvisorTool();
  const partial = renderAdvisorCall(tool, {}, { argsComplete: false });
  assert.match(partial.lines[0]!, /Advisor Consult · … · … · …/);
  assert.equal(partial.lines[1], "query: …");

  const streaming = renderAdvisorCall(
    tool,
    { query: "", model: "", thinking: "h", timeout_ms: 1 },
    { argsComplete: false, expanded: true, lastComponent: partial.component },
  );
  const streamingText = plainLines(streaming.lines);
  assert.match(streamingText, /model: … \(pending\)/);
  assert.match(streamingText, /effort: h \(pending\)/);
  assert.match(streamingText, /timeout: 1ms \(pending\)/);
  assert.match(streamingText, /query:\n…/);
  assert.doesNotMatch(streamingText, /invalid|clamped|empty query/);

  const restored = plainLines(
    renderAdvisorCall(tool, { query: "Historical brief." }, { argsComplete: false, isPartial: false, expanded: true }).lines,
  );
  assert.match(restored, /model: anthropic\/claude-fable-5 \(configured default\)/);
  assert.match(restored, /effort: xhigh \(configured default\)/);
  assert.match(restored, /timeout: 10m \(configured default\)/);
  assert.doesNotMatch(restored, /pending/);

  const started = plainLines(
    renderAdvisorCall(
      tool,
      { query: "Running brief." },
      { argsComplete: false, isPartial: true, executionStarted: true, expanded: true },
    ).lines,
  );
  assert.match(started, /model: anthropic\/claude-fable-5 \(configured default\)/);
  assert.match(started, /effort: xhigh \(configured default\)/);
  assert.match(started, /timeout: 10m \(configured default\)/);
  assert.doesNotMatch(started, /pending/);

  const interrupted = plainLines(
    renderAdvisorCall(
      tool,
      { query: "Historical", model: "openai/gpt-" },
      { argsComplete: false, isPartial: false, isError: true, expanded: true },
    ).lines,
  );
  assert.match(interrupted, /model: openai\/gpt- \(pending\)/);
  assert.match(interrupted, /effort: … \(pending\)/);
  assert.match(interrupted, /timeout: … \(pending\)/);
  assert.match(interrupted, /query:\nHistorical/);
  assert.doesNotMatch(interrupted, /configured default|requested/);

  const malformed = renderAdvisorCall(
    tool,
    { query: 42, model: 42, thinking: "turbo", timeout_ms: "soon" },
    { expanded: true, lastComponent: streaming.component },
  );
  assert.equal(malformed.component, partial.component);
  const rendered = plainLines(malformed.lines);
  assert.match(rendered, /model: \[invalid\] \(invalid\)/);
  assert.match(rendered, /effort: \[invalid\] \(invalid\)/);
  assert.match(rendered, /timeout: \[invalid\] \(invalid\)/);
  assert.match(rendered, /\[invalid query\]/);

  const ignoredOverrides = plainLines(
    renderAdvisorCall(tool, { query: "Use defaults.", model: " ", timeout_ms: -1 }, { expanded: true }).lines,
  );
  assert.match(ignoredOverrides, /model: anthropic\/claude-fable-5 \(configured default\)/);
  assert.match(ignoredOverrides, /timeout: 10m \(configured default\)/);
});

test("renderCall escapes terminal and directional controls and obeys narrow widths", () => {
  const tool = captureAdvisorTool();
  const directionalControls = "\u061c\u200e\u200f\u202a\u202e\u2066\u2069";
  const query = `BEGIN 界🙂 ${"long ".repeat(20)}MIDDLE \u001b[31m\u0007\r\u007f\u009b${directionalControls}\ud800 END`;
  const model = "provider/model\u001b\u202e";
  const expectedExpandedQuery = `BEGIN界🙂${"long".repeat(20)}MIDDLE\\x1b[31m\\x07\\x0d\\x7f\\x9b\\u061c\\u200e\\u200f\\u202a\\u202e\\u2066\\u2069\\ud800END`;

  for (const expanded of [false, true]) {
    for (const width of [1, 12, 20, 40]) {
      const { lines } = renderAdvisorCall(
        tool,
        { query, model, thinking: "high", timeout_ms: 60_000 },
        { expanded, width },
      );
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `${expanded ? "expanded" : "collapsed"} width ${width}: ${lines.join(" | ")}`);
      assert.ok(lines.every((line) => visibleWidth(Buffer.from(line).toString("utf8")) <= width), `UTF-8 round trip exceeded width ${width}`);
      if (!expanded) {
        assert.equal(lines.length, 2, `collapsed row disappeared at width ${width}`);
        assert.ok(lines.every((line) => visibleWidth(line) > 0), `collapsed row was empty at width ${width}`);
      }
      const plain = plainLines(lines);
      if (!expanded && width >= 40) {
        assert.match(plain, /Advisor Consult/);
        assert.match(plain, /query:/);
      }
      assert.doesNotMatch(plain, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
      if (expanded && width >= 12) {
        const compact = plain.replace(/\s+/gu, "");
        assert.ok(compact.includes("model:provider/model\\x1b\\u202e(requested)"), `metadata lost at width ${width}`);
        assert.ok(compact.includes(expectedExpandedQuery), `query content lost at width ${width}`);
      }
    }
  }

  const collapsedRaw = renderAdvisorCall(
    tool,
    { query, model, thinking: "high", timeout_ms: 60_000 },
    { expanded: false, width: 1_000 },
  ).lines.join("\n");
  assert.match(collapsedRaw, /\\x1b\[31m/);
  assert.doesNotMatch(collapsedRaw, /\u001b\[31m/);
  assert.match(collapsedRaw, /\\ud800/);

  const expanded = renderAdvisorCall(
    tool,
    { query, model, thinking: "high", timeout_ms: 60_000 },
    { expanded: true, width: 200 },
  ).lines;
  const rendered = plainLines(expanded);
  assert.match(rendered, /provider\/model\\x1b\\u202e/);
  for (const escaped of ["\\u061c", "\\u200e", "\\u200f", "\\u202a", "\\u202e", "\\u2066", "\\u2069"]) {
    assert.ok(rendered.includes(escaped), `missing visible directional escape ${escaped}`);
  }
  assert.match(rendered, /\\x1b\[31m\\x07\\x0d\\x7f\\x9b\\u061c/);
});
