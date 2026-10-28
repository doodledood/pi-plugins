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
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  CURSOR_MARKER,
  Editor,
  KeybindingsManager,
  ScrollView,
  TUI_KEYBINDINGS,
  Text,
  TuiAltScreen,
  visibleWidth,
  VStack,
  type Component,
  type KeybindingsManager as TuiKeybindingsManager,
  type OverlayHandle,
  type Terminal,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { assertSupportedPiVersion, BtwController, MINIMUM_PI_VERSION } from "../index.ts";
import type { QueuedPrompt } from "../src/prompt-coordinator.ts";
import type { ChildRuntimeHandle, CreateChildRuntimeInput } from "../src/runtime.ts";
import {
  boundedText,
  BtwOverlay,
  projectAssistantMessage,
  projectToolArguments,
  projectToolResult,
} from "../src/ui.ts";

initTheme("dark", false);

// Pi's interactive host hands overlays its app keybindings; these are the BTW-relevant defaults.
const testKeybindings = new KeybindingsManager({
  ...TUI_KEYBINDINGS,
  "app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
  "app.message.dequeue": { defaultKeys: "alt+up", description: "Restore queued messages" },
});

test("runtime version guard accepts the minimum Pi host and newer", () => {
  assert.doesNotThrow(() => assertSupportedPiVersion(MINIMUM_PI_VERSION));
  assert.doesNotThrow(() => assertSupportedPiVersion("1.4.1"));
  assert.doesNotThrow(() => assertSupportedPiVersion("1.5.0"));
  assert.doesNotThrow(() => assertSupportedPiVersion("2.0.0"));
  assert.throws(
    () => assertSupportedPiVersion("1.3.9"),
    /requires Pi 1\.4\.0 or newer; running Pi is 1\.3\.9/,
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

function fakeTui(rows = 38, columns = 120): TUI {
  return {
    terminal: { rows, columns, write() {} },
    children: [],
    requestRender() {},
  } as unknown as TUI;
}

type FullscreenHarness = {
  tui: TuiAltScreen;
  terminalWrites: string[];
  input(data: string): void;
};

function realTui(rows = 38, columns = 120): FullscreenHarness {
  let onInput: (data: string) => void = () => {};
  const terminalWrites: string[] = [];
  const terminal = {
    rows,
    columns,
    kittyProtocolActive: false,
    start(input: (data: string) => void) { onInput = input; },
    stop() {},
    async drainInput() {},
    write(data: string) { terminalWrites.push(data); },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  } satisfies Terminal;
  const tui = new TuiAltScreen(terminal);
  return { tui, terminalWrites, input: (data) => onInput(data) };
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
  const overlay = new BtwOverlay(tui, plainTheme, testKeybindings, {
    onDequeue() {},
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
  overlay.handleSessionEvent({ type: "agent_settled", aborted: false });

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
    assert.match(screen, /click in\/out to focus/);
    assert.match(screen, /Enter send · Esc main · \/done close/, "idle: the keys that matter now");
  }
  typeText(overlay, "hello child");
  assert.deepEqual(submitted, ["hello child"]);
  typeText(overlay, "/main");
  typeText(overlay, "done");
  assert.equal(mainCalls, 1);
  assert.equal(closeCalls, 1);
  assert.equal(abortCalls, 0);
});

test("long multiline editor preserves Pi Editor's cursor-aware top viewport", () => {
  const overlay = new BtwOverlay(fakeTui(40), plainTheme, testKeybindings, {
    onDequeue() {},
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
    const overlay = new BtwOverlay(fakeTui(rows, 80), plainTheme, testKeybindings, {
      onDequeue() {},
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
    assert.match(screen, /Esc main · \/done close/);
    assert.match(rendered.at(-1) ?? "", /^╰─+╯$/);
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

  const overlay = new BtwOverlay(fakeTui(32), plainTheme, testKeybindings, {
    onDequeue() {},
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
  const overlay = new BtwOverlay(fakeTui(32), plainTheme, testKeybindings, {
    onDequeue() {},
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

function mouse(type: TuiMouseEvent["type"], extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type,
    button: type === "wheel" ? "none" : "left",
    x: 2,
    y: 2,
    screenX: 60,
    screenY: 4,
    width: 50,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    ...extra,
  };
}

test("overlay mouse: wheel scrolls by Pi's delta, a click takes focus, press and drag stay with Pi's selection", () => {
  const overlay = new BtwOverlay(fakeTui(24), plainTheme, testKeybindings, {
    onDequeue() {},
    onSubmit() {},
    onMain() {},
    onClose() {},
    onAbort() {},
  });
  overlay.attachSession({
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp" },
  } as unknown as AgentSession);
  for (let index = 0; index < 30; index += 1) overlay.addNotice(`line ${index}`);
  overlay.render(60);

  assert.deepEqual(overlay.handleMouse(mouse("wheel", { wheelDelta: -3 })), { handled: true });
  assert.match(overlay.render(60).join("\n"), /↑ 3 older · PgDn latest/, "negative wheel delta scrolls toward older lines");
  assert.deepEqual(overlay.handleMouse(mouse("wheel", { wheelDelta: 3 })), { handled: true });
  assert.doesNotMatch(overlay.render(60).join("\n"), /older · PgDn latest/, "positive wheel delta returns toward the tail");
  assert.deepEqual(overlay.handleMouse(mouse("click")), { focus: true });
  assert.equal(overlay.handleMouse(mouse("click", { button: "right" })), undefined);
  assert.equal(overlay.handleMouse(mouse("press")), undefined);
  assert.equal(overlay.handleMouse(mouse("drag")), undefined);
});

test("overlay queues like main: Enter steers, the follow-up key follows up, the dequeue key takes them back", () => {
  const submitted: Array<[string, string]> = [];
  let dequeues = 0;
  const overlay = new BtwOverlay(fakeTui(30), plainTheme, testKeybindings, {
    onSubmit: (text, mode) => submitted.push([text, mode]),
    onDequeue: () => { dequeues += 1; },
    onMain() {},
    onClose() {},
    onAbort() {},
  });
  overlay.focused = true;

  // Input is taken while the child is still loading.
  assert.match(overlay.render(60).join("\n"), /Start typing/);
  assert.match(overlay.render(60).join("\n"), /Enter queue · Esc main/);
  typeText(overlay, "early");
  assert.deepEqual(submitted, [["early", "steer"]], "Enter submits before the child is ready");

  overlay.attachSession({
    getToolDefinition: () => undefined,
    sessionManager: { getCwd: () => "/tmp" },
  } as unknown as AgentSession);
  overlay.handleSessionEvent({ type: "agent_start" });
  assert.match(overlay.render(60).join("\n"), /Enter steer · alt\+enter follow-up · Esc stop/);

  for (const char of "later") overlay.handleInput(char);
  overlay.handleInput("\x1b\r"); // alt+enter
  assert.deepEqual(submitted.at(-1), ["later", "followUp"]);

  overlay.setQueue([{ text: "fix that\nsecond line", mode: "steer" }, { text: "later", mode: "followUp" }]);
  const screen = overlay.render(60).join("\n");
  assert.match(screen, /Steering: fix that/);
  assert.doesNotMatch(screen, /second line/, "one line per queued prompt");
  assert.match(screen, /Follow-up: later/);
  assert.match(screen, /alt\+up to edit all queued messages/);

  overlay.handleInput("\x1b[1;3A"); // alt+up
  assert.equal(dequeues, 1);
  for (const char of "draft") overlay.handleInput(char);
  overlay.restoreToEditor([{ text: "fix that", mode: "steer" }, { text: "later", mode: "followUp" }]);
  overlay.setQueue([]);
  const restored = overlay.render(60).join("\n");
  assert.match(restored, /fix that/);
  assert.match(restored, /draft/, "the draft stays, after the restored prompts");
  assert.doesNotMatch(restored, /Steering:/);
});

test("overlay keyboard scroll and escape distinguish active abort from idle /main", () => {
  let mainCalls = 0;
  let abortCalls = 0;
  const overlay = new BtwOverlay(fakeTui(24), plainTheme, testKeybindings, {
    onDequeue() {},
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

function makeUI(options: { failCustom?: boolean } = {}): {
  ui: ExtensionUIContext;
  focusCount: () => number;
  unfocusCount: () => number;
  notifications: Array<{ message: string; type: string | undefined }>;
  input(data: string): void;
  render(width?: number): string[];
} {
  let focused = 0;
  let unfocused = 0;
  let overlayFocused = true;
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  let currentComponent: Component | undefined;
  const tui = fakeTui();
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
    getBounds: () => undefined,
  };
  const ui = {
    theme: plainTheme,
    async custom<T>(factory: (
      tui: TUI,
      theme: Theme,
      keybindings: TuiKeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>, customOptions?: { onHandle?: (value: OverlayHandle) => void }) {
      if (options.failCustom) throw new Error("overlay host unavailable");
      return new Promise<T>((resolve, reject) => {
        let component: Component & { dispose?(): void } | undefined;
        const done = (value: T) => {
          component?.dispose?.();
          resolve(value);
        };
        Promise.resolve(factory(tui, plainTheme, testKeybindings, done))
          .then((created) => {
            component = created;
            currentComponent = created;
            created.render(57);
            customOptions?.onHandle?.(handle);
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
    notifications,
    input: (data) => currentComponent?.handleInput?.(data),
    render: (width = 57) => currentComponent?.render(width) ?? [],
  };
}

test("controller closes its exact real-TUI overlay below a later overlay and settles custom", async () => {
  const { tui } = realTui();
  const base: Component = { invalidate() {}, render() { return ["BASE"]; } };
  tui.addChild(base);
  tui.setFocus(base);
  let customSettlements = 0;
  const ui = {
    theme: plainTheme,
    custom<T>(factory: (
      tui: TUI,
      theme: Theme,
      keybindings: TuiKeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>, options?: {
      overlay?: boolean;
      overlayOptions?: Parameters<TuiAltScreen["showOverlay"]>[1];
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
        Promise.resolve(factory(tui, plainTheme, testKeybindings, done))
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
    childSessionDir: "/tmp/fake",
    childSessionFile: "/tmp/fake/session.jsonl",
    async prompt() {},
    queued: () => [],
    dequeue: () => [],
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
      childSessionDir: "/tmp/fake",
      childSessionFile: "/tmp/fake/session.jsonl",
      async prompt(text) { prompts.push(text); },
      queued: () => [],
      dequeue: () => [],
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
  assert.equal(parentUpdateAnnouncements, 1, "runtime attach immediately catches parent settlement during opening");
  assert.deepEqual(announcedParentHeads, ["02"]);
  await controller.announceParentUpdate();
  assert.equal(parentUpdateAnnouncements, 2, "later parent settlement is forwarded through the runtime handle");

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
});

test("controller takes input while the child loads, shows the queue, and Esc returns it to the editor", async () => {
  let releaseRuntime!: () => void;
  const runtimeGate = new Promise<void>((resolve) => { releaseRuntime = resolve; });
  const prompts: Array<[string, string | undefined]> = [];
  let childQueue: QueuedPrompt[] = [];
  let abortCount = 0;
  let capturedInput: CreateChildRuntimeInput | undefined;
  const controller = new BtwController({
    getThinkingLevel: () => "off",
    getActiveTools: () => ["read"],
  } as ExtensionAPI, async (input) => {
    capturedInput = input;
    await runtimeGate;
    return {
      session: {
        getToolDefinition: () => undefined,
        sessionManager: { getCwd: () => "/tmp/btw-controller" },
      } as unknown as AgentSession,
      childSessionDir: "/tmp/fake",
      childSessionFile: "/tmp/fake/session.jsonl",
      async prompt(text, mode) { prompts.push([text, mode]); },
      queued: () => [...childQueue],
      dequeue: () => childQueue.splice(0),
      async announceParentUpdate() { return false; },
      async abort() { abortCount += 1; },
      async close() {},
    };
  });
  const harness = makeUI();
  const opening = controller.open("", makeContext(harness.ui));
  await new Promise((resolve) => setImmediate(resolve));

  for (const char of "early question") harness.input(char);
  harness.input("\r");
  assert.match(harness.render(80).join("\n"), /Steering: early question/, "a prompt typed while loading is visibly queued");
  assert.deepEqual(prompts, []);

  releaseRuntime();
  await opening;
  assert.deepEqual(prompts, [["early question", "steer"]], "the queued prompt is sent the moment the child is ready");
  assert.doesNotMatch(harness.render(80).join("\n"), /Steering:/);

  capturedInput!.callbacks.onEvent({ type: "agent_start" });
  childQueue = [{ text: "steer this", mode: "steer" }, { text: "then this", mode: "followUp" }];
  capturedInput!.callbacks.onQueueChange();
  const running = harness.render(80).join("\n");
  assert.match(running, /Steering: steer this/);
  assert.match(running, /Follow-up: then this/);

  harness.input("\x1b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(abortCount, 1, "Esc stops the running child");
  const afterAbort = harness.render(80).join("\n");
  assert.doesNotMatch(afterAbort, /Steering:/);
  assert.match(afterAbort, /steer this/, "queued prompts go back to the editor instead of being lost");
  assert.match(afterAbort, /then this/);
  await controller.close();
});

test("controller discards generation prompts when closing during child opening", async () => {
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
    childSessionDir: "/tmp/fake",
    childSessionFile: "/tmp/fake/session.jsonl",
    async prompt(text) { prompts.push(text); },
    queued: () => [],
    dequeue: () => [],
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

  const closing = controller.close();
  assert.equal(controller.isOpen, true, "close during opening retains the pane while child creation settles");

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
    childSessionDir: "/tmp/fake",
    childSessionFile: "/tmp/fake/session.jsonl",
    async prompt(text) { prompts.push(text); },
    queued: () => [],
    dequeue: () => [],
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

test("controller never replays prompts from a failed open", async () => {
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
    childSessionDir: "/tmp/fake",
    childSessionFile: "/tmp/fake/session.jsonl",
    async prompt(text: string) { prompts.push(text); },
    queued: () => [],
    dequeue: () => [],
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

  await controller.open("fresh prompt", makeContext(harness.ui));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prompts, ["fresh prompt"]);
  await controller.close();
});

test("controller surfaces child construction failures visibly", async () => {
  const harness = makeUI();
  const controller = new BtwController({
    getThinkingLevel: () => "off",
    getActiveTools: () => ["read"],
  } as ExtensionAPI, async () => {
    throw new Error("BTW child model does not match the parent model.");
  });

  await controller.open("", makeContext(harness.ui));
  assert.equal(controller.isOpen, false);
  assert.deepEqual(harness.notifications, [{
    message: "BTW child failed to open: BTW child model does not match the parent model.",
    type: "error",
  }]);
});

test("controller surfaces overlay opening failures without starting a runtime", async () => {
  let runtimeCreates = 0;
  const harness = makeUI({ failCustom: true });
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
  assert.deepEqual(harness.notifications, [{ message: "BTW overlay failed: overlay host unavailable", type: "error" }]);
});

/** Pi's fullscreen interactive layout: plain containers mounted on the TUI, laid out by createChatViewport's shape. */
function mountPiLikeMainScreen(tui: TuiAltScreen) {
  const editorTheme = {
    borderColor: (text: string) => text,
    selectList: {
      selectedPrefix: (text: string) => text,
      selectedText: (text: string) => text,
      description: (text: string) => text,
      scrollInfo: (text: string) => text,
      noMatch: (text: string) => text,
    },
  };
  const document = new Container();
  document.addChild(new Text(Array.from({ length: 80 }, (_, index) => `main transcript ${index}`).join("\n"), 0, 0));
  const pending = new Container();
  const status = new Container();
  const editorContainer = new Container();
  const mainEditor = new Editor(tui, editorTheme);
  const mainSubmissions: string[] = [];
  mainEditor.onSubmit = (text) => mainSubmissions.push(text);
  editorContainer.addChild(mainEditor);
  const footer = new Container();
  footer.addChild(new Text("footer", 0, 0));
  const root = new VStack([
    { component: new ScrollView(document, { follow: "end", primary: true }), basis: 0, grow: 1, shrink: 1, minSize: 1 },
    {
      component: new VStack([
        { component: pending, shrink: 1, minSize: 0 },
        { component: status, shrink: 1, minSize: 0 },
        { component: editorContainer, shrink: 1, minSize: 3 },
        { component: footer, shrink: 1, minSize: 0 },
      ]),
      basis: "auto",
      grow: 0,
      shrink: 1,
      minSize: 1,
    },
  ]);
  for (const component of [document, pending, status, editorContainer, footer]) tui.addChild(component);
  tui.setLayoutRoot(root);
  tui.setFocus(mainEditor);
  return { mainEditor, mainSubmissions };
}

function overlayHostUI(tui: TuiAltScreen, onHandle: (handle: OverlayHandle) => void): ExtensionUIContext {
  return {
    theme: plainTheme,
    custom<T>(factory: (
      tui: TUI,
      theme: Theme,
      keybindings: TuiKeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>, options?: {
      overlayOptions?: Parameters<TuiAltScreen["showOverlay"]>[1];
      onHandle?: (handle: OverlayHandle) => void;
    }): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let component: (Component & { dispose?(): void }) | undefined;
        const done = (value: T) => {
          tui.hideOverlay();
          resolve(value);
          component?.dispose?.();
        };
        Promise.resolve(factory(tui, plainTheme, testKeybindings, done))
          .then((created) => {
            component = created;
            const handle = tui.showOverlay(created, options?.overlayOptions);
            onHandle(handle);
            options?.onHandle?.(handle);
          })
          .catch(reject);
      });
    },
    notify() {},
  } as unknown as ExtensionUIContext;
}

// Holds docs/adr/20261014-use-pi-native-mouse-routing-for-overlays.md — weakening this test reverses that decision.
test("fullscreen Pi: wheel scrolls BTW, clicks move focus both ways and it sticks, and submit stays in BTW", async () => {
  const { tui, terminalWrites, input } = realTui(30, 100);
  const { mainEditor, mainSubmissions } = mountPiLikeMainScreen(tui);
  const childPrompts: string[] = [];
  let notice: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
  const controller = new BtwController({
    getThinkingLevel: () => "off",
    getActiveTools: () => ["read"],
  } as ExtensionAPI, async (runtimeInput) => {
    notice = runtimeInput.callbacks.onNotice;
    return {
      session: {
        getToolDefinition: () => undefined,
        sessionManager: { getCwd: () => "/tmp/btw-fullscreen" },
      } as unknown as AgentSession,
      childSessionDir: "/tmp/fake",
      childSessionFile: "/tmp/fake/session.jsonl",
      async prompt(text) { childPrompts.push(text); },
      queued: () => [],
      dequeue: () => [],
      async announceParentUpdate() { return false; },
      async abort() {},
      async close() {},
    };
  });
  const originalHandlers = tui.children.map((child) => child.handleMouse);
  tui.start();
  const writesBeforeOpen = terminalWrites.length;
  try {
    let btwHandle: OverlayHandle | undefined;
    await controller.open("", makeContext(overlayHostUI(tui, (handle) => { btwHandle = handle; })));
    await new Promise((resolve) => setImmediate(resolve));
    for (let index = 0; index < 60; index += 1) notice?.(`btw line ${index}`);
    tui.renderNow(true);

    const bounds = btwHandle?.getBounds();
    assert.ok(btwHandle && bounds, "BTW is mounted as a fullscreen overlay");
    const insideX = bounds.col + Math.floor(bounds.width / 2) + 1;
    const insideY = bounds.row + Math.floor(bounds.height / 3) + 1;
    const sgr = (button: number, x: number, y: number, release = false) => `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
    const click = (x: number, y: number) => {
      input(sgr(0, x, y));
      input(sgr(0, x, y, true));
      tui.renderNow();
    };
    const screen = () => tui.getScreenLines().join("\n");
    const isBtwFocused = () => btwHandle!.isFocused();
    assert.equal(isBtwFocused(), true, "BTW opens focused");

    const mainTopBefore = tui.viewportTop;
    input(sgr(64, insideX, insideY));
    tui.renderNow();
    assert.match(screen(), /↑ \d+ older · PgDn latest/, "wheel over BTW scrolls the BTW transcript");
    assert.equal(tui.viewportTop, mainTopBefore, "wheel over BTW leaves the main transcript where it was");
    assert.equal(isBtwFocused(), true, "the wheel does not move focus");

    click(10, 5);
    assert.equal(isBtwFocused(), false, "a click on the main transcript releases BTW");
    input("m");
    assert.equal(mainEditor.getText(), "m", "keys then reach the main editor");
    input("n");
    assert.equal(mainEditor.getText(), "mn", "and focus stays on main for later keys");

    click(insideX, insideY);
    assert.equal(isBtwFocused(), true, "a click on BTW focuses it");
    for (const char of "side question") input(char);
    input("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(childPrompts, ["side question"], "submit from BTW goes to the child");
    assert.deepEqual(mainSubmissions, [], "and never to the main editor");
    assert.equal(mainEditor.getText(), "mn");

    const editorRow = tui.getScreenLines().findIndex((line) => line.includes("mn")) + 1;
    assert.ok(editorRow > 0, "main editor row is on screen");
    click(40, editorRow);
    assert.equal(isBtwFocused(), false, "a click on the main editor focuses main");
    input("o");
    assert.equal(mainEditor.getText(), "mno", "focus sticks on main instead of snapping back to BTW");

    await controller.close();
    assert.deepEqual(tui.children.map((child) => child.handleMouse), originalHandlers, "closing restores Pi's main-screen handlers");
    assert.equal(
      terminalWrites.slice(writesBeforeOpen).some((data) => /\x1b\[\?100[0-6][hl]/.test(data)),
      false,
      "BTW leaves terminal mouse reporting to Pi",
    );
  } finally {
    await controller.close();
    tui.stop();
  }
});
