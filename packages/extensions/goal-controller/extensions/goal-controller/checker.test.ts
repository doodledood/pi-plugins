import test from "node:test";
import assert from "node:assert/strict";
import { parseCheckerVerdict, PiSubprocessCheckerRunner } from "./checker.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { createGoal } from "./controller.ts";
import type { GoalControllerConfig } from "./types.ts";

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
    transcript: "assistant: fake evidence",
    config: DEFAULT_CONFIG,
    cwd: "/tmp",
    sessionFile: "/tmp/pi-session.jsonl",
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
  assert.equal(capturedArgs.includes("--no-extensions"), true);
  assert.equal(capturedArgs.includes("--no-builtin-tools"), false);
  assert.equal(capturedArgs.includes("--tools"), false);
  assert.equal(capturedArgs.includes("--exclude-tools"), true);
  assert.equal(capturedArgs[capturedArgs.indexOf("--exclude-tools") + 1], "edit,write");
  const checkerPrompt = capturedArgs.at(-1) ?? "";
  assert.match(checkerPrompt, /Current Pi session file path:\n\/tmp\/pi-session\.jsonl/iu);
  assert.match(checkerPrompt, /Tool availability is controlled by checker\.toolMode/iu);
  assert.match(checkerPrompt, /you may use them to inspect evidence needed for judgment/iu);
  assert.match(checkerPrompt, /Do not use checker-side tools to perform omitted primary success work on the worker's behalf/iu);
});

test("PiSubprocessCheckerRunner maps transcript and full tool modes to subprocess args", async () => {
  const transcriptArgs = await captureCheckerArgs({ ...DEFAULT_CONFIG, checker: { ...DEFAULT_CONFIG.checker, toolMode: "transcript" } });
  assert.equal(transcriptArgs.includes("--no-tools"), true);
  assert.equal(transcriptArgs.includes("--no-extensions"), true);
  assert.equal(transcriptArgs.includes("--exclude-tools"), false);

  const fullArgs = await captureCheckerArgs({ ...DEFAULT_CONFIG, checker: { ...DEFAULT_CONFIG.checker, toolMode: "full" } });
  assert.equal(fullArgs.includes("--no-tools"), false);
  assert.equal(fullArgs.includes("--exclude-tools"), false);
  assert.equal(fullArgs.includes("--no-extensions"), false);
});

async function captureCheckerArgs(config: GoalControllerConfig): Promise<string[]> {
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

  await runner.run({
    goal: createGoal("fake goal", config, 0),
    transcript: "assistant: fake evidence",
    config,
    cwd: "/tmp",
    sessionFile: undefined,
    model: undefined,
    thinkingLevel: "off",
  });
  return capturedArgs;
}
