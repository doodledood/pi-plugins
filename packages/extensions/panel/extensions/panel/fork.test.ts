import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { forkMessagesFromEntries } from "./fork.ts";

const base = { id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };

function entry(partial: Record<string, unknown>): SessionEntry {
  return { ...base, ...partial } as unknown as SessionEntry;
}

const userMessage = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
const assistantMessage = { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2, stopReason: "stop" };
const toolResultMessage = { role: "toolResult", content: [{ type: "text", text: "ls output" }], timestamp: 3 };

test("message entries pass through, order and full history preserved", () => {
  const messages = forkMessagesFromEntries([
    entry({ type: "message", message: userMessage }),
    entry({ type: "message", message: assistantMessage }),
    entry({ type: "message", message: toolResultMessage }),
    entry({ type: "message", message: userMessage }),
  ]);
  assert.equal(messages.length, 4);
  assert.deepEqual((messages[0] as { content: unknown }).content, userMessage.content);
  assert.equal((messages[1] as { role: string }).role, "assistant"); // assistant history preserved (full fork)
  assert.equal((messages[2] as { role: string }).role, "toolResult");
});

test("null/missing content on message entries is normalized, matching pi's own conversion", () => {
  const messages = forkMessagesFromEntries([
    entry({ type: "message", message: { role: "user", content: null, timestamp: 1 } }),
  ]);
  assert.equal(messages.length, 1);
  assert.deepEqual((messages[0] as { content: unknown }).content, []);
});

test("compaction and branch_summary entries become their summary message forms", () => {
  const messages = forkMessagesFromEntries([
    entry({ type: "compaction", summary: "earlier context…", tokensBefore: 50_000, firstKeptEntryId: "e0" }),
    entry({ type: "branch_summary", summary: "branch explored A", fromId: "abc" }),
  ]);
  assert.equal(messages.length, 2);
  assert.equal((messages[0] as { role: string }).role, "compactionSummary");
  assert.equal((messages[0] as { summary: string }).summary, "earlier context…");
  assert.equal((messages[1] as { role: string }).role, "branchSummary");
  assert.equal((messages[1] as { fromId: string }).fromId, "abc");
});

test("a branch_summary without a summary is skipped, matching pi's own conversion", () => {
  const messages = forkMessagesFromEntries([entry({ type: "branch_summary", summary: "", fromId: "abc" })]);
  assert.equal(messages.length, 0);
});

test("custom_message entries become CustomMessages; non-context entries drop", () => {
  const messages = forkMessagesFromEntries([
    entry({ type: "custom_message", customType: "some-ext", content: "injected", display: true }),
    entry({ type: "custom", customType: "some-ext", data: {} }),
    entry({ type: "label", targetId: "x", label: "l" }),
    entry({ type: "model_change", provider: "p", modelId: "m" }),
    entry({ type: "thinking_level_change", thinkingLevel: "high" }),
  ]);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { role: string }).role, "custom");
  assert.equal((messages[0] as { content: string }).content, "injected");
});
