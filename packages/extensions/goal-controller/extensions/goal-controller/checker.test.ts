import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCheckerVerdict, PiSubprocessCheckerRunner, redactSecrets, type CheckerRunInput } from "./checker.ts";
import { CHECKER_SESSION_KIND } from "./index.ts";
import { deriveChildSessionDir } from "./sidecar.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { createGoal } from "./controller.ts";
import type { CheckerSessionContext, GoalControllerConfig } from "./types.ts";

const JSON_ASSISTANT_FIELDS = {
  api: "openai-responses",
  provider: "openai",
  model: "gpt-test",
  responseModel: "gpt-test-actual",
  responseId: "response-1",
  diagnostics: [{ type: "test", timestamp: 0, error: { message: "safe", code: "TEST" }, details: {} }],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  timestamp: 0,
};

function jsonAssistantMessage(content: unknown[] = [], stopReason = "stop"): Record<string, unknown> {
  return { role: "assistant", ...JSON_ASSISTANT_FIELDS, content, stopReason };
}

function settledJsonl(stdout: string): string {
  return [
    stdout.trimEnd(),
    JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
    JSON.stringify({ type: "agent_settled" }),
  ].join("\n");
}

function checkerContext(sessionFile: string | undefined): CheckerSessionContext {
  return {
    sessionFormat: "pi-jsonl-tree",
    sessionFile,
    sessionUnavailableReason: sessionFile ? undefined : "in_memory_or_not_persisted",
    currentLeafId: "leaf-1",
    branchEntryCount: 5,
    branchMessageCount: 3,
    latestTurn: {
      messageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 0,
      toolResultCount: 0,
      toolNames: [],
      hadToolUse: false,
      finalAssistantStopReason: "stop",
    },
  };
}

function assertAuditOnlyCheckerArgs(args: string[]): void {
  const toolsIndexes = args.flatMap((arg, index) => (arg === "--tools" ? [index] : []));
  assert.equal(toolsIndexes.length, 1);
  const toolsIndex = toolsIndexes[0];
  if (toolsIndex === undefined) throw new Error("missing --tools argument");
  assert.equal(args[toolsIndex + 1], "read,grep,find,ls");
  assert.equal(args.includes("--no-extensions"), true);
  assert.equal(args.includes("--no-prompt-templates"), true);
  assert.equal(args.includes("--no-context-files"), true);
  assert.equal(args.includes("--no-skills"), false);
  assert.equal(args.includes("--no-tools"), false);
  assert.equal(args.includes("--no-builtin-tools"), false);
  assert.equal(args.includes("--exclude-tools"), false);
  for (const arg of args) {
    if (!arg.includes(",")) continue;
    assert.equal(arg.split(",").some((tool) => tool === "bash" || tool === "edit" || tool === "write"), false);
  }
}

test("parseCheckerVerdict parses complete verdict JSON with evidence and requirements", () => {
  const verdict = parseCheckerVerdict('{"decision":"complete","complete":true,"reason":"tests pass","evidence":["npm test exited 0"],"requirements":[{"requirement":"tests pass","status":"satisfied","evidence":"npm test exited 0"}]}');
  assert.equal(verdict.decision, "complete");
  assert.equal(verdict.complete, true);
  assert.equal(verdict.reason, "tests pass");
  assert.deepEqual(verdict.evidence, ["npm test exited 0"]);
  assert.equal(verdict.requirements?.[0]?.status, "satisfied");
});

test("parseCheckerVerdict parses fenced JSON and requirements", () => {
  const verdict = parseCheckerVerdict(`\n\`\`\`json\n{"decision":"blocked","complete":false,"blocked":true,"reason":"missing creds","nextTurnGuidance":"ask user","unmetRequirements":["run e2e"],"requirements":[{"requirement":"run e2e","status":"unsatisfied","evidence":"no credentials"}]}\n\`\`\``);
  assert.equal(verdict.decision, "blocked");
  assert.equal(verdict.complete, false);
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.nextTurnGuidance, "ask user");
  assert.deepEqual(verdict.unmetRequirements, ["run e2e"]);
  assert.equal(verdict.requirements?.[0]?.status, "unsatisfied");
});

test("parseCheckerVerdict treats missing user success signal with actionable next step as continue", () => {
  const verdict = parseCheckerVerdict(JSON.stringify({
    decision: "continue",
    complete: false,
    blocked: false,
    reason: "Jokes were delivered, but no laugh signal is observable yet.",
    nextTurnGuidance: "Ask the user whether any joke made them laugh; use a focused user-question tool if available.",
    evidence: ["Worker delivered several jokes.", "No user reaction appears after the jokes."],
    unmetRequirements: ["User has not confirmed laughter."],
    requirements: [
      { requirement: "Attempt humor", status: "satisfied", evidence: "Multiple jokes were delivered." },
      { requirement: "Actually make the user laugh", status: "unclear", evidence: "No user signal yet." },
    ],
  }));
  assert.equal(verdict.decision, "continue");
  assert.equal(verdict.blocked, false);
  assert.match(verdict.nextTurnGuidance ?? "", /ask the user/iu);
});

test("parseCheckerVerdict preserves waiting_for_user decision", () => {
  const verdict = parseCheckerVerdict(JSON.stringify({
    decision: "waiting_for_user",
    complete: false,
    blocked: false,
    reason: "The worker already asked whether the user laughed and is waiting for the answer.",
  }));
  assert.equal(verdict.decision, "waiting_for_user");
  assert.equal(verdict.complete, false);
  assert.equal(verdict.blocked, false);
});

test("parseCheckerVerdict throws on non-json output", () => {
  assert.throws(() => parseCheckerVerdict("looks done to me"), /checker did not return/iu);
});

test("parseCheckerVerdict requires an explicit recognized and internally consistent decision", () => {
  assert.throws(() => parseCheckerVerdict('{}'), /recognized decision/iu);
  assert.throws(() => parseCheckerVerdict('{"decision":"INCOMPLETE"}'), /recognized decision/iu);
  assert.throws(() => parseCheckerVerdict('{"decision":"continue","complete":true}'), /conflicts with complete/iu);
  assert.throws(() => parseCheckerVerdict('{"decision":"continue","blocked":true}'), /conflicts with blocked/iu);
  assert.throws(() => parseCheckerVerdict('{"decision":"complete","complete":true,"blocked":true}'), /conflicts with blocked/iu);
  assert.throws(() => parseCheckerVerdict('{"decision":"blocked","complete":true,"blocked":true}'), /conflicts with complete/iu);
  assert.throws(
    () => parseCheckerVerdict('{"decision":"complete","complete":true,"evidence":["A"],"requirements":[{"requirement":"A","status":"satisfied"},{"requirement":"B","status":"invalid"}]}'),
    /malformed requirement/iu,
  );
});

test("parseCheckerVerdict rejects complete verdict without evidence and requirement assessment", () => {
  assert.throws(() => parseCheckerVerdict('{"decision":"complete","complete":true}'), /evidence|requirement/iu);
  assert.throws(
    () => parseCheckerVerdict('{"decision":"complete","complete":true,"evidence":["test"],"requirements":[{"requirement":"lint","status":"unclear"}]}'),
    /unproven requirements/iu,
  );
});

