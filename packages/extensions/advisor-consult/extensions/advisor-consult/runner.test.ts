import test from "node:test";
import assert from "node:assert/strict";
import { advisorArgs, parseAdvisorOutput, PiSubprocessAdvisorRunner, reachedTimeout } from "./runner.ts";
import type { AdvisorRunInput } from "./types.ts";

type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };

function baseInput(overrides: Partial<AdvisorRunInput> = {}): AdvisorRunInput {
  return {
    query: "Should we ship the migration behind a flag?",
    thinking: "xhigh",
    timeoutMs: 600_000,
    cwd: "/tmp/project",
    systemPrompt: "ADVISOR SYSTEM PROMPT",
    bootstrapExtensionPath: "/abs/child-bootstrap.ts",
    excludedTools: ["advisor_consult", "ask_user_question", "goal"],
    model: "anthropic/claude-fable-5-1",
    ...overrides,
  };
}

function messageEnd(text: string | null, model = "anthropic/claude-fable-5-1"): string {
  const content = text === null ? [{ type: "tool_call", name: "read" }] : [{ type: "text", text }];
  return JSON.stringify({ type: "message_end", message: { role: "assistant", model, content } });
}

function messageEndError(errorMessage: string, model = "anthropic/does-not-exist", partialText?: string): string {
  const content = partialText ? [{ type: "text", text: partialText }] : [];
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", model, content, stopReason: "error", errorMessage },
  });
}

function fakeExec(result: ExecResult, capture?: { args?: string[] }): { exec: (c: string, a: string[]) => Promise<ExecResult> } {
  return {
    exec: async (_cmd: string, args: string[]) => {
      if (capture) capture.args = args;
      return result;
    },
  };
}

test("advisorArgs builds the expected subprocess invocation", () => {
  const args = advisorArgs(baseInput({ sessionDir: "/sessions/--proj--/parent/advisor" }));
  assert.ok(args.includes("--mode") && args.includes("json"));
  assert.ok(args.includes("-p"));
  assert.equal(args.includes("--no-session"), false, "the consult persists so its spend can be found");
  assert.equal(args[args.indexOf("--session-dir") + 1], "/sessions/--proj--/parent/advisor");
  assert.ok(args.includes("--no-context-files"));
  const sysIdx = args.indexOf("--system-prompt");
  assert.equal(args[sysIdx + 1], "ADVISOR SYSTEM PROMPT");
  const eIdx = args.indexOf("-e");
  assert.equal(args[eIdx + 1], "/abs/child-bootstrap.ts");
  const xtIdx = args.indexOf("--exclude-tools");
  assert.equal(args[xtIdx + 1], "advisor_consult,ask_user_question,goal");
  const modelIdx = args.indexOf("--model");
  assert.equal(args[modelIdx + 1], "anthropic/claude-fable-5-1");
  const thinkIdx = args.indexOf("--thinking");
  assert.equal(args[thinkIdx + 1], "xhigh");
  assert.match(args[args.length - 1] ?? "", /advisory_brief/);
  assert.match(args[args.length - 1] ?? "", /migration behind a flag/);
});

test("advisorArgs omits --model when inheriting", () => {
  const args = advisorArgs(baseInput({ model: undefined }));
  assert.equal(args.includes("--model"), false);
});

test("parseAdvisorOutput extracts the last assistant text and model", () => {
  const stdout = [
    JSON.stringify({ type: "message_start" }),
    messageEnd("interim thoughts", "anthropic/claude-fable-5-1"),
    JSON.stringify({ type: "tool_result" }),
    messageEnd("final advice here", "anthropic/claude-fable-5-1"),
  ].join("\n");
  const parsed = parseAdvisorOutput(stdout);
  assert.equal(parsed.advice, "final advice here");
  assert.equal(parsed.model, "anthropic/claude-fable-5-1");
});

