import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
  initTheme,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
  type SessionEntry,
  type TerminalInputHandler,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  TUI as PiTUI,
  visibleWidth,
  type Component,
  type KeybindingsManager as TuiKeybindingsManager,
  type OverlayHandle,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { assertSupportedPiVersion, BtwController, MINIMUM_PI_VERSION } from "../index.ts";
import { BTW_MOUSE_SEQUENCES } from "../src/mouse.ts";
import type { ChildRuntimeHandle, CreateChildRuntimeInput } from "../src/runtime.ts";
import {
  boundedText,
  BtwOverlay,
  projectAssistantMessage,
  projectToolArguments,
  projectToolResult,
} from "../src/ui.ts";

initTheme("dark", false);

test("runtime version guard accepts the minimum Pi host and newer", () => {
  assert.doesNotThrow(() => assertSupportedPiVersion(MINIMUM_PI_VERSION));
  assert.doesNotThrow(() => assertSupportedPiVersion("0.80.7"));
  assert.doesNotThrow(() => assertSupportedPiVersion("0.81.0"));
  assert.doesNotThrow(() => assertSupportedPiVersion("1.0.0"));
  assert.throws(
    () => assertSupportedPiVersion("0.80.5"),
    /requires Pi 0\.80\.6 or newer; running Pi is 0\.80\.5/,
  );
});

const model = {
  id: "deterministic",
  name: "Deterministic",
  api: "openai-responses",
  provider: "test",
  baseUrl: "http://127.0.0.1/never-called",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 1_000,
} as Model<any>;

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
} as Theme;

function fakeTui(rows = 38, columns = 120, writes: string[] = []): TUI {
  return {
    terminal: { rows, columns, write: (data: string) => { writes.push(data); } },
    requestRender() {},
  } as unknown as TUI;
}

function realTui(rows = 38, columns = 120): PiTUI {
  const terminal = {
    rows,
    columns,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
  } satisfies Terminal;
  return new PiTUI(terminal);
}

function typeText(component: BtwOverlay, text: string): void {
  for (const char of text) component.handleInput(char);
  component.handleInput("\r");
}

test("overlay renders responsive bounded lines, statuses, transcript and controls", () => {
  const submitted: string[] = [];
  let mainCalls = 0;
  let closeCalls = 0;
  let abortCalls = 0;
  const tui = fakeTui();
  const overlay = new BtwOverlay(tui, plainTheme, {
    onSubmit: (text) => submitted.push(text),
    onMain: () => { mainCalls += 1; },
    onClose: () => { closeCalls += 1; },
    onAbort: () => { abortCalls += 1; },
  });
  overlay.focused = true;
  overlay.setForkLeaf("abcdef123456");
  overlay.attachSession({
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp" },
  } as unknown as AgentSession);
  overlay.setParentRunning(true);
  overlay.handleSessionEvent({ type: "agent_start" });
  overlay.handleSessionEvent({
    type: "message_start",
    message: { role: "user", content: "How does this work?", timestamp: 1 },
  });
  overlay.handleSessionEvent({
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "It stays isolated while sharing the workspace." }],
      api: "openai-responses",
      provider: "test",
      model: "deterministic",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  });
  overlay.handleSessionEvent({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "/tmp/example.ts" },
  });
  overlay.handleSessionEvent({
    type: "tool_execution_update",
    toolCallId: "tool-1",
    toolName: "read",
    args: { path: "/tmp/example.ts" },
    partialResult: { content: [{ type: "text", text: "reading" }] },
  });
  overlay.handleSessionEvent({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "export const value = 1;" }] },
    isError: false,
  });
  overlay.handleSessionEvent({ type: "compaction_start", reason: "threshold" });
  overlay.handleSessionEvent({
    type: "compaction_end",
    reason: "threshold",
    result: undefined,
    aborted: false,
    willRetry: false,
  });
  overlay.handleSessionEvent({ type: "agent_settled" });

  for (const width of [54, 92]) {
    const lines = overlay.render(width);
    assert.ok(lines.length <= Math.floor(38 * 0.94));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const screen = lines.join("\n");
    assert.match(screen, /BTW\s+\/\s+FORK abcdef12/);
    assert.match(screen, /parent running/);
    assert.match(screen, /How does this work/);
    assert.match(screen, /stays isolated/);
    assert.match(screen, /read/);
    assert.match(screen, /context compacted/);
    assert.doesNotMatch(screen, /MESSAGE/, "no stray section label above the editor");
    assert.doesNotMatch(screen, /transcript/, "no labeled transcript rule");
    assert.match(screen, /Wheel\/PgUp\/PgDn scroll/);
    assert.match(screen, /click in\/out focus/);
    assert.match(screen, /\/main unfocus/);
    assert.match(screen, /\/done close/);
  }
  assert.deepEqual(overlay.getScreenBounds(), {
    left: 28,
    top: 2,
    right: 119,
    bottom: 36,
  });

  Object.assign(tui.terminal, { columns: 100, rows: 30 });
  overlay.render(52);
  assert.deepEqual(overlay.getScreenBounds(), {
    left: 48,
    top: 2,
    right: 99,
    bottom: 29,
  }, "render records resized right-center geometry");

  typeText(overlay, "hello child");
  assert.deepEqual(submitted, ["hello child"]);
  typeText(overlay, "/main");
  typeText(overlay, "done");
  assert.equal(mainCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(abortCalls, 0);
});