test("PiSubprocessCheckerRunner resolves inherit model and thinking into subprocess args", async () => {
  let capturedCommand = "";
  let capturedArgs: string[] = [];
  const runner = new PiSubprocessCheckerRunner({
    async exec(command, args) {
      capturedCommand = command;
      capturedArgs = args;
      return {
        stdout: settledJsonl(JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant", ...JSON_ASSISTANT_FIELDS,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  decision: "complete",
                  complete: true,
                  reason: "all requirements proven",
                  evidence: ["fake evidence"],
                  requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake evidence" }],
                }),
              },
            ],
            stopReason: "stop",
          },
        }) + "\n"),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  const goal = createGoal("fake goal", DEFAULT_CONFIG, 0);
  const verdict = await runner.run({
    goal,
    context: checkerContext("/tmp/pi-session.jsonl"),
    config: DEFAULT_CONFIG,
    cwd: "/tmp",
    model: {
      id: "gpt-5.5",
      name: "GPT 5.5",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    },
    thinkingLevel: "xhigh",
    sessionDir: "/sessions/--proj--/parent/goal-checker",
  });

  assert.equal(verdict.complete, true);
  assert.equal(capturedCommand, "pi");
  assert.equal(capturedArgs.includes("--model"), true);
  assert.equal(capturedArgs[capturedArgs.indexOf("--model") + 1], "openai/gpt-5.5");
  assert.equal(capturedArgs.includes("--thinking"), true);
  assert.equal(capturedArgs[capturedArgs.indexOf("--thinking") + 1], "xhigh");
  assert.equal(capturedArgs.includes("--no-session"), false, "the checker run persists so its spend can be found");
  assert.equal(capturedArgs[capturedArgs.indexOf("--session-dir") + 1], "/sessions/--proj--/parent/goal-checker");
  assertAuditOnlyCheckerArgs(capturedArgs);
  const checkerPrompt = capturedArgs.at(-1) ?? "";
  assert.match(checkerPrompt, /Session navigation context:/iu);
  assert.match(checkerPrompt, /"sessionFile": "\/tmp\/pi-session\.jsonl"/iu);
  assert.match(checkerPrompt, /"currentLeafId": "leaf-1"/iu);
  assert.match(checkerPrompt, /Pi session files are JSONL trees/iu);
  assert.match(checkerPrompt, /fixed audit-only capability profile/iu);
  assert.match(checkerPrompt, /skill discovery/iu);
  assert.match(checkerPrompt, /Extension tools, prompt templates, context files, shell execution, and file mutation tools are unavailable/iu);
  assert.match(checkerPrompt, /you may inspect evidence needed for judgment/iu);
  assert.match(checkerPrompt, /Do not use checker-side tools to perform omitted primary success work on the worker's behalf/iu);
  assert.match(checkerPrompt, /Output contract:/iu);
  assert.match(checkerPrompt, /exactly one JSON object/iu);
  assert.match(checkerPrompt, /no verification summary before or after it/iu);
  assert.ok(
    checkerPrompt.indexOf("Output contract:") > checkerPrompt.indexOf("Session navigation context:"),
    "the JSON-only output contract must be the last thing the checker reads, after the data blobs",
  );
});

test("PiSubprocessCheckerRunner maps configured and inherited max thinking to subprocess args", async () => {
  const captured: string[][] = [];
  const runner = new PiSubprocessCheckerRunner({
    async exec(_command, args) {
      captured.push(args);
      return {
        stdout: settledJsonl(JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant", ...JSON_ASSISTANT_FIELDS,
            content: [{
              type: "text",
              text: JSON.stringify({
                decision: "continue",
                complete: false,
                reason: "more work remains",
              }),
            }],
            stopReason: "stop",
          },
        }) + "\n"),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  const baseInput = {
    goal: createGoal("fake goal", DEFAULT_CONFIG, 0),
    context: checkerContext(undefined),
    cwd: "/tmp",
    model: undefined,
    checkerModelBootstrapPaths: [],
  } satisfies Omit<CheckerRunInput, "config" | "thinkingLevel">;

  await runner.run({ ...baseInput, config: { ...DEFAULT_CONFIG, checker: { ...DEFAULT_CONFIG.checker, thinking: "max" } }, thinkingLevel: "off" });
  await runner.run({ ...baseInput, config: DEFAULT_CONFIG, thinkingLevel: "max" });

  for (const args of captured) {
    assert.equal(args[args.indexOf("--thinking") + 1], "max");
  }
});

test("PiSubprocessCheckerRunner extracts the JSON verdict even when a prose summary block trails it", async () => {
  const jsonVerdict = JSON.stringify({
    decision: "complete",
    complete: true,
    reason: "all requirements proven",
    evidence: ["npm run verify exited 0"],
    requirements: [{ requirement: "verify", status: "satisfied", evidence: "exit 0" }],
  });
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const verdictMessage = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [
            { type: "text", text: `I inspected {an odd fragment. Here's the verdict: ${jsonVerdict}\nVerification summary: metadata was {}.` },
          ],
          stopReason: "stop",
        },
      });
      return { stdout: settledJsonl(`${verdictMessage}\n`), stderr: "", code: 0, killed: false };
    },
  });

  const verdict = await runner.run({
    goal: createGoal("fake goal", DEFAULT_CONFIG, 0),
    context: checkerContext("/tmp/pi-session.jsonl"),
    config: DEFAULT_CONFIG,
    cwd: "/tmp",
    model: undefined,
    thinkingLevel: "off",
  });

  assert.equal(verdict.complete, true);
  assert.equal(verdict.reason, "all requirements proven");
});

test("PiSubprocessCheckerRunner rejects a verdict nested inside a non-verdict JSON object", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const wrappedVerdict = JSON.stringify({
        wrapper: {
          decision: "complete",
          complete: true,
          evidence: ["nested evidence must not win"],
          requirements: [{ requirement: "nested", status: "satisfied" }],
        },
      });
      const message = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [{ type: "text", text: wrappedVerdict }], stopReason: "stop" },
      });
      return { stdout: settledJsonl(`${message}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /returned an invalid verdict/iu);
      assert.match(error.message, /omitted a recognized decision/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner rejects a verdict nested inside a JSON array", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const nestedVerdict = JSON.stringify([{
        decision: "complete",
        complete: true,
        evidence: ["nested evidence must not win"],
        requirements: [{ requirement: "nested", status: "satisfied" }],
      }]);
      const message = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [{ type: "text", text: `before ${nestedVerdict} after` }], stopReason: "stop" },
      });
      return { stdout: settledJsonl(`${message}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /returned an invalid verdict/iu);
      assert.match(error.message, /not a JSON verdict object/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner rejects a verdict nested in a balanced malformed wrapper", async () => {
  const verdict = '{"decision":"continue"}';
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const message = JSON.stringify({
        type: "message_end",
        message: { ...jsonAssistantMessage([{ type: "text", text: `{"wrapper":${verdict}, trailing}` }]) },
      });
      return { stdout: settledJsonl(message), stderr: "", code: 0, killed: false };
    },
  });
  await assert.rejects(() => runChecker(runner, DEFAULT_CONFIG), /invalid verdict/iu);
});

