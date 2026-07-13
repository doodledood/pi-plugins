import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCheckerVerdict, PiSubprocessCheckerRunner, redactSecrets, type CheckerRunInput } from "./checker.ts";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";
import { createGoal } from "./controller.ts";
import type { CheckerSessionContext, GoalControllerConfig } from "./types.ts";

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
  const verdict = parseCheckerVerdict('{"complete":true,"reason":"tests pass","evidence":["npm test exited 0"],"requirements":[{"requirement":"tests pass","status":"satisfied","evidence":"npm test exited 0"}]}');
  assert.equal(verdict.decision, "complete");
  assert.equal(verdict.complete, true);
  assert.equal(verdict.reason, "tests pass");
  assert.deepEqual(verdict.evidence, ["npm test exited 0"]);
  assert.equal(verdict.requirements?.[0]?.status, "satisfied");
});

test("parseCheckerVerdict parses fenced JSON and requirements", () => {
  const verdict = parseCheckerVerdict(`\n\`\`\`json\n{"complete":false,"blocked":true,"reason":"missing creds","nextTurnGuidance":"ask user","unmetRequirements":["run e2e"],"requirements":[{"requirement":"run e2e","status":"unsatisfied","evidence":"no credentials"}]}\n\`\`\``);
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

test("parseCheckerVerdict rejects complete verdict without evidence and requirement assessment", () => {
  assert.throws(() => parseCheckerVerdict('{"complete":true}'), /evidence|requirement/iu);
  assert.throws(
    () => parseCheckerVerdict('{"complete":true,"evidence":["test"],"requirements":[{"requirement":"lint","status":"unclear"}]}'),
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
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
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
          },
        }) + "\n",
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
  });

  assert.equal(verdict.complete, true);
  assert.equal(capturedCommand, "pi");
  assert.equal(capturedArgs.includes("--model"), true);
  assert.equal(capturedArgs[capturedArgs.indexOf("--model") + 1], "openai/gpt-5.5");
  assert.equal(capturedArgs.includes("--thinking"), true);
  assert.equal(capturedArgs[capturedArgs.indexOf("--thinking") + 1], "xhigh");
  assert.equal(capturedArgs.includes("--no-session"), true);
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
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{
              type: "text",
              text: JSON.stringify({
                decision: "continue",
                complete: false,
                reason: "more work remains",
              }),
            }],
          },
        }) + "\n",
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
        message: { role: "assistant", content: [{ type: "text", text: jsonVerdict }] },
      });
      const trailingProse = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Verification summary: everything looks done to me." }] },
      });
      return { stdout: `${verdictMessage}\n${trailingProse}\n`, stderr: "", code: 0, killed: false };
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

test("PiSubprocessCheckerRunner surfaces the informative parse error when the checker emits only prose", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      const proseOnly = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Verification summary: looks complete to me." }] },
      });
      return { stdout: `${proseOnly}\n`, stderr: "", code: 0, killed: false };
    },
  });

  await assert.rejects(() => runChecker(runner, DEFAULT_CONFIG), /checker did not return a JSON object/iu);
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
      assert.match(error.message, /stdout tail:\npartial checker output/iu);
      assert.doesNotMatch(error.message, /^checker subprocess exited with code 143$/iu);
      return true;
    },
  );
});

test("PiSubprocessCheckerRunner preserves exit-code and output diagnostics for non-killed failures", async () => {
  const runner = new PiSubprocessCheckerRunner({
    async exec() {
      return { stdout: "stdout clue", stderr: "stderr clue", code: 7, killed: false };
    },
  });

  await assert.rejects(
    () => runChecker(runner, DEFAULT_CONFIG),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exited with code 7/iu);
      assert.match(error.message, /stderr:\nstderr clue/iu);
      assert.match(error.message, /stdout tail:\nstdout clue/iu);
      assert.match(error.message, /No checker verdict was returned/iu);
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
      // Operational diagnostics survive so the failure is diagnosable...
      assert.match(error.message, /exited with code 1/iu);
      assert.match(error.message, /checker-bootstrap\.ts/iu);
      // ...but no secret material leaks into persisted/notified checker state.
      assert.doesNotMatch(error.message, /sk-[A-Za-z0-9_-]{8,}/u);
      assert.doesNotMatch(error.message, /Bearer\s+sk-/iu);
      assert.match(error.message, /\[REDACTED\]/u);
      return true;
    },
  );
});

test("redactSecrets scrubs common secret carriers while preserving surrounding text", () => {
  assert.equal(redactSecrets("apiKey=sk-abcdef123456"), "apiKey=[REDACTED]");
  assert.equal(redactSecrets('"api_key": "sk-abcdef123456"'), '"api_key": "[REDACTED]"');
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
        stdout: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
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
          },
        }) + "\n",
        stderr: "",
        code: 0,
        killed: false,
      };
    },
  });

  await runChecker(runner, config, overrides);
  return capturedArgs;
}

async function runChecker(
  runner: PiSubprocessCheckerRunner,
  config: GoalControllerConfig,
  overrides: Partial<Pick<CheckerRunInput, "checkerModelBootstrapPaths" | "model" | "thinkingLevel">> = {},
): Promise<void> {
  await runner.run({
    goal: createGoal("fake goal", config, 0),
    context: checkerContext(undefined),
    config,
    cwd: "/tmp",
    model: undefined,
    thinkingLevel: "off",
    ...overrides,
  });
}