test("long multiline editor preserves Pi Editor's cursor-aware top viewport", () => {
  const overlay = new BtwOverlay(fakeTui(40), plainTheme, {
    onSubmit() {},
    onMain() {},
    onClose() {},
    onAbort() {},
  });
  overlay.attachSession({
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp" },
  } as unknown as AgentSession);
  overlay.focused = true;

  for (let line = 1; line <= 12; line += 1) {
    for (const char of `edited line ${line}`) overlay.handleInput(char);
    if (line < 12) overlay.handleInput("\n");
  }
  for (let index = 0; index < 11; index += 1) overlay.handleInput("\x1b[A");

  const screen = overlay.render(60).join("\n");
  assert.match(screen, /edited line 1/);
  assert.ok(screen.includes(CURSOR_MARKER), "cursor marker remains in the pane viewport");
});

test("short terminals retain the multiline editor cursor, controls, border, and screen bounds", () => {
  for (const rows of [12, 16]) {
    const overlay = new BtwOverlay(fakeTui(rows, 80), plainTheme, {
      onSubmit() {},
      onMain() {},
      onClose() {},
      onAbort() {},
    });
    overlay.focused = true;
    for (let line = 1; line <= 12; line += 1) {
      for (const char of `short editor line ${line}`) overlay.handleInput(char);
      if (line < 12) overlay.handleInput("\n");
    }
    for (let index = 0; index < 11; index += 1) overlay.handleInput("\x1b[A");

    const rendered = overlay.render(60);
    const screen = rendered.join("\n");
    assert.ok(rendered.length <= rows - 2, `${rows}-row overlay respects top/bottom margins`);
    assert.ok(rendered.every((line) => visibleWidth(line) <= 60));
    assert.match(screen, /short editor line 1/);
    assert.ok(screen.includes(CURSOR_MARKER), `${rows}-row editor retains its cursor-bearing viewport`);
    assert.match(screen, /Esc main · click focus · \/done close/);
    assert.match(rendered.at(-1) ?? "", /^╰─+╯$/);
    const bounds = overlay.getScreenBounds();
    assert.ok(bounds);
    assert.ok(bounds!.top >= 1 && bounds!.bottom <= rows);
    assert.equal(bounds!.bottom - bounds!.top + 1, rendered.length);
  }
});

test("ordinary unchanged tool-call arguments do not prepend an omission marker", () => {
  const projected = projectAssistantMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a.ts" } }],
    api: "openai-responses",
    provider: "test",
    model: "deterministic",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  });

  assert.equal(projected.content.length, 1);
  assert.equal(projected.content[0]?.type, "toolCall");
  assert.deepEqual(projected.content[0]?.type === "toolCall" ? projected.content[0].arguments : undefined, { path: "/tmp/a.ts" });
});