test("PiSubprocessCheckerRunner reconstructs a verdict split across terminal text blocks", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const splitVerdict = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [
            { type: "text", text: '{"decision":"continue",' },
            { type: "text", text: '"complete":false,"reason":"split verdict"}' },
          ],
          stopReason: "stop",
        },
      });
      const customMessage = JSON.stringify({
        type: "message_end",
        message: { role: "custom", customType: "note", content: "safe string content", display: false, timestamp: 0 },
      });
      return { stdout: settledJsonl(`${customMessage}\n${splitVerdict}\n`), stderr: "", code: 0, killed: false };
    },
  });

  const verdict = await runCheckerVerdict(runner, DEFAULT_CONFIG);
  assert.equal(verdict.decision, "continue");
  assert.equal(verdict.reason, "split verdict");
});

test("PiSubprocessCheckerRunner does not let an earlier tool-turn verdict override terminal prose", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const staleVerdict = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [{ type: "text", text: '{"decision":"complete","complete":true}' }],
          stopReason: "toolUse",
        },
      });
      const terminalProse = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [{ type: "text", text: "Verification failed after inspection." }],
          stopReason: "stop",
        },
      });
      return { stdout: settledJsonl(`${staleVerdict}\n${terminalProse}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /returned an invalid verdict/iu);
      assert.match(error.message, /checker response was not a JSON verdict object/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner classifies and redacts invalid verdict text", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const proseOnly = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [{ type: "text", text: "Verification summary: apiKey=sk-invalidverdictsecret123" }], stopReason: "stop" },
      });
      return { stdout: settledJsonl(`${proseOnly}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG, {
      model: {
        id: "gpt-test",
        name: "GPT Test",
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /returned an invalid verdict/iu);
      assert.match(error.message, /checker response was not a JSON verdict object/iu);
      assert.match(error.message, /effectiveModel=openai\/gpt-test/iu);
      assert.doesNotMatch(error.message, /sk-invalidverdictsecret123/u);
      assert.doesNotMatch(error.message, /Verification summary/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner surfaces a zero-exit assistant provider error instead of parsing raw JSONL", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const session = JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-07-19T00:00:00.000Z", cwd: "/tmp" });
      const assistantError = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [],
          stopReason: "error",
          errorMessage: "This request was blocked as it seems to violate restrictions on reverse engineering or duplicating model outputs. apiKey=sk-supersecret123456",
        },
      });
      return { stdout: settledJsonl(`${session}\n${assistantError}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG, {
      model: {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /checker model failed before returning a verdict/iu);
      assert.match(error.message, /effectiveModel=anthropic\/claude-fable-5/iu);
      assert.match(error.message, /provider refused the checker request/iu);
      assert.match(error.message, /reverse engineering or duplicating model outputs/iu);
      assert.match(error.message, /configure checker\.model/iu);
      assert.doesNotMatch(error.message, /sk-supersecret123456/u);
      assert.doesNotMatch(error.message, /checker did not return a JSON object/iu);
      assert.doesNotMatch(error.message, /\{"type":"session"/u);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner rejects verdict-looking partial text when the terminal assistant errored", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const assistantError = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [{
            type: "text",
            text: JSON.stringify({
              decision: "complete",
              complete: true,
              evidence: ["partial output must not win"],
              requirements: [{ requirement: "fake", status: "satisfied" }],
            }),
          }],
          stopReason: "error",
          errorMessage: "provider stream failed",
        },
      });
      return { stdout: settledJsonl(`${assistantError}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /checker model failed before returning a verdict/iu);
      assert.doesNotMatch(error.message, /partial output must not win/u);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner rejects verdict-looking text when the terminal assistant was aborted", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const aborted = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [{
            type: "text",
            text: JSON.stringify({
              decision: "complete",
              complete: true,
              evidence: ["aborted output must not win"],
              requirements: [{ requirement: "fake", status: "satisfied" }],
            }),
          }],
          stopReason: "aborted",
        },
      });
      return { stdout: settledJsonl(`${aborted}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /checker model failed before returning a verdict/iu);
      assert.match(error.message, /Assistant stop reason: aborted/iu);
      return true;
    },
  );
});

for (const stopReason of ["length", "toolUse"] as const) {
  test(`PiSubprocessCheckerRunner rejects verdict-looking text when terminal stop reason is ${stopReason}`, async () => {
    const runner = new PiSubprocessCheckerRunner({
      async exec() {
        const incomplete = JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant", ...JSON_ASSISTANT_FIELDS,
            content: [{
              type: "text",
              text: JSON.stringify({
                decision: "complete",
                complete: true,
                evidence: ["incomplete output must not win"],
                requirements: [{ requirement: "fake", status: "satisfied" }],
              }),
            }],
            stopReason,
          },
        });
        return { stdout: settledJsonl(`${incomplete}\n`), stderr: "", code: 0, killed: false };
      },
    });

    await assert.rejects(
      () => runChecker(runner, DEFAULT_CONFIG),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /did not finish with a complete verdict response/iu);
        assert.match(error.message, new RegExp(`Assistant stop reason: ${stopReason}`, "iu"));
        return true;
      },
    );
  });
}

test("PiSubprocessCheckerRunner rejects and does not echo an unknown terminal stop reason", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const unknownStop = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [],
          stopReason: "unexpected apiKey=sk-must-not-persist",
        },
      });
      return { stdout: settledJsonl(`${unknownStop}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /malformed Pi JSON event stream/iu);
      assert.doesNotMatch(error.message, /sk-must-not-persist/u);
      assert.doesNotMatch(error.message, /unexpected apiKey/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner treats errorMessage as failure even with stopReason stop", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const assistantError = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [{
            type: "text",
            text: JSON.stringify({
              decision: "complete",
              complete: true,
              evidence: ["errored output must not win"],
              requirements: [{ requirement: "fake", status: "satisfied" }],
            }),
          }],
          stopReason: "stop",
          errorMessage: "provider reported a terminal error",
        },
      });
      return { stdout: settledJsonl(`${assistantError}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /checker model failed before returning a verdict/iu);
      assert.match(error.message, /provider returned an assistant error/iu);
      assert.doesNotMatch(error.message, /provider reported a terminal error/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner accepts a terminal verdict after an earlier retried assistant error", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const retriedError = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [], stopReason: "error", errorMessage: "transient provider failure" },
      });
      const terminalVerdict = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [{
            type: "text",
            text: JSON.stringify({
              decision: "complete",
              complete: true,
              reason: "retry succeeded",
              evidence: ["fresh terminal evidence"],
              requirements: [{ requirement: "fake", status: "satisfied", evidence: "fresh terminal evidence" }],
            }),
          }],
          stopReason: "stop",
        },
      });
      return { stdout: settledJsonl(`${retriedError}\n${terminalVerdict}\n`), stderr: "", code: 0, killed: false };
    },
  });

  const verdict = await runCheckerVerdict(runner, DEFAULT_CONFIG);
  assert.equal(verdict.decision, "complete");
  assert.equal(verdict.reason, "retry succeeded");
});

test("PiSubprocessCheckerRunner accepts pending-stopReason streaming envelopes before a terminal verdict", async () => {
  // Pi 0.83 streams partial assistant messages with stopReason "pending" on
  // message_start / message_update; only the terminal message_end must settle.
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const pendingPartial = jsonAssistantMessage([], "pending");
      const terminalVerdict = jsonAssistantMessage([{
        type: "text",
        text: JSON.stringify({
          decision: "complete",
          complete: true,
          reason: "all requirements proven",
          evidence: ["fake evidence"],
          requirements: [{ requirement: "fake", status: "satisfied", evidence: "fake evidence" }],
        }),
      }]);
      return {
        stdout: settledJsonl([
          { type: "message_start", message: pendingPartial },
          {
            type: "message_update",
            message: pendingPartial,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: pendingPartial },
          },
          { type: "message_end", message: terminalVerdict },
        ].map((event) => JSON.stringify(event)).join("\n")),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  const verdict = await runCheckerVerdict(runner, DEFAULT_CONFIG);
  assert.equal(verdict.decision, "complete");
  assert.equal(verdict.reason, "all requirements proven");
});

test("PiSubprocessCheckerRunner rejects a pending-stopReason message_end as malformed", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const pendingVerdict = jsonAssistantMessage([{ type: "text", text: '{"decision":"continue"}' }], "pending");
      return {
        stdout: settledJsonl(JSON.stringify({ type: "message_end", message: pendingVerdict })),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  await assert.rejects(() => runChecker(runner, DEFAULT_CONFIG), /malformed Pi JSON event stream/iu);
});

test("PiSubprocessCheckerRunner distinguishes an empty assistant response from invalid verdict text", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const staleVerdict = JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant", ...JSON_ASSISTANT_FIELDS,
          content: [{ type: "text", text: '{"decision":"complete","complete":true}' }],
          stopReason: "toolUse",
        },
      });
      const emptyAssistant = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [], stopReason: "stop" },
      });
      return { stdout: settledJsonl(`${staleVerdict}\n${emptyAssistant}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /returned no verdict text/iu);
      assert.match(error.message, /effectiveModel=unresolved/iu);
      assert.doesNotMatch(error.message, /checker did not return a JSON object/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner rejects malformed Pi JSON output as a protocol failure", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      return {
        stdout: `${JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-07-19T00:00:00.000Z", cwd: "/tmp" })}\nnot-json passphrase=\"correct horse battery staple\"\n`,
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /malformed Pi JSON event stream/iu);
      assert.match(error.message, /1 non-JSON line/iu);
      assert.doesNotMatch(error.message, /correct horse battery staple/u);
      assert.doesNotMatch(error.message, /not-json/iu);
      assert.doesNotMatch(error.message, /checker did not return a JSON object/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner rejects malformed protocol before interpreting a terminal provider error", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const assistantError = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [], stopReason: "error", errorMessage: "provider failed" },
      });
      return { stdout: settledJsonl(`not-json\n${assistantError}\n`), stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /malformed Pi JSON event stream/iu);
      assert.doesNotMatch(error.message, /checker model failed before returning a verdict/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner rejects a retry-pending lifecycle without agent_settled", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const assistant = jsonAssistantMessage([{ type: "text", text: '{"decision":"continue"}' }]);
      return {
        stdout: [
          { type: "message_end", message: assistant },
          { type: "agent_end", messages: [assistant], willRetry: true },
          { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "retry" },
        ].map((event) => JSON.stringify(event)).join("\n"),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  await assert.rejects(() => runChecker(runner, DEFAULT_CONFIG), /malformed Pi JSON event stream/iu);
});

