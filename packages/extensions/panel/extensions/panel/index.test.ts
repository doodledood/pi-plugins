import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runPanelCommand } from "./index.ts";
import { ANSWER_MESSAGE_TYPE, META_ENTRY_TYPE, QUESTION_MESSAGE_TYPE } from "./results.ts";
import type { PanelistSession, SpawnPanelist, SpawnPanelistOptions } from "./types.ts";

interface SentMessage {
  message: { customType: string; content: string; display: boolean; details?: unknown };
  options: { deliverAs?: string; triggerTurn?: boolean };
}

/** Nonexistent config path: tests always exercise the built-in default lineup. */
const missingConfig = join(mkdtempSync(join(tmpdir(), "panel-index-")), "panel.json");

function fakePi() {
  const sent: SentMessage[] = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    sendMessage: (message: SentMessage["message"], options: SentMessage["options"]) => {
      sent.push({ message, options });
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  return { pi, sent, entries };
}

function fakeCtx(options: { signal?: AbortSignal; entries?: unknown[]; hasUI?: boolean; mode?: string }) {
  const notifications: string[] = [];
  const editorTexts: string[] = [];
  let customCalls = 0;
  const ctx = {
    hasUI: options.hasUI ?? false,
    mode: options.mode ?? "print",
    signal: options.signal,
    cwd: "/tmp/panel-test",
    ui: {
      notify: (text: string) => notifications.push(text),
      setEditorText: (text: string) => editorTexts.push(text),
      setWidget: () => {},
      custom: async () => {
        customCalls++;
        return undefined; // matches RPC-mode behavior: custom() resolves undefined
      },
    },
    sessionManager: {
      buildContextEntries: () => options.entries ?? [],
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, editorTexts, customCalls: () => customCalls };
}

function scriptedSpawn(answers: Record<string, string | { hang: true }>): {
  spawn: SpawnPanelist;
  spawned: SpawnPanelistOptions[];
  aborts: string[];
} {
  const spawned: SpawnPanelistOptions[] = [];
  const aborts: string[] = [];
  const spawn: SpawnPanelist = async (options) => {
    spawned.push(options);
    const script = answers[options.spec.model];
    let aborted = false;
    let release: (() => void) | undefined;
    const messages: unknown[] = [];
    const session: PanelistSession = {
      async prompt(text: string) {
        messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
        if (typeof script === "object" && script.hang) {
          await new Promise<void>((resolve) => {
            release = resolve;
            if (aborted) resolve();
          });
          return;
        }
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: script as string }],
          stopReason: "stop",
          timestamp: Date.now(),
        });
      },
      async abort() {
        aborted = true;
        aborts.push(options.spec.model);
        release?.();
      },
      subscribe: () => () => {},
      get messages() {
        return messages as never;
      },
      sessionFile: `/tmp/sessions/${options.spec.model.replace(/\//g, "-")}.jsonl`,
      dispose() {},
    };
    return session;
  };
  return { spawn, spawned, aborts };
}

test("full flow: fork built from session entries, defaults run, answers injected in order", async () => {
  const { pi, sent, entries } = fakePi();
  const historyEntries = [
    { type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "earlier turn" }], timestamp: 1 } },
    { type: "message", id: "e2", parentId: "e1", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }], stopReason: "stop", timestamp: 2 } },
  ];
  const { ctx, editorTexts } = fakeCtx({ entries: historyEntries });
  const { spawn, spawned } = scriptedSpawn({
    "anthropic/claude-fable-5": "fable says X",
    "openai/gpt-5.6-sol": "sol says Y",
  });

  await runPanelCommand(pi, ctx, "  is this sound?  ", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });

  // Both default panelists spawned with the forked history and the panelist system prompt.
  assert.equal(spawned.length, 2);
  for (const spawnOptions of spawned) {
    assert.equal(spawnOptions.forkMessages.length, 2);
    assert.equal((spawnOptions.forkMessages[0] as { role: string }).role, "user");
    assert.match(spawnOptions.systemPrompt, /independent panelist/);
    assert.match(spawnOptions.systemPrompt, /read-only/);
  }

  // Context contract: question message (hidden) + one displayed answer per panelist.
  assert.equal(sent.length, 3);
  assert.equal(sent[0]?.message.customType, QUESTION_MESSAGE_TYPE);
  assert.equal(sent[0]?.message.display, false);
  assert.match(sent[0]?.message.content ?? "", /is this sound\?/);
  assert.equal(sent[1]?.message.customType, ANSWER_MESSAGE_TYPE);
  assert.ok(sent[1]?.message.content.includes("fable says X"));
  assert.ok(sent[2]?.message.content.includes("sol says Y"));
  // Only the final message triggers the main-model turn.
  assert.deepEqual(sent.map((s) => s.options.triggerTurn ?? false), [false, false, true]);

  // Metadata entry carries session paths; editor untouched on success.
  assert.equal(entries[0]?.customType, META_ENTRY_TYPE);
  const meta = entries[0]?.data as { panelists: Array<{ sessionFile?: string }> };
  assert.match(meta.panelists[0]?.sessionFile ?? "", /fable/);
  assert.equal(editorTexts.length, 0);
});