test("bounded text preserves complete UTF-8 code points at multilingual boundaries", () => {
  for (const value of [
    "prefix🙂🙂🙂tail",
    "עברית العربية 中文 日本語 한국어",
  ]) {
    for (let maxBytes = 1; maxBytes < Buffer.byteLength(value); maxBytes += 1) {
      const bounded = boundedText(value, maxBytes);
      assert.ok(Buffer.byteLength(bounded) <= maxBytes, `projection exceeds ${maxBytes} bytes`);
      assert.equal(bounded.includes("\uFFFD"), false, `invalid replacement character at ${maxBytes} bytes`);
      assert.equal(Buffer.from(bounded).toString("utf8"), bounded, `invalid UTF-8 at ${maxBytes} bytes`);
    }
  }
});

test("bounded projection is linear-time for huge text and 5k blocks", { timeout: 5_000 }, () => {
  const started = performance.now();
  const hugeTail = "LATEST-HUGE-TOKEN";
  const huge = `${"🙂abc".repeat(1_000_000)}${hugeTail}`;
  const bounded = boundedText(huge, 16_000);
  assert.ok(Buffer.byteLength(bounded) <= 16_000);
  assert.match(bounded, /LATEST-HUGE-TOKEN$/);

  const blocks = Array.from({ length: 5_000 }, (_, index) => ({
    type: "text" as const,
    text: `stress-block-${index}:${"界".repeat(20)}`,
  }));
  const projectedTool = projectToolResult({ content: blocks, isError: false });
  const projectedAssistant = projectAssistantMessage({
    role: "assistant",
    content: blocks,
    api: "openai-responses",
    provider: "test",
    model: "deterministic",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  });

  assert.ok(Buffer.byteLength(JSON.stringify(projectedTool)) <= 36_000);
  assert.ok(Buffer.byteLength(JSON.stringify(projectedAssistant.content)) <= 56_000);
  const escapedArguments = projectToolArguments({ query: "\u0000".repeat(100_000) });
  const escapedResult = projectToolResult({
    content: [{ type: "text", text: "\u0000".repeat(100_000) }],
    details: { trace: "\u0000".repeat(100_000) },
    isError: false,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(escapedArguments)) <= 24_000);
  assert.ok(Buffer.byteLength(JSON.stringify(escapedResult)) <= 36_000);
  assert.match(projectedTool.content.at(-1)?.text ?? "", /stress-block-4999/);
  assert.equal(projectedTool.content[0]?.text, "… older projected content omitted …");
  const latestAssistantBlock = projectedAssistant.content.at(-1);
  assert.match(
    latestAssistantBlock?.type === "text" ? latestAssistantBlock.text : "",
    /stress-block-4999/,
  );
  assert.ok(performance.now() - started < 4_000, "stress projection stays within the deterministic ceiling");
});

test("tool-result projection caps aggregate storage while retaining recent blocks", () => {
  const content = Array.from({ length: 800 }, (_, index) => ({
    type: "text" as const,
    text: `block-${index.toString().padStart(3, "0")}:${"界".repeat(30)}`,
  }));
  const projected = projectToolResult({ content, details: { source: "many-small-blocks" } });
  const storedBytes = Buffer.byteLength(JSON.stringify(projected));
  const projectedArgs = projectToolArguments({ query: "参".repeat(20_000) });
  const rowBytes = storedBytes + Buffer.byteLength(JSON.stringify(projectedArgs));

  assert.ok(storedBytes <= 36_000, `projected tool result uses ${storedBytes} bytes`);
  assert.ok(rowBytes <= 64_000, `retained args plus result use ${rowBytes} bytes`);
  assert.ok(projected.content.length < content.length, "aggregate block count is reduced");
  assert.equal(projected.content[0]?.text, "… older projected content omitted …");
  assert.match(projected.content.at(-1)?.text ?? "", /block-799/, "the useful recent tail is retained");

  const overlay = new BtwOverlay(fakeTui(32), plainTheme, {
    onSubmit() {},
    onMain() {},
    onClose() {},
    onAbort() {},
  });
  overlay.attachSession({
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp" },
  } as unknown as AgentSession);
  const hugeArgs = { query: "参".repeat(20_000) };
  overlay.handleSessionEvent({
    type: "tool_execution_start",
    toolCallId: "aggregate-tool",
    toolName: "read",
    args: hugeArgs,
  });
  overlay.handleSessionEvent({
    type: "tool_execution_end",
    toolCallId: "aggregate-tool",
    toolName: "read",
    result: { content },
    isError: false,
  });
  const rendered = overlay.render(60);
  assert.ok(rendered.every((line) => visibleWidth(line) <= 60), "bounded storage remains renderable");
});