test("reachedTimeout classifies near-limit terminations", () => {
  assert.equal(reachedTimeout(600_000, 600_000), true);
  assert.equal(reachedTimeout(10, 600_000), false);
});

test("parseAdvisorOutput keeps final advice when a trailing turn is tool-only", () => {
  const stdout = [messageEnd("real advice"), messageEnd(null)].join("\n");
  assert.equal(parseAdvisorOutput(stdout).advice, "real advice");
});

test("run distinguishes a caller/host abort from a timeout", async () => {
  const runner = new PiSubprocessAdvisorRunner(fakeExec({ code: 1, killed: true, stderr: "", stdout: "" }));
  // Instant exec ⇒ elapsed well under the limit ⇒ not a timeout.
  const result = await runner.run(baseInput({ timeoutMs: 600_000 }));
  assert.equal(result.ok, false);
  assert.notEqual(result.timedOut, true);
  assert.match(result.error ?? "", /caller\/host abort/i);
});

test("run returns advice on a clean exit", async () => {
  const runner = new PiSubprocessAdvisorRunner(fakeExec({ code: 0, killed: false, stderr: "", stdout: messageEnd("ship it behind a flag") }));
  const result = await runner.run(baseInput());
  assert.equal(result.ok, true);
  assert.equal(result.advice, "ship it behind a flag");
  assert.equal(result.model, "anthropic/claude-fable-5-1");
});

test("run reports a non-advice result on a nonzero exit and redacts secrets", async () => {
  const runner = new PiSubprocessAdvisorRunner(
    fakeExec({ code: 1, killed: false, stderr: "boot failed { apiKey: 'sk-supersecretvalue123' }", stdout: "" }),
  );
  const result = await runner.run(baseInput());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /exited with code 1/);
  assert.match(result.error ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(result.error ?? "", /supersecretvalue/);
});

test("run flags a timeout termination as no reliable advice", async () => {
  const runner = new PiSubprocessAdvisorRunner({
    exec: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { code: 1, killed: true, stderr: "", stdout: "" };
    },
  });
  const result = await runner.run(baseInput({ timeoutMs: 2 }));
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.error ?? "", /no reliable advice/i);
  assert.match(result.error ?? "", /timed out/i);
});

test("run reports empty output as no advice", async () => {
  const runner = new PiSubprocessAdvisorRunner(fakeExec({ code: 0, killed: false, stderr: "", stdout: messageEnd(null) }));
  const result = await runner.run(baseInput());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /no advice text/i);
  // A plain silent turn is NOT a model error, so it must not emit the model hint.
  assert.doesNotMatch(result.error ?? "", /pi --list-models/);
});

test("parseAdvisorOutput captures a model/provider error and the model id", () => {
  const stdout = messageEndError('404 {"type":"error","error":{"type":"not_found_error","message":"model: nope"}}', "anthropic/nope");
  const parsed = parseAdvisorOutput(stdout);
  assert.equal(parsed.advice, undefined);
  assert.equal(parsed.model, "anthropic/nope");
  assert.match(parsed.errorMessage ?? "", /not_found_error/);
});

test("run surfaces a model-not-found error with a list-models hint (Pi exits 0)", async () => {
  const stdout = messageEndError("404 not_found_error model: definitely-not-real", "anthropic/definitely-not-real");
  const runner = new PiSubprocessAdvisorRunner(
    fakeExec({ code: 0, killed: false, stderr: 'Warning: Model "definitely-not-real" not found', stdout }),
  );
  const result = await runner.run(baseInput({ model: "anthropic/definitely-not-real" }));
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /model call errored/i);
  assert.match(result.error ?? "", /not_found/i);
  assert.match(result.error ?? "", /pi --list-models/);
  assert.equal(result.model, "anthropic/definitely-not-real");
});

