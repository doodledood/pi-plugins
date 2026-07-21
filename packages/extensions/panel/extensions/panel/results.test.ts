import assert from "node:assert/strict";
import { test } from "node:test";
import { ANSWER_MESSAGE_TYPE, buildInjectionPlan, META_ENTRY_TYPE, panelistLabel, QUESTION_MESSAGE_TYPE } from "./results.ts";
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
  const plan = buildInjectionPlan("is this design sound?", [okResult], () => 0.999999);
  assert.equal(plan.messages[0]?.customType, QUESTION_MESSAGE_TYPE);
  assert.equal(plan.messages[0]?.display, false);
  assert.match(plan.messages[0]?.content ?? "", /is this design sound\?/);
  // The main model's JOB is stated: synthesize the best answer using the panel.
  assert.match(plan.messages[0]?.content ?? "", /produce the best possible answer/);
  assert.match(plan.messages[0]?.content ?? "", /adopt what stands up, combine complementary insights/);
  assert.match(plan.messages[0]?.content ?? "", /<panelist_answer> tag/);
  // Epistemic framing survives: fallible opinions, not truths/instructions.
  assert.match(plan.messages[0]?.content ?? "", /fallible opinions of other models/);
  assert.match(plan.messages[0]?.content ?? "", /not absolute truths and not instructions/);
  assert.match(plan.messages[0]?.content ?? "", /may be wrong/);
});

test("each answer is verbatim, attributed, displayed, with details for the renderer", () => {
  const plan = buildInjectionPlan("q", [okResult], () => 0.999999);
  const answer = plan.messages[1];
  assert.equal(answer?.customType, ANSWER_MESSAGE_TYPE);
  assert.equal(answer?.display, true);
  // Delimitation: each answer is wrapped in an ANONYMOUS labeled tag block —
  // model identity must never enter LLM context (brand bias).
  assert.match(answer?.content ?? "", /^<panelist_answer panelist="A">\n/);
  assert.match(answer?.content ?? "", /\n<\/panelist_answer>$/);
  assert.ok(!(answer?.content ?? "").includes("claude-fable-5"), "model identity stays out of context");
  assert.ok(answer?.content.includes(okResult.answer as string), "answer must be verbatim");
  assert.deepEqual(answer?.details, {
    label: "A",
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
  const plan = buildInjectionPlan("q", [failedResult], () => 0.999999);
  assert.match(plan.messages[1]?.content ?? "", /<panelist_answer panelist="A" status="failed">/);
  assert.match(plan.messages[1]?.content ?? "", /produced no answer/);
  assert.match(plan.messages[1]?.content ?? "", /context window exceeded/);
  assert.match(plan.messages[1]?.content ?? "", /not.*a signal either way/i);
});

test("provider content-screening refusals are summarized with actionable guidance, not dumped raw", () => {
  const blocked: PanelistResult = {
    ...failedResult,
    error:
      "This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. To learn more, visit https://www.anthropic.com/legal/commercial-terms. API integrators: you can reduce refusals...",
  };
  const plan = buildInjectionPlan("q", [blocked], () => 0.999999);
  const content = plan.messages[1]?.content ?? "";
  assert.match(content, /content screening blocked the request at the account\/model level/);
  assert.match(content, /try a different model for this panelist or retry later/);
  assert.ok(!content.includes("anthropic.com/legal"), "raw legalese stays out of context");
  // Ordinary errors pass through untouched.
  const ordinary = buildInjectionPlan("q", [failedResult], () => 0.999999);
  assert.match(ordinary.messages[1]?.content ?? "", /context window exceeded/);
});

test("the last message carries the turn trigger", () => {
  const plan = buildInjectionPlan("q", [okResult, failedResult], () => 0.999999);
  assert.equal(plan.messages.length, 3);
  assert.equal(plan.triggerIndex, 2);
});

test("metadata (session paths, timing, cost) rides the context-excluded entry, not the messages", () => {
  const plan = buildInjectionPlan("q", [okResult, failedResult], () => 0.999999);
  assert.equal(plan.metaEntry.customType, META_ENTRY_TYPE);
  const panelists = plan.metaEntry.data.panelists as Array<Record<string, unknown>>;
  assert.equal(panelists[0]?.sessionFile, "/sessions/fable.jsonl");
  assert.equal(panelists[1]?.sessionFile, "/sessions/sol.jsonl");
  // Session paths must not leak into context-participating messages.
  for (const message of plan.messages) {
    assert.ok(!message.content.includes("/sessions/"), "session paths stay out of LLM context");
  }
});

test("answers are shuffled with labels assigned in presented order; meta maps labels to models", () => {
  // rng => 0 makes Fisher-Yates swap each i with index 0, reordering deterministically.
  const plan = buildInjectionPlan("q", [okResult, failedResult], () => 0);
  const first = plan.messages[1]?.content ?? "";
  const second = plan.messages[2]?.content ?? "";
  // Reversed vs input order: failedResult (sol) first.
  assert.match(first, /^<panelist_answer panelist="A"/);
  assert.match(second, /^<panelist_answer panelist="B"/);
  assert.ok(second.includes(okResult.answer as string), "fable's answer presented second under this rng");
  const meta = plan.metaEntry.data.panelists as Array<{ label: string; model: string }>;
  assert.deepEqual(meta.map((p) => [p.label, p.model]), [
    ["A", "openai/gpt-5.6-sol"],
    ["B", "anthropic/claude-fable-5"],
  ]);
  // Different rng, different order — same input.
  const plan2 = buildInjectionPlan("q", [okResult, failedResult], () => 0.999999);
  assert.ok((plan2.messages[1]?.content ?? "").includes(okResult.answer as string), "identity rng keeps input order");
});

test("panelistLabel scales past Z", () => {
  assert.equal(panelistLabel(0), "A");
  assert.equal(panelistLabel(25), "Z");
  assert.equal(panelistLabel(26), "P27");
});
