import assert from "node:assert/strict";
import { test } from "node:test";

import { OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, floorMaxOutputTokens } from "./floor.ts";

test("floors a sub-minimum max_output_tokens up to the provider floor", () => {
  const result = floorMaxOutputTokens({ model: "gpt-5.5", max_output_tokens: 1 });
  assert.deepEqual(result, { model: "gpt-5.5", max_output_tokens: OPENAI_RESPONSES_MIN_OUTPUT_TOKENS });
});

test("floors zero and negative values", () => {
  assert.equal(floorMaxOutputTokens({ max_output_tokens: 0 })?.max_output_tokens, 16);
  assert.equal(floorMaxOutputTokens({ max_output_tokens: -5 })?.max_output_tokens, 16);
});

test("leaves a value at or above the floor untouched", () => {
  assert.equal(floorMaxOutputTokens({ max_output_tokens: 16 }), undefined);
  assert.equal(floorMaxOutputTokens({ max_output_tokens: 128000 }), undefined);
});

test("does not cap a legitimate large budget", () => {
  assert.equal(floorMaxOutputTokens({ max_output_tokens: 128000 }), undefined);
});

test("ignores payloads without max_output_tokens (other providers untouched)", () => {
  // Anthropic / completions / google use different field names.
  assert.equal(floorMaxOutputTokens({ max_tokens: 1 }), undefined);
  assert.equal(floorMaxOutputTokens({ max_completion_tokens: 1 }), undefined);
  assert.equal(floorMaxOutputTokens({ maxOutputTokens: 1 }), undefined);
  assert.equal(floorMaxOutputTokens({ model: "gpt-5.5" }), undefined);
});

test("ignores non-number and non-finite max_output_tokens", () => {
  assert.equal(floorMaxOutputTokens({ max_output_tokens: "1" }), undefined);
  assert.equal(floorMaxOutputTokens({ max_output_tokens: Number.NaN }), undefined);
  assert.equal(floorMaxOutputTokens({ max_output_tokens: null }), undefined);
});

test("ignores non-object payloads", () => {
  assert.equal(floorMaxOutputTokens(undefined), undefined);
  assert.equal(floorMaxOutputTokens(null), undefined);
  assert.equal(floorMaxOutputTokens(42), undefined);
  assert.equal(floorMaxOutputTokens("payload"), undefined);
  assert.equal(floorMaxOutputTokens([{ max_output_tokens: 1 }]), undefined);
});

test("does not mutate the input payload", () => {
  const payload = { model: "gpt-5.5", max_output_tokens: 1 };
  const result = floorMaxOutputTokens(payload);
  assert.equal(payload.max_output_tokens, 1, "input must be left unchanged");
  assert.notEqual(result, payload, "must return a new object, not the input");
});

test("respects a custom floor override", () => {
  assert.equal(floorMaxOutputTokens({ max_output_tokens: 5 }, 32)?.max_output_tokens, 32);
  assert.equal(floorMaxOutputTokens({ max_output_tokens: 40 }, 32), undefined);
});
