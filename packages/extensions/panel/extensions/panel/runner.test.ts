import assert from "node:assert/strict";
import { test } from "node:test";
import { finalAnswer, runPanel } from "./runner.ts";
import type { PanelistSession, PanelistSessionEvent, PanelistSpec, SpawnPanelist } from "./types.ts";

const specA: PanelistSpec = { model: "stub/model-a", thinking: "low" };
const specB: PanelistSpec = { model: "stub/model-b", thinking: "high" };

interface StubOptions {
  answer?: string;
  failWith?: string;
  spawnError?: string;
  hangUntilAbort?: boolean;
  delayMs?: number;
  sessionFile?: string;
  events?: PanelistSessionEvent[];
  /** Pre-seeded messages present before the prompt (the forked history). */
  seeded?: unknown[];
}

function stubSession(options: StubOptions): PanelistSession {
  let aborted = false;
  let releaseHang: (() => void) | undefined;
  const listeners = new Set<(event: PanelistSessionEvent) => void>();
  const messages: unknown[] = [...(options.seeded ?? [])];
  return {
    async prompt(text: string) {
      messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      for (const event of options.events ?? []) for (const l of listeners) l(event);
      if (options.hangUntilAbort) {
        await new Promise<void>((resolve) => {
          releaseHang = resolve;
          if (aborted) resolve();
        });
      }
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options.failWith) {
        for (const l of listeners) {
          l({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: options.failWith } });
        }
        messages.push({ role: "assistant", content: [], stopReason: "error", timestamp: Date.now() });
        return;
      }
      if (!aborted && options.answer) {
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: options.answer }],
          stopReason: "stop",
          timestamp: Date.now(),
        });
      }
    },
    async abort() {
      aborted = true;
      releaseHang?.();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get messages() {
      return messages as never;
    },
    sessionFile: options.sessionFile,
    dispose() {},
  };
}

function spawnFor(map: Map<string, StubOptions>): SpawnPanelist {
  return async ({ spec }) => {
    const options = map.get(spec.model);
    if (!options) throw new Error(`no stub for ${spec.model}`);
    if (options.spawnError) throw new Error(options.spawnError);
    return stubSession(options);
  };
}

const baseOptions = {
  question: "what say you?",
  forkMessages: [],
  systemPrompt: "panelist",
  cwd: "/tmp",
  timeoutMs: 5_000,
};

test("two panelists run concurrently and both answers are collected", async () => {
  const spawn = spawnFor(
    new Map([
      ["stub/model-a", { answer: "answer A", sessionFile: "/tmp/a.jsonl", delayMs: 20 }],
      ["stub/model-b", { answer: "answer B", sessionFile: "/tmp/b.jsonl", delayMs: 20 }],
    ]),
  );
  const started = Date.now();
  const results = await runPanel({ ...baseOptions, specs: [specA, specB], spawn });
  // Concurrency: two 20ms runs should not take 40ms+ sequential time (generous bound).
  assert.ok(Date.now() - started < 200);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => [r.ok, r.answer]), [[true, "answer A"], [true, "answer B"]]);
  assert.equal(results[0]?.sessionFile, "/tmp/a.jsonl");
  assert.equal(results[1]?.sessionFile, "/tmp/b.jsonl");
});

test("one failing panelist does not sink the other", async () => {
  const spawn = spawnFor(
    new Map([
      ["stub/model-a", { failWith: "context window exceeded" }],
      ["stub/model-b", { answer: "still here" }],
    ]),
  );
  const results = await runPanel({ ...baseOptions, specs: [specA, specB], spawn });
  assert.equal(results[0]?.ok, false);
  assert.match(results[0]?.error ?? "", /context window exceeded/);
  assert.equal(results[1]?.ok, true);
  assert.equal(results[1]?.answer, "still here");
});

test("a panelist that fails to spawn surfaces as its own error", async () => {
  const spawn = spawnFor(
    new Map([
      ["stub/model-a", { spawnError: "model not found: stub/model-a" }],
      ["stub/model-b", { answer: "fine" }],
    ]),
  );
  const results = await runPanel({ ...baseOptions, specs: [specA, specB], spawn });
  assert.equal(results[0]?.ok, false);
  assert.match(results[0]?.error ?? "", /model not found/);
  assert.equal(results[1]?.ok, true);
});

test("abort propagates to every panelist promptly and reports cancelled states", async () => {
  const spawn = spawnFor(
    new Map([
      ["stub/model-a", { hangUntilAbort: true }],
      ["stub/model-b", { hangUntilAbort: true }],
    ]),
  );
  const controller = new AbortController();
  const updates: string[][] = [];
  const run = runPanel({
    ...baseOptions,
    specs: [specA, specB],
    spawn,
    signal: controller.signal,
    onUpdate: (states) => updates.push(states.map((s) => s.status)),
  });
  setTimeout(() => controller.abort(), 20);
  const started = Date.now();
  const results = await run;
  assert.ok(Date.now() - started < 2_000, "abort must complete within a bounded time");
  assert.deepEqual(results.map((r) => [r.ok, r.cancelled]), [[false, true], [false, true]]);
  assert.deepEqual(updates.at(-1), ["cancelled", "cancelled"]);
});

test("per-panelist timeout aborts that panelist", async () => {
  const spawn = spawnFor(new Map([["stub/model-a", { hangUntilAbort: true }]]));
  const results = await runPanel({ ...baseOptions, specs: [specA], spawn, timeoutMs: 30 });
  assert.equal(results[0]?.ok, false);
  assert.match(results[0]?.error ?? "", /without an answer/);
});

test("streamed events drive state: activity, transcript tail, tokens", async () => {
  const events: PanelistSessionEvent[] = [
    { type: "tool_execution_start", toolName: "bash" },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "line one\nline two\n" } },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 100, output: 50, cost: { total: 0.01 } } } },
  ];
  const spawn = spawnFor(new Map([["stub/model-a", { answer: "done", events }]]));
  let finalStates: readonly { activity: string; transcript: string[]; tokens: number; cost?: number }[] = [];
  await runPanel({
    ...baseOptions,
    specs: [specA],
    spawn,
    onUpdate: (states) => {
      finalStates = states as never;
    },
  });
  const state = finalStates[0];
  assert.ok(state);
  assert.ok(state.transcript.includes("> bash"));
  assert.ok(state.transcript.includes("line one"));
  assert.equal(state.tokens, 150);
  assert.equal(state.cost, 0.01);
});

test("a failed panelist never surfaces seeded fork content as its answer", async () => {
  const seeded = [
    { role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "stale fork answer" }], stopReason: "stop", timestamp: 2 },
  ];
  const spawn = spawnFor(new Map([["stub/model-a", { failWith: "model_not_found", seeded }]]));
  const results = await runPanel({ ...baseOptions, specs: [specA], spawn });
  assert.equal(results[0]?.ok, false);
  assert.notEqual(results[0]?.answer, "stale fork answer");
  assert.match(results[0]?.error ?? "", /model_not_found/);
});

test("finalAnswer takes the last non-errored assistant text; errored partials never count", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "q" }] },
    { role: "assistant", content: [{ type: "text", text: "good answer" }], stopReason: "stop" },
    { role: "assistant", content: [{ type: "text", text: "partial garbage" }], stopReason: "error" },
  ];
  assert.equal(finalAnswer(messages as never), "good answer");
  assert.equal(finalAnswer([messages[2]] as never), undefined);
  assert.equal(finalAnswer([]), undefined);
});