test("cancel: abort mid-run aborts every panelist and restores the question unsent", async () => {
  const { pi, sent } = fakePi();
  const controller = new AbortController();
  const { ctx, editorTexts, notifications } = fakeCtx({ signal: controller.signal });
  const { spawn, aborts } = scriptedSpawn({
    "anthropic/claude-fable-5": { hang: true },
    "openai/gpt-5.6-sol": { hang: true },
  });

  const run = runPanelCommand(pi, ctx, "risky question", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });
  setTimeout(() => controller.abort(), 20);
  await run;

  assert.equal(aborts.length, 2, "both panelist sessions must be aborted");
  assert.deepEqual(editorTexts, ["/panel risky question"]);
  assert.match(notifications.join("\n"), /cancelled/i);
  assert.equal(sent.length, 0, "nothing enters context on cancel");
});

test("non-TUI mode with hasUI (RPC) skips the picker and runs the preselected lineup", async () => {
  const { pi, sent } = fakePi();
  const { ctx, customCalls } = fakeCtx({ hasUI: true, mode: "rpc" });
  const { spawn, spawned } = scriptedSpawn({
    "anthropic/claude-fable-5": "A",
    "openai/gpt-5.6-sol": "B",
  });
  await runPanelCommand(pi, ctx, "q?", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });
  assert.equal(customCalls(), 0, "terminal-only ui.custom must not be used outside TUI mode");
  assert.equal(spawned.length, 2);
  assert.equal(sent.length, 3);
});

test("tool activity in a panelist session never reaches the injected context messages", async () => {
  const { pi, sent } = fakePi();
  const { ctx } = fakeCtx({});
  // A session whose transcript includes tool calls and tool results around the
  // final answer — only the final answer text may enter context.
  const spawn: SpawnPanelist = async (options) => {
    const messages: unknown[] = [];
    return {
      async prompt(text: string) {
        messages.push({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
        messages.push({
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "toolCall", id: "t1", name: "bash", arguments: { command: "cat /etc/secret-config" } },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        });
        messages.push({ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "SECRET-TOOL-OUTPUT" }], timestamp: 3 });
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: `final answer from ${options.spec.model}` }],
          stopReason: "stop",
          timestamp: 4,
        });
      },
      async abort() {},
      subscribe: () => () => {},
      get messages() {
        return messages as never;
      },
      sessionFile: undefined,
      dispose() {},
    };
  };
  await runPanelCommand(pi, ctx, "q?", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });
  assert.equal(sent.length, 3);
  for (const s of sent) {
    assert.ok(!s.message.content.includes("SECRET-TOOL-OUTPUT"), "tool output must not enter context");
    assert.ok(!s.message.content.includes("cat /etc/secret-config"), "tool call arguments must not enter context");
  }
  assert.ok(sent[1]?.message.content.includes("final answer from anthropic/claude-fable-5"));
});

interface CustomCall {
  component: { handleInput?: (data: string) => void; dispose?: () => void } | undefined;
}

/**
 * TUI-mode ctx: ui.custom mimics pi's real behavior — the factory runs
 * synchronously with a done() that resolves the returned promise and triggers
 * component.dispose(). `script` decides what each call resolves to:
 * "invoke-and-wait" leaves resolution to the component's own done usage
 * (the monitor path), a function resolves immediately with its value.
 */