test("PiSubprocessCheckerRunner rejects a verdict stream without lifecycle settlement", async () => {
  const assistant = jsonAssistantMessage([{ type: "text", text: '{"decision":"continue"}' }]);
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      return { stdout: JSON.stringify({ type: "message_end", message: assistant }), stderr: "", code: 0, killed: false };
    },
  });
  await assert.rejects(() => runChecker(runner, DEFAULT_CONFIG), /malformed Pi JSON event stream/iu);
});

test("PiSubprocessCheckerRunner rejects assistant output after agent_settled", async () => {
  const assistant = jsonAssistantMessage([{ type: "text", text: '{"decision":"continue"}' }]);
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      return {
        stdout: [
          { type: "agent_start" },
          { type: "agent_settled" },
          { type: "message_end", message: assistant },
        ].map((event) => JSON.stringify(event)).join("\n"),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  await assert.rejects(() => runChecker(runner, DEFAULT_CONFIG), /malformed Pi JSON event stream/iu);
});

for (const lifecycleTail of [
  [
    { type: "agent_start" },
    { type: "agent_end", messages: [], willRetry: false },
  ],
  [
    { type: "agent_start" },
    { type: "agent_settled" },
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "retry" },
  ],
  [
    { type: "agent_start" },
    { type: "agent_settled" },
    { type: "queue_update", steering: [], followUp: [] },
  ],
]) {
  test("PiSubprocessCheckerRunner rejects a lifecycle that does not end settled", async () => {
    const runner = new PiSubprocessCheckerRunner({
      async exec() {
        const assistant = jsonAssistantMessage([{ type: "text", text: '{"decision":"continue"}' }]);
        return {
          stdout: [{ type: "message_end", message: assistant }, ...lifecycleTail]
            .map((event) => JSON.stringify(event)).join("\n"),
          stderr: "",
          code: 0,
          killed: false,
        };
      },
    });
    await assert.rejects(() => runChecker(runner, DEFAULT_CONFIG), /malformed Pi JSON event stream/iu);
  });
}

test("PiSubprocessCheckerRunner rejects schema-invalid JSONL records after a verdict", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const verdict = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [{ type: "text", text: '{"decision":"continue"}' }], stopReason: "stop" },
      });
      return { stdout: settledJsonl(`${verdict}\n{}\n`), stderr: "", code: 0, killed: false };
    },
  });
  await assert.rejects(() => runChecker(runner, DEFAULT_CONFIG), /malformed Pi JSON event stream/iu);
});

