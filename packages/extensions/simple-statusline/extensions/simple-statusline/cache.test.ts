import assert from "node:assert/strict";
import test from "node:test";
import {
  BREAK_MIN_PREV_PROMPT_TOKENS,
  BREAK_READ_FRACTION,
  collectTurnStats,
  computeSessionCacheStats,
  formatCost,
  formatTokens,
  isCacheBreak,
  MIN_VISIBLE_PROMPT_TOKENS,
  pct,
  type SessionEntryLike,
  type TurnCacheStats,
} from "./cache.ts";

function assistantEntry(args: {
  id?: string;
  timestamp?: number;
  input?: number;
  read?: number;
  write?: number;
  usage?: boolean;
}): SessionEntryLike {
  return {
    type: "message",
    id: args.id ?? "e1",
    message: {
      role: "assistant",
      timestamp: args.timestamp ?? 1_000,
      ...(args.usage === false
        ? {}
        : { usage: { input: args.input ?? 0, cacheRead: args.read ?? 0, cacheWrite: args.write ?? 0 } }),
    },
  };
}

function userEntry(): SessionEntryLike {
  return { type: "message", message: { role: "user" } };
}

function turn(args: Partial<TurnCacheStats> & { prompt?: number }): TurnCacheStats {
  const input = args.input ?? 0;
  const read = args.read ?? 0;
  const write = args.write ?? 0;
  const prompt = args.prompt ?? input + read + write;
  return {
    branchIndex: args.branchIndex ?? 0,
    turn: args.turn ?? 0,
    timestamp: args.timestamp ?? 0,
    input,
    read,
    write,
    prompt,
    rate: prompt > 0 ? read / prompt : 0,
    cost: args.cost ?? 0,
  };
}

test("session cache rate is cumulative token-weighted read share of prompt tokens", () => {
  const stats = computeSessionCacheStats([
    userEntry(),
    assistantEntry({ input: 1000, read: 0, write: 9000 }),
    userEntry(),
    assistantEntry({ input: 500, read: 9500, write: 0 }),
  ]);
  // reads 9500 over prompt (1000+9000) + (500+9500) = 20000
  assert.equal(stats.totalPrompt, 20_000);
  assert.equal(stats.sessionRate, 9500 / 20_000);
  assert.equal(stats.turns.length, 2);
  assert.equal(stats.visible, true);
});

test("entries without usage or non-assistant roles are ignored", () => {
  const stats = computeSessionCacheStats([
    userEntry(),
    assistantEntry({ usage: false }),
    { type: "compaction" },
  ]);
  assert.equal(stats.turns.length, 0);
  assert.equal(stats.sessionRate, 0);
  assert.equal(stats.visible, false);
});

test("metric hidden below the minimum prompt-token threshold", () => {
  const stats = computeSessionCacheStats([assistantEntry({ input: 100, read: MIN_VISIBLE_PROMPT_TOKENS - 200 })]);
  assert.ok(stats.totalPrompt < MIN_VISIBLE_PROMPT_TOKENS);
  assert.equal(stats.visible, false);
});

test("metric hidden when the provider reports no cache fields (data-driven gating)", () => {
  const stats = computeSessionCacheStats([assistantEntry({ input: 50_000, read: 0, write: 0 })]);
  assert.equal(stats.visible, false);
});

test("zero-usage (aborted/errored) turns are excluded and never poison break detection", () => {
  const stats = computeSessionCacheStats([
    assistantEntry({ id: "a1", timestamp: 1_000, input: 2_000, write: 18_000 }),
    assistantEntry({ id: "aborted", timestamp: 1_500, input: 0, read: 0, write: 0 }),
    assistantEntry({ id: "a2", timestamp: 2_000, input: 20_000, read: 100, write: 0 }),
  ]);
  assert.equal(stats.turns.length, 2, "zero-prompt turn excluded");
  assert.equal(stats.latestBreak, true, "real break still detected across the aborted turn");

  const abortedLatest = computeSessionCacheStats([
    assistantEntry({ id: "a1", timestamp: 1_000, input: 2_000, write: 18_000 }),
    assistantEntry({ id: "aborted", timestamp: 1_500, input: 0, read: 0, write: 0 }),
  ]);
  assert.equal(abortedLatest.latestBreak, false, "aborted turn itself never flags a break");
});

test("first assistant turn is never a break", () => {
  assert.equal(isCacheBreak(undefined, turn({ input: 50_000, read: 0 })), false);
  const stats = computeSessionCacheStats([assistantEntry({ input: 50_000, read: 0, write: 1 })]);
  assert.equal(stats.latestBreak, false);
});

test("break detection threshold boundaries", () => {
  const prev = turn({ prompt: BREAK_MIN_PREV_PROMPT_TOKENS, read: 0 });
  const exactlyHalf = turn({ read: BREAK_MIN_PREV_PROMPT_TOKENS * BREAK_READ_FRACTION, input: 1 });
  const justBelow = turn({ read: BREAK_MIN_PREV_PROMPT_TOKENS * BREAK_READ_FRACTION - 1, input: 1 });
  assert.equal(isCacheBreak(prev, exactlyHalf), false, "reading exactly the fraction is not a break");
  assert.equal(isCacheBreak(prev, justBelow), true, "reading below the fraction is a break");

  const smallPrev = turn({ prompt: BREAK_MIN_PREV_PROMPT_TOKENS - 1, read: 0 });
  assert.equal(isCacheBreak(smallPrev, turn({ read: 0, input: 1 })), false, "small previous prompt never flags");
});

test("messageTimestamp falls back to the entry ISO timestamp, then 0", () => {
  const iso = "2026-07-06T10:00:00.000Z";
  const stats = collectTurnStats([
    { type: "message", timestamp: iso, message: { role: "assistant", usage: { input: 1 } } },
    { type: "message", message: { role: "assistant", usage: { input: 1 } } },
  ]);
  assert.equal(stats[0]!.timestamp, Date.parse(iso));
  assert.equal(stats[1]!.timestamp, 0);
});

test("formatters: tokens, percentages, and dollars", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_500), "1.5k");
  assert.equal(formatTokens(250_000), "250k");
  assert.equal(formatTokens(1_200_000), "1.2m");
  assert.equal(pct(0.494), "49%");
  assert.equal(formatCost(0.042), "$0.042");
  assert.equal(formatCost(1.5), "$1.50");
});
