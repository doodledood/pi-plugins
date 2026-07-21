import assert from "node:assert/strict";
import { test } from "node:test";
import { forkMessagesFromEntries, type ContextEntryLike } from "./fork.ts";

const userMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
const assistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  timestamp: 2,
  stopReason: "stop",
};
const toolResultMessage = { role: "toolResult", content: [{ type: "text", text: "ls output" }], timestamp: 3 };

test("message entries pass through verbatim, order and full history preserved", () => {
  const entries: ContextEntryLike[] = [
    { type: "message", message: userMessage as never },
    { type: "message", message: assistantMessage as never },
    { type: "message", message: toolResultMessage as never },
    { type: "message", message: userMessage as never },
  ];
  const messages = forkMessagesFromEntries(entries);
  assert.equal(messages.length, 4);
  assert.equal(messages[0], userMessage);
  assert.equal(messages[1], assistantMessage); // assistant history preserved (full fork)
  assert.equal(messages[2], toolResultMessage);
});

test("compaction and branch_summary entries become their summary message forms", () => {
  const messages = forkMessagesFromEntries([
    { type: "compaction", summary: "earlier context…", tokensBefore: 50_000, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "branch_summary", summary: "branch explored A", fromId: "abc", timestamp: "2026-01-01T00:00:01.000Z" },
  ]);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], {
    role: "compactionSummary",
    summary: "earlier context…",
    tokensBefore: 50_000,
    timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
  });
  assert.equal((messages[1] as { role: string }).role, "branchSummary");
  assert.equal((messages[1] as { fromId: string }).fromId, "abc");
});

test("custom_message entries become CustomMessages; non-context entries drop", () => {
  const messages = forkMessagesFromEntries([
    { type: "custom_message", customType: "some-ext", content: "injected", display: true },
    { type: "custom", customType: "some-ext" },
    { type: "label" },
    { type: "model_change" },
    { type: "thinking_level_change" },
    { type: "session" },
  ]);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { role: string }).role, "custom");
  assert.equal((messages[0] as { content: string }).content, "injected");
});