for (const malformedEvent of [
  { name: "agent_end without messages", event: { type: "agent_end", willRetry: false } },
  { name: "agent_end with a malformed nested message", event: { type: "agent_end", messages: [{ ...jsonAssistantMessage(), timestamp: "invalid" }], willRetry: false } },
  { name: "queue_update without queues", event: { type: "queue_update" } },
  { name: "session with invalid parentSession", event: { type: "session", id: "session-1", timestamp: "2026-07-19T00:00:00.000Z", cwd: "/tmp", parentSession: 42 } },
  { name: "thinking_level_changed with an unknown level", event: { type: "thinking_level_changed", level: "extreme" } },
  { name: "compaction_end with an invalid errorMessage", event: { type: "compaction_end", reason: "manual", aborted: false, willRetry: false, errorMessage: 42 } },
  { name: "compaction_end with a malformed result", event: { type: "compaction_end", reason: "manual", result: {}, aborted: false, willRetry: false } },
  { name: "compaction_end with invalid estimated tokens", event: { type: "compaction_end", reason: "manual", result: { summary: "summary", firstKeptEntryId: "entry-0", tokensBefore: 10, estimatedTokensAfter: "5" }, aborted: false, willRetry: false } },
  { name: "compaction_start with an invalid reason", event: { type: "compaction_start", reason: "automatic" } },
  { name: "entry_appended without an entry", event: { type: "entry_appended" } },
  { name: "entry_appended with a malformed message entry", event: { type: "entry_appended", entry: { type: "message", id: "entry-1", parentId: null, timestamp: "2026-07-19T00:00:00.000Z", message: {} } } },
  { name: "entry_appended with malformed custom message display", event: { type: "entry_appended", entry: { type: "custom_message", id: "entry-1", parentId: null, timestamp: "2026-07-19T00:00:00.000Z", customType: "test", content: "ok", display: "yes" } } },
  { name: "entry_appended with malformed label", event: { type: "entry_appended", entry: { type: "label", id: "entry-1", parentId: null, timestamp: "2026-07-19T00:00:00.000Z", targetId: "target", label: 42 } } },
  { name: "entry_appended with malformed hook marker", event: { type: "entry_appended", entry: { type: "compaction", id: "entry-1", parentId: null, timestamp: "2026-07-19T00:00:00.000Z", summary: "summary", firstKeptEntryId: "entry-0", tokensBefore: 10, fromHook: "yes" } } },
  { name: "entry_appended with malformed branch hook marker", event: { type: "entry_appended", entry: { type: "branch_summary", id: "entry-1", parentId: null, timestamp: "2026-07-19T00:00:00.000Z", fromId: "entry-0", summary: "summary", fromHook: "yes" } } },
  { name: "session_info_changed with an invalid name", event: { type: "session_info_changed", name: 42 } },
  { name: "auto_retry_start with an invalid attempt", event: { type: "auto_retry_start", attempt: "1", maxAttempts: 3, delayMs: 100, errorMessage: "retry" } },
  { name: "auto_retry_end with an invalid success flag", event: { type: "auto_retry_end", success: "yes", attempt: 1 } },
  { name: "auto_retry_end with an invalid final error", event: { type: "auto_retry_end", success: false, attempt: 1, finalError: 42 } },
  { name: "message_start without a message", event: { type: "message_start" } },
  { name: "message_start with a malformed message", event: { type: "message_start", message: {} } },
  { name: "message_update without an assistant event", event: { type: "message_update", message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [], stopReason: "stop" } } },
  { name: "message_update with a malformed assistant event", event: { type: "message_update", message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [], stopReason: "stop" }, assistantMessageEvent: {} } },
  { name: "turn_end without tool results", event: { type: "turn_end", message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [], stopReason: "stop" } } },
  { name: "turn_end with a malformed message", event: { type: "turn_end", message: {}, toolResults: [] } },
  { name: "turn_end with a malformed tool result", event: { type: "turn_end", message: jsonAssistantMessage(), toolResults: [{ role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: "invalid" }] } },
  { name: "message_start with malformed assistant content", event: { type: "message_start", message: { ...jsonAssistantMessage(), content: [{}] } } },
  { name: "message_start with invalid text signature", event: { type: "message_start", message: { ...jsonAssistantMessage([{ type: "text", text: "x", textSignature: 42 }]) } } },
  { name: "message_start with invalid thinking metadata", event: { type: "message_start", message: { ...jsonAssistantMessage([{ type: "thinking", thinking: "x", redacted: "yes" }]) } } },
  { name: "message_start with invalid thinking signature", event: { type: "message_start", message: { ...jsonAssistantMessage([{ type: "thinking", thinking: "x", thinkingSignature: 42 }]) } } },
  { name: "message_start with invalid tool thought signature", event: { type: "message_start", message: { ...jsonAssistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: {}, thoughtSignature: 42 }]) } } },
  { name: "message_start with malformed assistant usage", event: { type: "message_start", message: { ...jsonAssistantMessage(), usage: { ...JSON_ASSISTANT_FIELDS.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } } } },
  { name: "message_start with invalid assistant errorMessage", event: { type: "message_start", message: { ...jsonAssistantMessage(), errorMessage: 42 } } },
  { name: "message_start with invalid assistant responseModel", event: { type: "message_start", message: { ...jsonAssistantMessage(), responseModel: 42 } } },
  { name: "message_start with invalid assistant responseId", event: { type: "message_start", message: { ...jsonAssistantMessage(), responseId: 42 } } },
  { name: "message_start with invalid assistant diagnostics", event: { type: "message_start", message: { ...jsonAssistantMessage(), diagnostics: 42 } } },
  { name: "message_start with malformed assistant diagnostic item", event: { type: "message_start", message: { ...jsonAssistantMessage(), diagnostics: [{ type: 42, timestamp: 0 }] } } },
  { name: "message_start with invalid assistant reasoning usage", event: { type: "message_start", message: { ...jsonAssistantMessage(), usage: { ...JSON_ASSISTANT_FIELDS.usage, reasoning: "bad" } } } },
  { name: "message_start with invalid assistant cacheWrite1h usage", event: { type: "message_start", message: { ...jsonAssistantMessage(), usage: { ...JSON_ASSISTANT_FIELDS.usage, cacheWrite1h: "bad" } } } },
  { name: "message_start with invalid added tool names", event: { type: "message_start", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [], addedToolNames: [42], isError: false, timestamp: 0 } } },
  { name: "message_start with malformed bash timestamp", event: { type: "message_start", message: { role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, cancelled: false, truncated: false, timestamp: "invalid" } } },
  { name: "message_start with malformed bash optional fields", event: { type: "message_start", message: { role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, cancelled: false, truncated: false, fullOutputPath: 42, excludeFromContext: "yes", timestamp: 0 } } },
  { name: "message_start with malformed compaction timestamp", event: { type: "message_start", message: { role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: "invalid" } } },
  { name: "message_start with a malformed tool result", event: { type: "message_start", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [], isError: false } } },
  { name: "message_start with malformed image content", event: { type: "message_start", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "image", data: "base64", mimeType: 42 }], isError: false, timestamp: 0 } } },
  { name: "message_update with an invalid text delta", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: 42, partial: jsonAssistantMessage() } } },
  { name: "message_update with a malformed text partial", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: { ...jsonAssistantMessage(), timestamp: "invalid" } } } },
  { name: "message_update with an invalid tool call", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { id: "call-1", name: "read", arguments: {} }, partial: jsonAssistantMessage() } } },
  { name: "message_update with an invalid tool call signature", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {}, thoughtSignature: 42 }, partial: jsonAssistantMessage() } } },
  { name: "message_update with a malformed tool call partial", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: {} }, partial: { ...jsonAssistantMessage(), timestamp: "invalid" } } } },
  { name: "message_update with an invalid done reason", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "done", reason: "error", message: jsonAssistantMessage() } } },
  { name: "message_update with malformed done output", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "done", reason: "stop", message: { ...jsonAssistantMessage(), timestamp: "invalid" } } } },
  { name: "message_update with malformed error output", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "error", reason: "error", error: { ...jsonAssistantMessage([], "error"), timestamp: "invalid" } } } },
  { name: "message_update with malformed thinking end partial", event: { type: "message_update", message: jsonAssistantMessage(), assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "done", partial: { ...jsonAssistantMessage(), timestamp: "invalid" } } } },
  { name: "tool_execution_start without args", event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read" } },
  { name: "tool_execution_update without a partial result", event: { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: {} } },
  { name: "tool_execution_end without isError", event: { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {} } },
]) {
  test(`PiSubprocessCheckerRunner rejects ${malformedEvent.name} after a verdict`, async () => {
    const runner = new PiSubprocessCheckerRunner({
      async exec() {
        const verdict = JSON.stringify({
          type: "message_end",
          message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [{ type: "text", text: '{"decision":"continue"}' }], stopReason: "stop" },
        });
        return { stdout: settledJsonl(`${verdict}\n${JSON.stringify(malformedEvent.event)}\n`), stderr: "", code: 0, killed: false };
      },
    });

    await assert.rejects(
      () => runChecker(runner, DEFAULT_CONFIG),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /malformed Pi JSON event stream/iu);
        assert.match(error.message, /malformed recognized event envelope/iu);
        assert.doesNotMatch(error.message, /returned an invalid verdict/iu);
        return true;
      },
    );
  });
}