test("overlay transcript projection is capped, keeps recent content, and marks omissions", () => {
  const overlay = new BtwOverlay(fakeTui(32), plainTheme, {
    onSubmit() {},
    onMain() {},
    onClose() {},
    onAbort() {},
  });
  overlay.attachSession({
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp" },
  } as unknown as AgentSession);

  for (let index = 0; index < 220; index += 1) overlay.addNotice(`projected notice ${index}`);
  overlay.render(60);
  overlay.scrollBy(10_000);
  const oldestProjection = overlay.render(60).join("\n");
  assert.match(oldestProjection, /older BTW transcript omitted/);
  assert.doesNotMatch(oldestProjection, /projected notice 0(?:\D|$)/);

  overlay.scrollBy(-10_000);
  const recentProjection = overlay.render(60).join("\n");
  assert.match(recentProjection, /projected notice 219/);
});

test("overlay keyboard scroll and escape distinguish active abort from idle /main", () => {
  let mainCalls = 0;
  let abortCalls = 0;
  const overlay = new BtwOverlay(fakeTui(24), plainTheme, {
    onSubmit() {},
    onMain: () => { mainCalls += 1; },
    onClose() {},
    onAbort: () => { abortCalls += 1; },
  });
  overlay.attachSession({
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp" },
  } as unknown as AgentSession);
  for (let index = 0; index < 30; index += 1) overlay.addNotice(`line ${index}`);
  overlay.render(60);
  overlay.scrollBy(3);
  assert.match(overlay.render(60).join("\n"), /↑ 3 older · PgDn latest/, "public wheel seam scrolls by the requested lines");
  overlay.scrollBy(-3);
  assert.doesNotMatch(overlay.render(60).join("\n"), /older · PgDn latest/, "negative deltas return toward the transcript tail");
  overlay.handleInput("\x1b[5~");
  assert.match(overlay.render(60).join("\n"), /↑/);
  overlay.handleInput("\x1b");
  assert.equal(mainCalls, 1);
  overlay.handleSessionEvent({ type: "agent_start" });
  overlay.handleInput("\x1b");
  assert.equal(abortCalls, 1);
});

function makeContext(
  ui: ExtensionUIContext,
  branch: SessionEntry[] = [{
    type: "model_change",
    id: "01",
    parentId: null,
    timestamp: "2026-07-13T00:00:00.000Z",
    provider: "test",
    modelId: "deterministic",
  }],
): ExtensionCommandContext {
  return {
    ui,
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/btw-controller",
    sessionManager: {
      getBranch: () => branch,
      getHeader: () => null,
      getSessionFile: () => undefined,
    },
    modelRegistry: {} as ExtensionCommandContext["modelRegistry"],
    model,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort() {},
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact() {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: "/tmp/btw-controller" }),
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    navigateTree: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    reload: async () => {},
  } as unknown as ExtensionCommandContext;
}

