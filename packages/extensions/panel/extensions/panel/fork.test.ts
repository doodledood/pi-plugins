import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { forkMessagesFromEntries, transcriptFromEntries } from "./fork.ts";

const base = { id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z" };

function entry(partial: Record<string, unknown>): SessionEntry {
  return { ...base, ...partial } as unknown as SessionEntry;
}

const history: SessionEntry[] = [
  entry({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi whats up" }], timestamp: 1 } }),
  entry({
    type: "message",
    message: {
      role: "assistant",
      model: "gpt-5.6-luna",
      content: [
        { type: "text", text: "Hi! Ready to help." },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
      ],
      stopReason: "toolUse",
      timestamp: 2,
    },
  }),
  entry({ type: "message", message: { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "file-a file-b" }], timestamp: 3 } }),
  entry({ type: "message", message: { role: "user", content: [{ type: "text", text: "i like donuts" }], timestamp: 4 } }),
];

test("fork is ONE user-role transcript message — never replayed assistant turns (anti-distillation)", () => {
  const messages = forkMessagesFromEntries(history);
  assert.equal(messages.length, 1, "fork must be a single transcript message");
  assert.equal((messages[0] as { role: string }).role, "user");
  const text = ((messages[0] as { content: Array<{ text: string }> }).content[0]?.text) ?? "";
  assert.match(text, /Transcript of the conversation under review/);
  // No assistant-role message may be seeded into another vendor's session.
  assert.ok(messages.every((m) => (m as { role: string }).role !== "assistant"));
});

test("transcript preserves full history: user turns, model-labeled assistant turns, tool activity", () => {
  const transcript = transcriptFromEntries(history);
  assert.match(transcript, /USER:\nhi whats up/);
  assert.match(transcript, /ASSISTANT \(gpt-5\.6-luna\):/);
  assert.ok(transcript.includes("Hi! Ready to help."));
  assert.match(transcript, /\[called tool: bash \{"command":"ls"\}\]/);
  assert.match(transcript, /\[tool result\]\nfile-a file-b/);
  assert.match(transcript, /USER:\ni like donuts/);
  // Order preserved.
  assert.ok(transcript.indexOf("hi whats up") < transcript.indexOf("Ready to help"));
  assert.ok(transcript.indexOf("file-a") < transcript.indexOf("i like donuts"));
});

test("compaction, branch summaries, and custom messages render as labeled sections; non-context entries drop", () => {
  const transcript = transcriptFromEntries([
    entry({ type: "compaction", summary: "earlier context…", tokensBefore: 50_000, firstKeptEntryId: "e0" }),
    entry({ type: "branch_summary", summary: "branch explored A", fromId: "abc" }),
    entry({ type: "custom_message", customType: "some-ext", content: "injected note", display: true }),
    entry({ type: "custom", customType: "some-ext", data: {} }),
    entry({ type: "label", targetId: "x", label: "l" }),
    entry({ type: "model_change", provider: "p", modelId: "m" }),
  ]);
  assert.match(transcript, /\[summary of earlier conversation\]\nearlier context…/);
  assert.match(transcript, /\[summary of an abandoned conversation branch\]\nbranch explored A/);
  assert.match(transcript, /\[context note: some-ext\]\ninjected note/);
  assert.ok(!transcript.includes("model_change"));
});

test("empty history forks to no messages; null message content tolerated", () => {
  assert.deepEqual(forkMessagesFromEntries([]), []);
  const messages = forkMessagesFromEntries([
    entry({ type: "message", message: { role: "user", content: null, timestamp: 1 } }),
  ]);
  assert.equal(messages.length, 1); // transcript exists with an empty USER section
});

test("huge tool-call arguments are clipped in the transcript label", () => {
  const transcript = transcriptFromEntries([
    entry({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "t", name: "write", arguments: { content: "x".repeat(2000) } }],
        stopReason: "toolUse",
        timestamp: 1,
      },
    }),
  ]);
  assert.ok(transcript.length < 1000);
  assert.match(transcript, /\[called tool: write /);
});