test("PiSubprocessCheckerRunner accepts current recognized event envelopes after a verdict", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const assistant = jsonAssistantMessage();
      const verdict = {
        type: "message_end",
        message: { ...assistant, content: [{ type: "text", text: '{"decision":"continue"}' }] },
      };
      const toolCall = { type: "toolCall", id: "call-1", name: "read", arguments: {}, thoughtSignature: "thought" };
      const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "ok" }, { type: "image", data: "base64", mimeType: "image/png" }], addedToolNames: ["read"], isError: false, timestamp: 0 };
      const thinkingAssistant = jsonAssistantMessage([{ type: "thinking", thinking: "inspect", thinkingSignature: "thinking", redacted: false }, toolCall]);
      const errorAssistant = jsonAssistantMessage([], "error");
      const userMessage = { role: "user", content: "inspect", timestamp: 0 };
      const bashMessage = { role: "bashExecution", command: "pwd", output: "/tmp", exitCode: 0, cancelled: false, truncated: false, fullOutputPath: "/tmp/full", excludeFromContext: false, timestamp: 0 };
      const branchMessage = { role: "branchSummary", summary: "summary", fromId: "entry-0", timestamp: 0 };
      const compactionMessage = { role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: 0 };
      const entryBase = { id: "entry-1", parentId: null, timestamp: "2026-07-19T00:00:00.000Z" };
      const events = [
        { type: "agent_start" },
        { type: "turn_start" },
        { type: "message_start", message: assistant },
        { type: "message_start", message: userMessage },
        { type: "message_start", message: toolResult },
        { type: "message_start", message: bashMessage },
        { type: "message_start", message: branchMessage },
        { type: "message_start", message: compactionMessage },
        { type: "message_start", message: { role: "custom", customType: "note", content: "ok", display: false, timestamp: 0 } },
        { type: "message_start", message: thinkingAssistant },
        { type: "message_update", message: assistant, assistantMessageEvent: { type: "start", partial: assistant } },
        { type: "message_update", message: assistant, assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistant } },
        { type: "message_update", message: thinkingAssistant, assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: thinkingAssistant } },
        { type: "message_update", message: thinkingAssistant, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: thinkingAssistant } },
        { type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: assistant } },
        { type: "message_update", message: thinkingAssistant, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x", partial: thinkingAssistant } },
        { type: "message_update", message: thinkingAssistant, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "x", partial: thinkingAssistant } },
        { type: "message_update", message: assistant, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "done", partial: assistant } },
        { type: "message_update", message: thinkingAssistant, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "done", partial: thinkingAssistant } },
        { type: "message_update", message: thinkingAssistant, assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall, partial: thinkingAssistant } },
        { type: "message_update", message: assistant, assistantMessageEvent: { type: "done", reason: "stop", message: assistant } },
        { type: "message_update", message: errorAssistant, assistantMessageEvent: { type: "error", reason: "error", error: errorAssistant } },
        { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} },
        { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: {}, partialResult: null },
        { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false },
        { type: "turn_end", message: assistant, toolResults: [toolResult] },
        { type: "queue_update", steering: [], followUp: [] },
        { type: "compaction_start", reason: "manual" },
        { type: "entry_appended", entry: { ...entryBase, type: "message", message: userMessage } },
        { type: "entry_appended", entry: { ...entryBase, type: "thinking_level_change", thinkingLevel: "high" } },
        { type: "entry_appended", entry: { ...entryBase, type: "model_change", provider: "openai", modelId: "gpt-test" } },
        { type: "entry_appended", entry: { ...entryBase, type: "compaction", summary: "summary", firstKeptEntryId: "entry-0", tokensBefore: 10, fromHook: true } },
        { type: "entry_appended", entry: { ...entryBase, type: "branch_summary", fromId: "entry-0", summary: "summary", fromHook: true } },
        { type: "entry_appended", entry: { ...entryBase, type: "custom", customType: "test" } },
        { type: "entry_appended", entry: { ...entryBase, type: "custom_message", customType: "test", content: "ok", display: false } },
        { type: "entry_appended", entry: { ...entryBase, type: "label", targetId: "entry-0", label: "label" } },
        { type: "entry_appended", entry: { ...entryBase, type: "session_info", name: "name" } },
        { type: "session_info_changed" },
        { type: "thinking_level_changed", level: "high" },
        { type: "compaction_end", reason: "manual", aborted: false, willRetry: false },
        { type: "compaction_end", reason: "manual", result: { summary: "summary", firstKeptEntryId: "entry-0", tokensBefore: 10 }, aborted: false, willRetry: false, errorMessage: "safe compaction failure" },
        { type: "compaction_end", reason: "manual", result: { summary: "summary", firstKeptEntryId: "entry-0", tokensBefore: 10, estimatedTokensAfter: 5 }, aborted: false, willRetry: false },
        { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: "retry" },
        { type: "auto_retry_end", success: true, attempt: 1 },
        { type: "agent_end", messages: [assistant], willRetry: false },
        { type: "agent_settled" },
      ];
      return {
        stdout: [verdict, ...events].map((event) => JSON.stringify(event)).join("\n"),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  assert.equal((await runCheckerVerdict(runner, DEFAULT_CONFIG)).decision, "continue");
});

test("PiSubprocessCheckerRunner rejects a valid event stream without assistant message_end", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      return {
        stdout: [
          JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-07-19T00:00:00.000Z", cwd: "/tmp" }),
          JSON.stringify({ type: "agent_start" }),
          JSON.stringify({ type: "turn_start" }),
          JSON.stringify({ type: "agent_end", messages: [], willRetry: false }),
          JSON.stringify({ type: "agent_settled" }),
        ].join("\n"),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ended without an assistant message_end/iu);
      assert.doesNotMatch(error.message, /checker did not return a JSON object/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner always uses audit-only tools with skills enabled", async () => {
  assertAuditOnlyCheckerArgs(await captureCheckerArgs(DEFAULT_CONFIG));
});

