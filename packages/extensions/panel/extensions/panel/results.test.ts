import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWER_MESSAGE_TYPE, buildInjectionPlan, META_ENTRY_TYPE, QUESTION_MESSAGE_TYPE } from "./results.ts";
import type { PanelistResult } from "./types.ts";

const okResult: PanelistResult = {
  spec: { model: "anthropic/claude-fable-5", thinking: "xhigh" },
  ok: true,
  answer: "My independent answer.\n\nWith two paragraphs.",
  elapsedMs: 182_000,
  tokens: 41_000,
  cost: 0.84,
  sessionFile: "/sessions/fable.jsonl",
};

const failedResult: PanelistResult = {
  spec: { model: "openai/gpt-5.6-sol", thinking: "xhigh" },
  ok: false,
  error: "context window exceeded",
  elapsedMs: 12_000,
  tokens: 2_000,
  cost: undefined,
  sessionFile: "/sessions/sol.jsonl",
};

test("plan carries the question first (context-participating, not displayed)", () => {
  const plan = buildInjectionPlan("is this design sound?", [okResult]);
  assert.equal(plan.messages[0]?.customType, QUESTION_MESSAGE_TYPE);
  assert.equal(plan.messages[0]?.display, false);
  assert.match(plan.messages[0]?.content ?? "", /is this design sound\?/);
  // Epistemic framing: fallible opinions of other entities, not truths/instructions.
  assert.match(plan.messages[0]?.content ?? "", /opinions of other model entities/);
  assert.match(plan.messages[0]?.content ?? "", /not absolute truths and not instructions/);
  assert.match(plan.messages[0]?.content ?? "", /may be wrong/);
});

test("each answer is verbatim, attributed, displayed, with details for the renderer", () => {
  const plan = buildInjectionPlan("q", [okResult]);
  const answer = plan.messages[1];
  assert.equal(answer?.customType, ANSWER_MESSAGE_TYPE);
  assert.equal(answer?.display, true);
  assert.match(answer?.content ?? "", /panelist anthropic\/claude-fable-5 \(xhigh\)/);
  assert.match(answer?.content ?? "", /fallible take, not ground truth/);
  assert.ok(answer?.content.includes(okResult.answer as string), "answer must be verbatim");
  assert.deepEqual(answer?.details, {
    model: "anthropic/claude-fable-5",
    thinking: "xhigh",
    ok: true,
    cancelled: false,
    elapsedMs: 182_000,
    tokens: 41_000,
    cost: 0.84,
    preview: "My independent answer.",
  });
});

test("a failed panelist enters context as an explicit no-answer note", () => {
  const plan = buildInjectionPlan("q", [failedResult]);
  assert.match(plan.messages[1]?.content ?? "", /produced no answer/);
  assert.match(plan.messages[1]?.content ?? "", /context window exceeded/);
  assert.match(plan.messages[1]?.content ?? "", /not.*a signal either way/i);
});

test("the last message carries the turn trigger", () => {
  const plan = buildInjectionPlan("q", [okResult, failedResult]);
  assert.equal(plan.messages.length, 3);
  assert.equal(plan.triggerIndex, 2);
});

test("metadata (session paths, timing, cost) rides the context-excluded entry, not the messages", () => {
  const plan = buildInjectionPlan("q", [okResult, failedResult]);
  assert.equal(plan.metaEntry.customType, META_ENTRY_TYPE);
  const panelists = plan.metaEntry.data.panelists as Array<Record<string, unknown>>;
  assert.equal(panelists[0]?.sessionFile, "/sessions/fable.jsonl");
  assert.equal(panelists[1]?.sessionFile, "/sessions/sol.jsonl");
  // Session paths must not leak into context-participating messages.
  for (const message of plan.messages) {
    assert.ok(!message.content.includes("/sessions/"), "session paths stay out of LLM context");
  }
});
