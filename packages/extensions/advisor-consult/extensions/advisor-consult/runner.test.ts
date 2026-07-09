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
    model: "anthropic/claude-fable-5",
    ...overrides,
  };
}

function messageEnd(text: string | null, model = "anthropic/claude-fable-5"): string {
  const content = text === null ? [{ type: "tool_call", name: "read" }] : [{ type: "text", text }];
  return JSON.stringify({ type: "message_end", message: { role: "assistant", model, content } });
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
  const args = advisorArgs(baseInput());
  assert.ok(args.includes("--mode") && args.includes("json"));
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("--no-session"));
  assert.ok(args.includes("--no-context-files"));
  const sysIdx = args.indexOf("--system-prompt");
  assert.equal(args[sysIdx + 1], "ADVISOR SYSTEM PROMPT");
  const eIdx = args.indexOf("-e");
  assert.equal(args[eIdx + 1], "/abs/child-bootstrap.ts");
  const xtIdx = args.indexOf("--exclude-tools");
  assert.equal(args[xtIdx + 1], "advisor_consult,ask_user_question,goal");
  const modelIdx = args.indexOf("--model");
  assert.equal(args[modelIdx + 1], "anthropic/claude-fable-5");
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
    messageEnd("interim thoughts", "anthropic/claude-fable-5"),
    JSON.stringify({ type: "tool_result" }),
    messageEnd("final advice here", "anthropic/claude-fable-5"),
  ].join("\n");
  const parsed = parseAdvisorOutput(stdout);
  assert.equal(parsed.advice, "final advice here");
  assert.equal(parsed.model, "anthropic/claude-fable-5");
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
  assert.equal(result.model, "anthropic/claude-fable-5");
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
});