test("PiSubprocessCheckerRunner includes explicit model bootstrap extensions without expanding checker tools", async () => {
  const capturedArgs = await captureCheckerArgs(DEFAULT_CONFIG, {
    checkerModelBootstrapPaths: ["/tmp/model-aliases.ts", "  ", "/tmp/model-aliases.ts", "/tmp/other-bootstrap.ts"],
    model: {
      id: "gpt-5.5-1m",
      name: "GPT 5.5 1M",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    },
    thinkingLevel: "xhigh",
  });

  const extensionIndexes = capturedArgs.flatMap((arg, index) => (arg === "-e" ? [index] : []));
  assert.deepEqual(extensionIndexes.map((index) => capturedArgs[index + 1]), ["/tmp/model-aliases.ts", "/tmp/other-bootstrap.ts"]);
  assert.ok(extensionIndexes.every((index) => index > capturedArgs.indexOf("--no-extensions")), "bootstrap paths are explicit exceptions after --no-extensions");
  assert.ok(extensionIndexes.every((index) => index < capturedArgs.length - 1), "bootstrap paths stay before the checker prompt");
  assert.equal(capturedArgs[capturedArgs.indexOf("--model") + 1], "openai/gpt-5.5-1m");
  assert.equal(capturedArgs[capturedArgs.indexOf("--thinking") + 1], "xhigh");
  assertAuditOnlyCheckerArgs(capturedArgs);
});

test("removed checker capability config cannot expand audit-only subprocess tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-controller-checker-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ checker: { toolMode: "full" } }));

  const loaded = loadConfig(configPath);
  assert.match(loaded.warning ?? "", /checker\.toolMode is no longer supported/iu);
  assertAuditOnlyCheckerArgs(await captureCheckerArgs(loaded.config));
});

test("PiSubprocessCheckerRunner wraps exec rejections with requested-model and redacted diagnostics", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      throw new Error('spawn failed; passphrase="correct horse battery staple"');
    },
  });
  const config: GoalControllerConfig = {
    ...DEFAULT_CONFIG,
    checker: { ...DEFAULT_CONFIG.checker, model: "sonnet" },
  };

  await assert.rejects(
    () => runChecker(runner, config),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /could not start or complete/iu);
      assert.match(error.message, /requestedModel=sonnet/iu);
      assert.match(error.message, /checker process could not be launched/iu);
      assert.doesNotMatch(error.message, /spawn failed/iu);
      assert.doesNotMatch(error.message, /correct horse battery staple/u);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner reports killed subprocesses as timeout or termination failures", async () => {
  const config: GoalControllerConfig = { ...DEFAULT_CONFIG, checker: { ...DEFAULT_CONFIG.checker, timeoutMs: 1 } };
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { stdout: "partial checker output", stderr: "", code: 143, killed: true };
    },
  });

  await assert.rejects(
    () => runChecker(runner, config),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /timed out|terminated/iu);
      assert.match(error.message, /timeoutMs=1/iu);
      assert.match(error.message, /Exit code: 143/iu);
      assert.match(error.message, /No checker verdict was returned/iu);
      assert.match(error.message, /Checker config: model=inherit, thinking=inherit/iu);
      assert.doesNotMatch(error.message, /partial checker output/iu);
      assert.doesNotMatch(error.message, /stdout tail/iu);
      assert.doesNotMatch(error.message, /^checker subprocess exited with code 143$/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner treats killed=true as failure even when Pi normalizes the exit code to zero", async () => {
  const config: GoalControllerConfig = { ...DEFAULT_CONFIG, checker: { ...DEFAULT_CONFIG.checker, timeoutMs: 1 } };
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        stdout: settledJsonl(JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant", ...JSON_ASSISTANT_FIELDS,
            content: [{ type: "text", text: '{"decision":"complete","complete":true}' }],
          },
        })),
        stderr: "",
        code: 0,
        killed: true,
      };
    },
  });

  await assert.rejects(
    () => runChecker(runner, config),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /timed out|terminated/iu);
      assert.match(error.message, /Exit code: 0/iu);
      assert.match(error.message, /No checker verdict was returned/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner preserves structured diagnostics for non-killed failures without raw JSONL", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const stdout = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", ...JSON_ASSISTANT_FIELDS, content: [], stopReason: "error", errorMessage: "provider quota exhausted" },
      });
      return { stdout, stderr: "stderr clue", code: 7, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited with code 7/iu);
      assert.match(error.message, /Stderr classification: Checker process execution failed/iu);
      assert.match(error.message, /Assistant stop reason: error/iu);
      assert.match(error.message, /Provider classification: The provider reported a rate-limit or quota failure/iu);
      assert.doesNotMatch(error.message, /stderr clue/iu);
      assert.doesNotMatch(error.message, /provider quota exhausted/iu);
      assert.match(error.message, /No checker verdict was returned/iu);
      assert.doesNotMatch(error.message, /\{"type":"message_end"/u);
      assert.doesNotMatch(error.message, /timed out/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner redacts secrets from checker subprocess diagnostics", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      return {
        stdout: "apiKey=sk-livesecretstdout00000 in stdout",
        stderr: "[model-aliases] load failed for /tmp/model-aliases/checker-bootstrap.ts\nAuthorization: Bearer sk-topsecretbearer1234567890\napiKey: sk-anothersecretkey0987654321",
        code: 1,
        killed: false,
      };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited with code 1/iu);
      assert.match(error.message, /Stderr classification: Checker process authentication or authorization failed/iu);
      assert.doesNotMatch(error.message, /checker-bootstrap\.ts/iu);
      assert.doesNotMatch(error.message, /sk-[A-Za-z0-9_-]{8,}/u);
      assert.doesNotMatch(error.message, /Bearer\s+sk-/iu);
      assert.doesNotMatch(error.message, /azuresecret|anothersecret|topsecret/iu);
      return true;
    },
  );
});

test("redactSecrets scrubs common secret carriers while preserving surrounding text", () => {
  assert.equal(redactSecrets("apiKey=sk-abcdef123456"), "apiKey=[REDACTED]");
  assert.equal(redactSecrets('"api_key": "sk-abcdef123456"'), '"api_key": "[REDACTED]"');
  assert.equal(redactSecrets('apiKey="abc def,ghi"'), 'apiKey="[REDACTED]"');
  assert.equal(redactSecrets("passphrase='correct horse battery staple'"), "passphrase='[REDACTED]'");
  assert.equal(redactSecrets('apiKey="unterminated secret'), 'apiKey="[REDACTED]');
  assert.equal(redactSecrets("token='unterminated secret"), "token='[REDACTED]");
  assert.equal(redactSecrets(String.raw`apiKey="unterminated\" secret`), 'apiKey="[REDACTED]');
  assert.equal(redactSecrets(String.raw`token='unterminated\' secret`), "token='[REDACTED]");
  assert.equal(redactSecrets('apiKey="unterminated secret' + "\\"), 'apiKey="[REDACTED]');
  assert.equal(redactSecrets("token='unterminated secret" + "\\"), "token='[REDACTED]");
  assert.equal(redactSecrets("token: abc,def"), "token: [REDACTED]");
  assert.equal(redactSecrets("passphrase=correct horse battery staple"), "passphrase=[REDACTED]");
  assert.equal(redactSecrets("token: alpha beta gamma"), "token: [REDACTED]");
  assert.equal(
    redactSecrets("request failed token=alpha beta gamma; retrying in 5s"),
    "request failed token=[REDACTED]; retrying in 5s",
  );
  assert.equal(redactSecrets("token=alpha beta gamma status=503"), "token=[REDACTED] status=503");
  assert.equal(redactSecrets("token=abc, retrying in 5s"), "token=[REDACTED], retrying in 5s");
  assert.equal(redactSecrets("token=abc. retrying"), "token=[REDACTED]. retrying");
  assert.equal(redactSecrets("mytoken=public"), "mytoken=public");
  assert.equal(redactSecrets("not_token=public"), "not_token=public");
  assert.equal(redactSecrets("Authorization: Bearer sk-abcdef123456"), "Authorization: Bearer [REDACTED]");
  assert.equal(redactSecrets("loaded /tmp/checker-bootstrap.ts fine"), "loaded /tmp/checker-bootstrap.ts fine");
});

