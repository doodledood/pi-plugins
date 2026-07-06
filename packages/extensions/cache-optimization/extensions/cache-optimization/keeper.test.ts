import assert from "node:assert/strict";
import test from "node:test";
import { applyCacheKeeper, KEEPER_BLOCK_GAP_THRESHOLD, type KeeperState } from "./keeper.ts";

const CC = { type: "ephemeral" } as const;

function textBlock(i: number, marker = false): Record<string, unknown> {
  return { type: "text", text: `block-${i}`, ...(marker ? { cache_control: { ...CC } } : {}) };
}

/** Anthropic-shaped payload: system + tools with markers, n user text blocks, marker on the last. */
function anthropicPayload(blockCount: number, opts?: { extraMarkers?: number; ttl?: string; lastBlockType?: string }): Record<string, unknown> {
  const blocks = Array.from({ length: blockCount }, (_, i) => textBlock(i));
  const last = blocks[blocks.length - 1]!;
  last.cache_control = opts?.ttl ? { type: "ephemeral", ttl: opts.ttl } : { ...CC };
  if (opts?.lastBlockType) last.type = opts.lastBlockType;
  const messages = [{ role: "user", content: blocks }];
  const system = [{ type: "text", text: "sys", cache_control: { ...CC } }];
  const tools = [{ name: "t", input_schema: {}, cache_control: { ...CC } }];
  if (opts?.extraMarkers) {
    for (let i = 0; i < opts.extraMarkers; i++) {
      system.push({ type: "text", text: `sys-extra-${i}`, cache_control: { ...CC } });
    }
  }
  return { model: "claude-test", system, tools, messages, max_tokens: 100 };
}

function countMessageMarkers(payload: unknown): number {
  const messages = (payload as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages;
  return messages.flatMap((m) => m.content).filter((b) => b.cache_control).length;
}

test("keeper: first request of a session never stamps", () => {
  const state: KeeperState = {};
  const result = applyCacheKeeper(anthropicPayload(30), state);
  assert.equal(result.action, "first_request");
  assert.equal(result.payload, undefined);
});

test("keeper: appends at or under the threshold leave the payload untouched", () => {
  const state: KeeperState = {};
  applyCacheKeeper(anthropicPayload(30), state);
  const result = applyCacheKeeper(anthropicPayload(30 + KEEPER_BLOCK_GAP_THRESHOLD), state);
  assert.equal(result.action, "under_threshold");
  assert.equal(result.payload, undefined);
});

test("keeper: a burst past the threshold stamps exactly one marker at the previous tail position", () => {
  const state: KeeperState = {};
  applyCacheKeeper(anthropicPayload(30), state);
  const before = anthropicPayload(30 + KEEPER_BLOCK_GAP_THRESHOLD + 1);
  const result = applyCacheKeeper(before, state);
  assert.equal(result.action, "stamped");
  assert.ok(result.payload, "replacement payload returned");

  // Original payload untouched (deep copy).
  assert.equal(countMessageMarkers(before), 1, "input payload not mutated");
  // Replacement has exactly two message markers: pi's tail + the keeper's anchor.
  assert.equal(countMessageMarkers(result.payload), 2);
  const messages = (result.payload as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages;
  const blocks = messages.flatMap((m) => m.content);
  // The anchor sits at the previous request's tail-marker position (block index 29).
  assert.ok(blocks[29]!.cache_control, "anchor stamped at previous tail-marker block");
  assert.deepEqual(blocks[29]!.cache_control, { type: "ephemeral" }, "ttl shape copied from pi's marker");
});

test("keeper: copies a 1h ttl shape onto the anchor so mixed-TTL rules cannot reject the request", () => {
  const state: KeeperState = {};
  applyCacheKeeper(anthropicPayload(30, { ttl: "1h" }), state);
  const result = applyCacheKeeper(anthropicPayload(60, { ttl: "1h" }), state);
  assert.equal(result.action, "stamped");
  const messages = (result.payload as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages;
  const blocks = messages.flatMap((m) => m.content);
  assert.deepEqual(blocks[29]!.cache_control, { type: "ephemeral", ttl: "1h" });
});

test("keeper: payloads already carrying 4 breakpoints are never touched", () => {
  const state: KeeperState = {};
  // 2 system markers (OAuth shape) + 1 tools marker + 1 message marker = 4.
  applyCacheKeeper(anthropicPayload(30, { extraMarkers: 1 }), state);
  const result = applyCacheKeeper(anthropicPayload(60, { extraMarkers: 1 }), state);
  assert.equal(result.action, "no_spare_slot");
  assert.equal(result.payload, undefined);
});

test("keeper: non-Anthropic payloads are ignored", () => {
  const state: KeeperState = {};
  const openaiResponses = { model: "gpt-5.5", input: [{ role: "user", content: "hi" }], prompt_cache_key: "s" };
  assert.equal(applyCacheKeeper(openaiResponses, state).action, "not_anthropic");
  // OpenAI chat-completions has messages but no cache_control markers anywhere.
  const openaiChat = { model: "gpt-5.5", messages: [{ role: "user", content: "hi" }] };
  assert.equal(applyCacheKeeper(openaiChat, state).action, "no_tail_marker");
  assert.equal(state.lastTailMarkerIndex, undefined, "no anchor recorded for unmarked payloads");
});

test("keeper: history shrink (branch switch) resets the anchor without stamping", () => {
  const state: KeeperState = {};
  applyCacheKeeper(anthropicPayload(60), state);
  const result = applyCacheKeeper(anthropicPayload(20), state);
  assert.equal(result.action, "history_shrunk");
  assert.equal(result.payload, undefined);
  // Re-anchored: a further small append is under threshold, not shrunk.
  assert.equal(applyCacheKeeper(anthropicPayload(25), state).action, "under_threshold");
});

test("keeper: walks back past non-cacheable blocks to find an eligible anchor", () => {
  const state: KeeperState = {};
  const first = anthropicPayload(30);
  applyCacheKeeper(first, state);
  // Rebuild history where the previous tail position is now a thinking block.
  const next = anthropicPayload(60);
  const messages = next.messages as Array<{ content: Array<Record<string, unknown>> }>;
  messages[0]!.content[29] = { type: "thinking", thinking: "..." };
  const result = applyCacheKeeper(next, state);
  assert.equal(result.action, "stamped");
  const blocks = (result.payload as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages.flatMap((m) => m.content);
  assert.ok(!blocks[29]!.cache_control, "thinking block never marked");
  assert.ok(blocks[28]!.cache_control, "nearest earlier cacheable block marked instead");
});

test("keeper: string-content messages count as one block and can host the anchor", () => {
  const state: KeeperState = {};
  const history = (n: number, markLast: boolean): Record<string, unknown> => ({
    model: "claude-test",
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    tools: [],
    messages: [
      ...Array.from({ length: n - 1 }, (_, i) => ({ role: "user", content: `plain-${i}` })),
      { role: "user", content: [textBlock(n - 1, markLast)] },
    ],
    max_tokens: 100,
  });
  applyCacheKeeper(history(10, true), state);
  const result = applyCacheKeeper(history(40, true), state);
  assert.equal(result.action, "stamped");
  const messages = (result.payload as { messages: Array<Record<string, unknown>> }).messages;
  // Block index 9 = the 10th message (string content), promoted to block form with the marker.
  const promoted = messages[9]!.content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(promoted), "string content promoted to block array");
  assert.equal(promoted[0]!.type, "text");
  assert.equal(promoted[0]!.text, "plain-9", "text preserved");
  assert.ok(promoted[0]!.cache_control, "marker attached");
});