function fakeTuiCtx(options: {
  entries?: unknown[];
  script: Array<((component: unknown, done: (v: unknown) => void) => void) | "invoke-and-wait">;
}) {
  const notifications: string[] = [];
  const editorTexts: string[] = [];
  const customCalls: CustomCall[] = [];
  let scriptIndex = 0;
  const ctx = {
    hasUI: true,
    mode: "tui",
    signal: undefined,
    cwd: "/tmp/panel-test",
    ui: {
      notify: (text: string) => notifications.push(text),
      setEditorText: (text: string) => editorTexts.push(text),
      setWidget: () => {},
      custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) => {
        const step = options.script[scriptIndex++];
        return new Promise((resolve) => {
          const call: CustomCall = { component: undefined };
          customCalls.push(call);
          const done = (value: unknown) => {
            (call.component as { dispose?: () => void } | undefined)?.dispose?.();
            resolve(value);
          };
          const component = factory({ requestRender: () => {} }, themeStubForTui, {}, done);
          call.component = component as CustomCall["component"];
          if (typeof step === "function") step(component, done);
          // "invoke-and-wait": resolution happens via the captured done (monitor).
        });
      },
    },
    sessionManager: { buildContextEntries: () => options.entries ?? [] },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, editorTexts, customCalls };
}

const themeStubForTui = { bold: (t: string) => t, fg: (_r: string, t: string) => t };

test("TUI: declining the picker restores the question unsent and runs nothing", async () => {
  const { pi, sent } = fakePi();
  const { ctx, editorTexts } = fakeTuiCtx({
    script: [(_component, done) => done(null)], // picker cancelled
  });
  const { spawn, spawned } = scriptedSpawn({});
  await runPanelCommand(pi, ctx, "my question", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });
  assert.deepEqual(editorTexts, ["/panel my question"]);
  assert.equal(spawned.length, 0);
  assert.equal(sent.length, 0);
});

test("TUI: monitor opens for the run, closes cleanly on completion, and the command resolves", async () => {
  const { pi, sent } = fakePi();
  const { ctx, customCalls } = fakeTuiCtx({
    script: [
      (component, done) => {
        // Drive the real picker component: enter accepts the preselected defaults.
        (component as { handleInput: (d: string) => void }).handleInput("\r");
        void done; // resolution happens through the component's own done
      },
      "invoke-and-wait", // monitor: closed programmatically when the run ends
    ],
  });
  const { spawn } = scriptedSpawn({
    "anthropic/claude-fable-5": "A",
    "openai/gpt-5.6-sol": "B",
  });
  await runPanelCommand(pi, ctx, "q?", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });
  // Command resolved (no hang), both custom surfaces were used, answers injected.
  assert.equal(customCalls.length, 2, "picker and monitor must both open");
  assert.equal(sent.length, 3);
});

test("TUI: Esc on the monitor cancels the panel and restores the question", async () => {
  const { pi, sent } = fakePi();
  const { ctx, editorTexts } = fakeTuiCtx({
    script: [
      (component) => (component as { handleInput: (d: string) => void }).handleInput("\r"), // picker: run defaults
      (component) => {
        // monitor: press Esc shortly after it opens (status view → cancel)
        setTimeout(() => (component as { handleInput: (d: string) => void }).handleInput("\x1b"), 20);
      },
    ],
  });
  const { spawn, aborts } = scriptedSpawn({
    "anthropic/claude-fable-5": { hang: true },
    "openai/gpt-5.6-sol": { hang: true },
  });
  await runPanelCommand(pi, ctx, "slow question", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });
  assert.equal(aborts.length, 2, "Esc must abort both panelists");
  assert.deepEqual(editorTexts, ["/panel slow question"]);
  assert.equal(sent.length, 0);
});

test("empty question notifies usage and runs nothing", async () => {
  const { pi, sent } = fakePi();
  const { ctx, notifications } = fakeCtx({});
  const { spawn, spawned } = scriptedSpawn({});
  await runPanelCommand(pi, ctx, "   ", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });
  assert.match(notifications[0] ?? "", /Usage: \/panel/);
  assert.equal(spawned.length, 0);
  assert.equal(sent.length, 0);
});