test("run does NOT return truncated advice when the advice-bearing message errored", async () => {
  // Pi keeps partial streamed text on a message it then tags stopReason "error".
  const stdout = messageEndError(
    "429 rate_limit_error: stream interrupted",
    "anthropic/claude-fable-5-1",
    "My read: ship it behind a flag because the migrat",
  );
  const runner = new PiSubprocessAdvisorRunner(fakeExec({ code: 0, killed: false, stderr: "", stdout }));
  const result = await runner.run(baseInput());
  assert.equal(result.ok, false); // must not surface truncated text as complete advice
  assert.equal(result.advice, undefined);
  assert.match(result.error ?? "", /model call errored/i);
  assert.match(result.error ?? "", /429|rate.limit/i);
});

test("run gives generic guidance (no list-models hint) for a non-not-found model error", async () => {
  const stdout = messageEndError("429 rate_limit_error: too many requests", "anthropic/claude-fable-5-1");
  const runner = new PiSubprocessAdvisorRunner(fakeExec({ code: 0, killed: false, stderr: "", stdout }));
  const result = await runner.run(baseInput());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /model call errored/i);
  assert.doesNotMatch(result.error ?? "", /pi --list-models/);
  assert.match(result.error ?? "", /unavailable or misconfigured/i);
});

test("run redacts secrets echoed in a model error", async () => {
  const stdout = messageEndError("auth failed { apiKey: 'sk-supersecret999value' }", "anthropic/claude-fable-5-1");
  const runner = new PiSubprocessAdvisorRunner(fakeExec({ code: 0, killed: false, stderr: "", stdout }));
  const result = await runner.run(baseInput());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /\[REDACTED\]/);
  assert.doesNotMatch(result.error ?? "", /supersecret999/);
});

test("advisorArgs persists the consult into the parent's sidecar directory", () => {
  const args = advisorArgs(baseInput({ sessionDir: "/sessions/--proj--/2026-07-28_abc/advisor" }));
  const idx = args.indexOf("--session-dir");
  assert.ok(idx >= 0, "--session-dir passed");
  assert.equal(args[idx + 1], "/sessions/--proj--/2026-07-28_abc/advisor");
  assert.equal(args.includes("--no-session"), false);
});

test("advisorArgs falls back to no session when the parent has none", () => {
  const args = advisorArgs(baseInput({ sessionDir: undefined }));
  assert.ok(args.includes("--no-session"), "nothing to attach the spend to, so nothing is persisted");
  assert.equal(args.includes("--session-dir"), false);
});

test("a failed consult still leaves its session behind, so partial usage stays countable", async () => {
  // A consult that burns tokens and then fails has still spent money. The failure path
  // must not fall back to --no-session, or that spend becomes unrecoverable.
  const failures: Array<{ label: string; result: ExecResult }> = [
    { label: "timeout", result: { stdout: "", stderr: "", code: 143, killed: true } },
    { label: "nonzero exit", result: { stdout: "", stderr: "boom", code: 3, killed: false } },
    { label: "clean exit, no advice", result: { stdout: "", stderr: "", code: 0, killed: false } },
    {
      label: "model error on exit 0",
      result: {
        stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", model: "m", stopReason: "error", errorMessage: "model not found", content: [] } })}\n`,
        stderr: "",
        code: 0,
        killed: false,
      },
    },
  ];

  for (const { label, result } of failures) {
    const capture: { args?: string[] } = {};
    const runner = new PiSubprocessAdvisorRunner(fakeExec(result, capture));
    const outcome = await runner.run(baseInput({ sessionDir: "/sessions/--proj--/parent/advisor" }));

    assert.equal(outcome.ok, false, `${label} still fails to the parent`);
    assert.equal(
      capture.args?.[capture.args.indexOf("--session-dir") + 1],
      "/sessions/--proj--/parent/advisor",
      `${label} keeps the session, so whatever it already wrote stays countable`,
    );
    assert.equal(capture.args?.includes("--no-session"), false, `${label} does not discard the session`);
  }
});
