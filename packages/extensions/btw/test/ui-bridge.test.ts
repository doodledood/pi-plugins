import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  TUI as PiTUI,
  type Component,
  type KeybindingsManager,
  type OverlayHandle,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";
import { ChildUIBridge } from "../src/ui-bridge.ts";

const component: Component = {
  invalidate() {},
  render() { return []; },
};

const theme = {} as Theme;
const tui = { requestRender() {} } as TUI;
const keybindings = {} as KeybindingsManager;

function realTui(): PiTUI {
  const terminal = {
    rows: 30,
    columns: 100,
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

test("typed child custom UI cancellation rejects with AbortError instead of resolving undefined as T", async () => {
  const parent = {
    theme,
    custom<T>(factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        Promise.resolve(factory(tui, theme, keybindings, resolve)).catch(reject);
      });
    },
  } as unknown as ExtensionUIContext;
  const bridge = new ChildUIBridge(parent, {
    onNotice() {},
    onStatus() {},
  });

  const result: Promise<number> = bridge.context.custom<number>(() => component);
  await new Promise((resolve) => setImmediate(resolve));
  bridge.dispose();

  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
});

test("disposed bridge rejects session-shutdown custom calls immediately without parent UI work", async () => {
  let parentCalls = 0;
  const parent = {
    theme,
    custom() {
      parentCalls += 1;
      return Promise.resolve(undefined);
    },
  } as unknown as ExtensionUIContext;
  const bridge = new ChildUIBridge(parent, { onNotice() {}, onStatus() {} });
  bridge.dispose();

  await assert.rejects(bridge.context.custom<number>(() => component), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.equal(parentCalls, 0);
});

test("child custom overlay cancellation removes its exact handle and preserves a later overlay", async () => {
  const real = realTui();
  const parent = {
    theme,
    custom<T>(factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => Component | Promise<Component>, options?: {
      overlay?: boolean;
      onHandle?: (handle: OverlayHandle) => void;
    }): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        let closed = false;
        const done = (value: T) => {
          if (closed) return;
          closed = true;
          if (options?.overlay) real.hideOverlay();
          resolve(value);
        };
        Promise.resolve(factory(real, theme, keybindings, done)).then((created) => {
          if (closed) return;
          const handle = real.showOverlay(created);
          options?.onHandle?.(handle);
        }).catch(reject);
      });
    },
  } as unknown as ExtensionUIContext;
  const bridge = new ChildUIBridge(parent, { onNotice() {}, onStatus() {} });
  const childPromise = bridge.context.custom<number>(() => component, { overlay: true });
  await new Promise((resolve) => setImmediate(resolve));
  const laterHandle = real.showOverlay({ invalidate() {}, render() { return ["later"]; } });

  bridge.dispose();
  await assert.rejects(childPromise, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
  assert.equal(real.hasOverlay(), true, "later overlay remains after exact child settlement");
  laterHandle.hide();
  assert.equal(real.hasOverlay(), false);
});