function makeUI(options: { failTerminalWrite?: string } = {}): {
  ui: ExtensionUIContext;
  focusCount: () => number;
  unfocusCount: () => number;
  terminalWrites: string[];
  emitTerminalInput(data: string): ReturnType<TerminalInputHandler>;
  listenerCount: () => number;
  notifications: Array<{ message: string; type: string | undefined }>;
  input(data: string): void;
  render(width?: number): string[];
} {
  let focused = 0;
  let unfocused = 0;
  let overlayFocused = true;
  const terminalWrites: string[] = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  let inputListener: TerminalInputHandler | undefined;
  let currentComponent: Component | undefined;
  const tui = fakeTui();
  tui.terminal.write = (data: string) => {
    terminalWrites.push(data);
    if (data === options.failTerminalWrite) throw new Error("terminal write failed");
  };
  const handle: OverlayHandle = {
    hide() {},
    setHidden() {},
    isHidden: () => false,
    focus: () => {
      focused += 1;
      overlayFocused = true;
    },
    unfocus: () => {
      unfocused += 1;
      overlayFocused = false;
    },
    isFocused: () => overlayFocused,
  };
  const ui = {
    theme: plainTheme,
    onTerminalInput(handler: TerminalInputHandler) {
      inputListener = handler;
      return () => {
        if (inputListener === handler) inputListener = undefined;
      };
    },
    async custom<T>(factory: (
      tui: TUI,
      theme: Theme,
      keybindings: TuiKeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>, options?: { onHandle?: (value: OverlayHandle) => void }) {
      return new Promise<T>((resolve, reject) => {
        let component: Component & { dispose?(): void } | undefined;
        const done = (value: T) => {
          component?.dispose?.();
          resolve(value);
        };
        Promise.resolve(factory(tui, plainTheme, {} as TuiKeybindingsManager, done))
          .then((created) => {
            component = created;
            currentComponent = created;
            created.render(57);
            options?.onHandle?.(handle);
          })
          .catch(reject);
      });
    },
    notify(message: string, type?: string) {
      notifications.push({ message, type });
    },
  } as unknown as ExtensionUIContext;
  return {
    ui,
    focusCount: () => focused,
    unfocusCount: () => unfocused,
    terminalWrites,
    emitTerminalInput: (data) => inputListener?.(data),
    listenerCount: () => inputListener ? 1 : 0,
    notifications,
    input: (data) => currentComponent?.handleInput?.(data),
    render: (width = 57) => currentComponent?.render(width) ?? [],
  };
}

test("controller closes its exact real-TUI overlay below a later overlay and settles custom", async () => {
  const tui = realTui();
  const base: Component = { invalidate() {}, render() { return ["BASE"]; } };
  tui.addChild(base);
  tui.setFocus(base);
  let terminalInput: TerminalInputHandler | undefined;
  let customSettlements = 0;
  const ui = {
    theme: plainTheme,
    onTerminalInput(handler: TerminalInputHandler) {
      terminalInput = handler;
      return () => {
        if (terminalInput === handler) terminalInput = undefined;
      };
    },
    custom<T>(factory: (
      tui: TUI,
      theme: Theme,
      keybindings: TuiKeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>, options?: {
      overlay?: boolean;
      overlayOptions?: Parameters<PiTUI["showOverlay"]>[1];
      onHandle?: (handle: OverlayHandle) => void;
    }): Promise<T> {
      const promise = new Promise<T>((resolve, reject) => {
        let component: (Component & { dispose?(): void }) | undefined;
        let closed = false;
        const done = (value: T) => {
          if (closed) return;
          closed = true;
          if (options?.overlay) tui.hideOverlay();
          resolve(value);
          component?.dispose?.();
        };
        Promise.resolve(factory(tui, plainTheme, {} as TuiKeybindingsManager, done))
          .then((created) => {
            if (closed) return;
            component = created;
            if (options?.overlay) {
              const handle = tui.showOverlay(created, options.overlayOptions);
              options.onHandle?.(handle);
            }
          })
          .catch(reject);
      });
      void promise.finally(() => { customSettlements += 1; });
      return promise;
    },
    notify() {},
  } as unknown as ExtensionUIContext;
  const runtime: ChildRuntimeHandle = {
    session: {
      getToolDefinition: () => undefined,
      sessionManager: { getCwd: () => "/tmp/btw-controller" },
    } as unknown as AgentSession,
    tempDir: "/tmp/fake",
    tempSessionFile: "/tmp/fake/session.jsonl",
    async prompt() {},
    async announceParentUpdate() { return false; },
    async abort() {},
    async close() {},
  };
  const controller = new BtwController({
    getThinkingLevel: () => "off",
    getActiveTools: () => ["read"],
  } as ExtensionAPI, async () => runtime);

  await controller.open("", makeContext(ui));
  assert.equal(tui.hasOverlay(), true, "BTW is mounted in the real overlay stack");
  const later: Component = { invalidate() {}, render() { return ["LATER OVERLAY"]; } };
  const laterHandle = tui.showOverlay(later, { anchor: "center", width: 24 });

  await controller.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(customSettlements, 1, "BTW's ctx.ui.custom promise settles exactly once");
  assert.equal(tui.hasOverlay(), true, "the later overlay remains mounted");
  laterHandle.hide();
  assert.equal(tui.hasOverlay(), false, "only the later overlay remained after BTW close");
});

test("controller creates one child, focuses/reuses it, submits optional text, and closes idempotently", async () => {
  let createCount = 0;
  let closeCount = 0;
  let abortCount = 0;
  let parentUpdateAnnouncements = 0;
  const announcedParentHeads: Array<string | undefined> = [];
  let releaseRuntime!: () => void;
  const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
  const prompts: string[] = [];
  let capturedInput: CreateChildRuntimeInput | undefined;
  const fakeSession = {
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp/btw-controller" },
  } as unknown as AgentSession;
  const runtimeFactory = async (input: CreateChildRuntimeInput): Promise<ChildRuntimeHandle> => {
    createCount += 1;
    capturedInput = input;
    await runtimeGate;
    return {
      session: fakeSession,
      tempDir: "/tmp/fake",
      tempSessionFile: "/tmp/fake/session.jsonl",
      async prompt(text) { prompts.push(text); },
      async announceParentUpdate() {
        parentUpdateAnnouncements += 1;
        announcedParentHeads.push(input.parentSessionManager.getBranch().at(-1)?.id);
        return true;
      },
      async abort() { abortCount += 1; },
      async close() {
        closeCount += 1;
        await closeGate;
      },
    };
  };
  const pi = {
    getThinkingLevel: () => "high",
    getActiveTools: () => ["read", "edit"],
  } as ExtensionAPI;
  const harness = makeUI();
  const parentBranch: SessionEntry[] = [{
    type: "model_change",
    id: "01",
    parentId: null,
    timestamp: "2026-07-13T00:00:00.000Z",
    provider: "test",
    modelId: "deterministic",
  }];
  const ctx = makeContext(harness.ui, parentBranch);
  const controller = new BtwController(pi, runtimeFactory);

  const firstOpen = controller.open("first prompt", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.isOpen, true, "opening becomes publicly visible once its overlay is mounted");
  const openingSubmission = controller.open("second prompt", ctx);
  parentBranch.push({
    type: "model_change",
    id: "02",
    parentId: "01",
    timestamp: "2026-07-13T00:00:01.000Z",
    provider: "test",
    modelId: "settled-during-open",
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseRuntime();
  await Promise.all([firstOpen, openingSubmission]);
  await controller.open("third focused prompt", ctx);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(createCount, 1);
  assert.deepEqual(prompts, ["first prompt", "second prompt", "third focused prompt"]);
  assert.equal(capturedInput?.snapshot.cwd, "/tmp/btw-controller");
  assert.equal(capturedInput?.snapshot.model, model);
  assert.equal(capturedInput?.snapshot.thinkingLevel, "high");
  assert.deepEqual(capturedInput?.snapshot.activeToolNames, ["read", "edit"]);
  assert.equal(capturedInput?.parentIsIdle(), true, "runtime receives the live command-context idle callback");
  assert.deepEqual(harness.terminalWrites.slice(0, 2), [
    BTW_MOUSE_SEQUENCES.enableButtonReporting,
    BTW_MOUSE_SEQUENCES.enableSgrReporting,
  ]);
  assert.equal(harness.listenerCount(), 1);
  assert.equal(parentUpdateAnnouncements, 1, "runtime attach immediately catches parent settlement during opening");
  assert.deepEqual(announcedParentHeads, ["02"]);
  await controller.announceParentUpdate();
  assert.equal(parentUpdateAnnouncements, 2, "later parent settlement is forwarded through the runtime handle");

  for (let index = 0; index < 30; index += 1) capturedInput?.callbacks.onNotice(`notice ${index}`);
  harness.render();
  const priorFocuses = harness.focusCount();
  assert.deepEqual(harness.emitTerminalInput("\x1b[<0;63;2M"), { consume: true });
  assert.equal(harness.focusCount(), priorFocuses + 1, "inside click focuses BTW");

  const focusesBeforeWheel = harness.focusCount();
  assert.deepEqual(harness.emitTerminalInput("\x1b[<64;63;2M"), { consume: true });
  assert.match(harness.render().join("\n"), /↑ 3 older · PgDn latest/, "inside focused wheel-up scrolls the actual overlay by three lines");
  assert.equal(harness.focusCount(), focusesBeforeWheel, "wheel input does not refocus BTW");
  assert.equal(harness.unfocusCount(), 0, "wheel input does not unfocus BTW");
  assert.deepEqual(harness.emitTerminalInput("\x1b[<65;63;2M"), { consume: true });
  assert.doesNotMatch(harness.render().join("\n"), /older · PgDn latest/, "inside focused wheel-down returns toward the tail");

  assert.deepEqual(harness.emitTerminalInput("\x1b[<64;62;2M"), { consume: true });
  assert.doesNotMatch(harness.render().join("\n"), /older · PgDn latest/, "outside wheel input is consumed without scrolling");
  assert.deepEqual(harness.emitTerminalInput("\x1b[<0;62;2M"), { consume: true });
  assert.equal(harness.unfocusCount(), 1, "outside click returns focus to the main editor");
  assert.deepEqual(harness.emitTerminalInput("\x1b[<64;63;2M"), { consume: true });
  assert.doesNotMatch(harness.render().join("\n"), /older · PgDn latest/, "unfocused wheel input is consumed without scrolling BTW");
  assert.equal(harness.unfocusCount(), 1, "wheel input never changes focus");

  const firstClose = controller.close();
  const secondClose = controller.close();
  assert.equal(firstClose, secondClose);
  assert.equal(controller.isOpen, true, "closing keeps the mounted pane visible until runtime cleanup settles");
  for (const char of "must not submit") harness.input(char);
  harness.input("\r");
  assert.deepEqual(prompts, ["first prompt", "second prompt", "third focused prompt"], "closing pane rejects further submissions");
  releaseClose();
  await firstClose;
  assert.equal(closeCount, 1);
  assert.equal(abortCount, 0);
  assert.equal(controller.isOpen, false);
  assert.equal(harness.listenerCount(), 0);
  assert.deepEqual(harness.terminalWrites.slice(-2), [
    BTW_MOUSE_SEQUENCES.disableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableButtonReporting,
  ]);
});

test("controller removes mouse input and discards generation prompts when closing during child opening", async () => {
  let resolveRuntime!: (runtime: ChildRuntimeHandle) => void;
  const runtimePromise = new Promise<ChildRuntimeHandle>((resolve) => {
    resolveRuntime = resolve;
  });
  let closeCount = 0;
  const prompts: string[] = [];
  const fakeSession = {
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp/btw-controller" },
  } as unknown as AgentSession;
  const runtime: ChildRuntimeHandle = {
    session: fakeSession,
    tempDir: "/tmp/fake",
    tempSessionFile: "/tmp/fake/session.jsonl",
    async prompt(text) { prompts.push(text); },
    async announceParentUpdate() { return false; },
    async abort() {},
    async close() { closeCount += 1; },
  };
  const pi = {
    getThinkingLevel: () => "high",
    getActiveTools: () => ["read"],
  } as ExtensionAPI;
  const harness = makeUI();
  const controller = new BtwController(pi, () => runtimePromise);

  const opening = controller.open("stale opening prompt", makeContext(harness.ui));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.isOpen, true, "the mounted overlay exposes the opening phase through public behavior");
  assert.equal(harness.listenerCount(), 1);

  const closing = controller.close();
  assert.equal(controller.isOpen, true, "close during opening retains the pane while child creation settles");
  assert.equal(harness.listenerCount(), 0, "listener is removed before slow runtime creation settles");
  assert.deepEqual(harness.terminalWrites.slice(-2), [
    BTW_MOUSE_SEQUENCES.disableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableButtonReporting,
  ]);

  resolveRuntime(runtime);
  await Promise.all([opening, closing]);
  assert.equal(controller.isOpen, false);
  assert.equal(closeCount, 1, "superseded runtime is closed exactly once");
  assert.deepEqual(prompts, [], "generation-owned opening prompts are discarded, not submitted to the stale runtime");
});

test("repeated pre-overlay snapshot failures retain no prompt for a later successful open", async () => {
  const harness = makeUI();
  const prompts: string[] = [];
  let runtimeCreates = 0;
  const runtime: ChildRuntimeHandle = {
    session: {
      getToolDefinition: () => undefined,
      sessionManager: { getCwd: () => "/tmp/btw-controller" },
    } as unknown as AgentSession,
    tempDir: "/tmp/fake",
    tempSessionFile: "/tmp/fake/session.jsonl",
    async prompt(text) { prompts.push(text); },
    async announceParentUpdate() { return false; },
    async abort() {},
    async close() {},
  };
  const controller = new BtwController({
    getThinkingLevel: () => "off",
    getActiveTools: () => ["read"],
  } as ExtensionAPI, async () => {
    runtimeCreates += 1;
    return runtime;
  });
  const noModel = makeContext(harness.ui);
  Object.assign(noModel, { model: undefined });

  await controller.open("stale snapshot prompt one", noModel);
  await controller.open("stale snapshot prompt two", noModel);
  assert.equal(runtimeCreates, 0, "snapshot failure occurs before overlay/runtime creation");
  assert.equal(controller.isOpen, false);

  await controller.open("fresh prompt", makeContext(harness.ui));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, ["fresh prompt"], "failed snapshot prompts never replay");
  await controller.close();
});

test("controller restores mouse state and never replays prompts from a failed open", async () => {
  const harness = makeUI();
  const pi = {
    getThinkingLevel: () => "high",
    getActiveTools: () => ["read"],
  } as ExtensionAPI;
  const prompts: string[] = [];
  let createCount = 0;
  const runtime = {
    session: {
      getToolDefinition: () => undefined,
      sessionManager: { getCwd: () => "/tmp/btw-controller" },
    } as unknown as AgentSession,
    tempDir: "/tmp/fake",
    tempSessionFile: "/tmp/fake/session.jsonl",
    async prompt(text: string) { prompts.push(text); },
    async announceParentUpdate() { return false; },
    async abort() {},
    async close() {},
  } satisfies ChildRuntimeHandle;
  const controller = new BtwController(pi, async () => {
    createCount += 1;
    if (createCount === 1) throw new Error("child creation failed");
    return runtime;
  });

  await controller.open("stale failed prompt", makeContext(harness.ui));
  assert.equal(controller.isOpen, false);
  assert.equal(harness.listenerCount(), 0);
  assert.deepEqual(harness.terminalWrites, [
    BTW_MOUSE_SEQUENCES.enableButtonReporting,
    BTW_MOUSE_SEQUENCES.enableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableButtonReporting,
  ]);

  await controller.open("fresh prompt", makeContext(harness.ui));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, ["fresh prompt"]);
  await controller.close();
});

test("controller surfaces missing inherited active tools visibly", async () => {
  const harness = makeUI();
  const missingTool = "missing_parent_runtime_tool";
  const controller = new BtwController({
    getThinkingLevel: () => "off",
    getActiveTools: () => [missingTool],
  } as ExtensionAPI, async () => {
    throw new Error(`BTW could not inherit active tool(s): ${missingTool}`);
  });

  await controller.open("", makeContext(harness.ui));
  assert.equal(controller.isOpen, false);
  assert.deepEqual(harness.notifications, [{
    message: `BTW child failed to open: BTW could not inherit active tool(s): ${missingTool}`,
    type: "error",
  }]);
});

test("controller restores mouse state when overlay opening fails", async () => {
  let runtimeCreates = 0;
  const harness = makeUI({ failTerminalWrite: BTW_MOUSE_SEQUENCES.enableSgrReporting });
  const pi = {
    getThinkingLevel: () => "high",
    getActiveTools: () => ["read"],
  } as ExtensionAPI;
  const controller = new BtwController(pi, async () => {
    runtimeCreates += 1;
    throw new Error("runtime must not start");
  });

  await controller.open("", makeContext(harness.ui));
  assert.equal(controller.isOpen, false);
  assert.equal(runtimeCreates, 0);
  assert.equal(harness.listenerCount(), 0);
  assert.deepEqual(harness.terminalWrites, [
    BTW_MOUSE_SEQUENCES.enableButtonReporting,
    BTW_MOUSE_SEQUENCES.enableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableButtonReporting,
  ]);
});