test("redactSecrets scrubs single-quoted util.inspect config and non-sk secrets", () => {
  // Node's util.inspect (backing console.log(obj) and inlined error objects)
  // defaults to single-quoted strings, which must not leak.
  assert.equal(redactSecrets("apiKey: 'azuresecret123456'"), "apiKey: '[REDACTED]'");
  assert.equal(redactSecrets("password: 'hunter2hunter2'"), "password: '[REDACTED]'");
  const inspected = redactSecrets("{ apiKey: 'gsk_live_abc123def', headers: { 'x-api-key': 'plain_secret_1' } }");
  assert.doesNotMatch(inspected, /gsk_live_abc123def/u);
  assert.doesNotMatch(inspected, /plain_secret_1/u);
  assert.match(inspected, /\[REDACTED\]/u);
  // Basic auth credentials (base64, no sk- prefix) are still scrubbed.
  assert.equal(redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA=="), "Authorization: Basic [REDACTED]");
  // Ordinary prose containing scheme-like words is left intact.
  assert.equal(redactSecrets("basic validation failed for token refresh path"), "basic validation failed for token refresh path");
});

async function captureCheckerArgs(config: GoalControllerConfig, overrides: Partial<Pick<CheckerRunInput, "checkerModelBootstrapPaths" | "model" | "thinkingLevel">> = {}): Promise<string[]> {
  let capturedArgs: string[] = [];
  const runner = new PiSubprocessCheckerRunner({
    async exec(_command, args) {
      capturedArgs = args;
      return {
        stdout: settledJsonl(JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant", ...JSON_ASSISTANT_FIELDS,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  decision: "complete",
                  complete: true,
                  reason: "all requirements proven",
                  evidence: ["fake evidence"],
                  requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake evidence" }],
                }),
              },
            ],
            stopReason: "stop",
          },
        }) + "\n"),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  await runChecker(runner, config, overrides);
  return capturedArgs;
}

async function runCheckerVerdict(
  runner: PiSubprocessCheckerRunner,
  config: GoalControllerConfig,
  overrides: Partial<Pick<CheckerRunInput, "checkerModelBootstrapPaths" | "model" | "thinkingLevel">> = {},
) {
  return runner.run({
    goal: createGoal("fake goal", config, 0),
    context: checkerContext(undefined),
    config,
    cwd: "/tmp",
    model: undefined,
    thinkingLevel: "off",
    ...overrides,
  });
}

async function runChecker(
  runner: PiSubprocessCheckerRunner,
  config: GoalControllerConfig,
  overrides: Partial<Pick<CheckerRunInput, "checkerModelBootstrapPaths" | "model" | "thinkingLevel">> = {},
): Promise<void> {
  await runCheckerVerdict(runner, config, overrides);
}

test("checker sessions land in the parent's sidecar dir, and fall back to no session without a parent", async () => {
  const captured: string[][] = [];
  const runner = new PiSubprocessCheckerRunner({
    exec: async (_cmd: string, args: string[]) => {
      captured.push(args);
      return {
        stdout: settledJsonl(JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant", ...JSON_ASSISTANT_FIELDS,
            content: [{ type: "text", text: JSON.stringify({ decision: "complete", complete: true, reason: "all requirements proven", evidence: ["fake evidence"], requirements: [{ requirement: "fake requirement", status: "satisfied", evidence: "fake evidence" }] }) }],
            stopReason: "stop",
          },
        })),
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });
  const base = {
    goal: createGoal("fake goal", DEFAULT_CONFIG, 0),
    context: checkerContext("/tmp/pi-session.jsonl"),
    config: DEFAULT_CONFIG,
    cwd: "/tmp",
    model: undefined,
    thinkingLevel: "off" as const,
    checkerModelBootstrapPaths: [],
  };

  // Derived, not hardcoded: a drift in this package's copy of the convention must
  // break the test rather than pass a stale literal.
  const parentSessionFile = "/sessions/--proj--/2026-07-28T08-04-15-096Z_019fa7c0.jsonl";
  const derived = deriveChildSessionDir(parentSessionFile, CHECKER_SESSION_KIND);
  assert.equal(derived, "/sessions/--proj--/2026-07-28T08-04-15-096Z_019fa7c0/goal-checker");

  await runner.run({ ...base, sessionDir: derived });
  await runner.run({ ...base });

  assert.equal(captured[0]?.[captured[0].indexOf("--session-dir") + 1], derived);
  assert.equal(captured[0]?.includes("--no-session"), false);
  assert.equal(captured[1]?.includes("--no-session"), true, "no parent session means nothing to attach the spend to");
  assert.equal(captured[1]?.includes("--session-dir"), false);
  // Persisting must not weaken the audit-only profile.
  for (const args of captured) assertAuditOnlyCheckerArgs(args);
});

test("a checker run that fails still leaves its session behind for cost accounting", async () => {
  const captured: string[][] = [];
  const runner = new PiSubprocessCheckerRunner({
    exec: async (_cmd: string, args: string[]) => {
      captured.push(args);
      // Ran, burned tokens, then errored out with no usable verdict.
      return { stdout: "", stderr: "boom", code: 1, killed: false };
    },
  });
  await assert.rejects(
    runner.run({
      goal: createGoal("fake goal", DEFAULT_CONFIG, 0),
      context: checkerContext("/tmp/pi-session.jsonl"),
      config: DEFAULT_CONFIG,
      cwd: "/tmp",
      model: undefined,
      thinkingLevel: "off",
      checkerModelBootstrapPaths: [],
      sessionDir: deriveChildSessionDir("/sessions/--proj--/2026-07-28T08-04-15-096Z_019fa7c0.jsonl", CHECKER_SESSION_KIND),
    }),
  );
  // The failure path does not remove or bypass the session, so whatever the run
  // already wrote stays countable.
  assert.equal(
    captured[0]?.[captured[0].indexOf("--session-dir") + 1],
    "/sessions/--proj--/2026-07-28T08-04-15-096Z_019fa7c0/goal-checker",
  );
  assert.equal(captured[0]?.includes("--no-session"), false);
});

test("the checker sidecar convention is pinned, and absent when the parent has no session", () => {
  // Same layout the cost scanner walks and pi-subagents already writes `tasks/` into.
  assert.equal(
    deriveChildSessionDir("/Users/x/.pi/agent/sessions/--proj--/2026-07-28T08-04-15Z_019fa7c0.jsonl", CHECKER_SESSION_KIND),
    "/Users/x/.pi/agent/sessions/--proj--/2026-07-28T08-04-15Z_019fa7c0/goal-checker",
  );
  assert.equal(deriveChildSessionDir(undefined, CHECKER_SESSION_KIND), undefined);
});
