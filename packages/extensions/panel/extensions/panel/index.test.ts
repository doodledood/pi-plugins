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

function fakeCtx(options: { signal?: AbortSignal; entries?: unknown[] }) {
  const notifications: string[] = [];
  const editorTexts: string[] = [];
  const widgets: Array<string[] | undefined> = [];
  const ctx = {
    hasUI: false,
    signal: options.signal,
    cwd: "/tmp/panel-test",
    ui: {
      notify: (text: string) => notifications.push(text),
      setEditorText: (text: string) => editorTexts.push(text),
      setWidget: (_key: string, content: string[] | undefined) => widgets.push(content),
      custom: async () => {
        throw new Error("ui.custom must not be called when hasUI is false");
      },
    },
    sessionManager: {
      buildContextEntries: () => options.entries ?? [],
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, editorTexts, widgets };
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
    { type: "message", message: { role: "user", content: [{ type: "text", text: "earlier turn" }], timestamp: 1 } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }], stopReason: "stop", timestamp: 2 } },
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

test("empty question notifies usage and runs nothing", async () => {
  const { pi, sent } = fakePi();
  const { ctx, notifications } = fakeCtx({});
  const { spawn, spawned } = scriptedSpawn({});
  await runPanelCommand(pi, ctx, "   ", { spawn, configPath: missingConfig }, { setActiveRun: () => {} });
  assert.match(notifications[0] ?? "", /Usage: \/panel/);
  assert.equal(spawned.length, 0);
  assert.equal(sent.length, 0);
});
