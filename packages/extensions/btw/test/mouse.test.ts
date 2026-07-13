import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  BTW_MOUSE_SEQUENCES,
  containsPoint,
  enableBtwMouseInput,
  parseSgrMouseInput,
  type ScreenBounds,
} from "../src/mouse.ts";

test("SGR parser accepts primary and wheel presses while preserving release, motion, and other classifications", () => {
  assert.deepEqual(parseSgrMouseInput("\x1b[<0;42;9M"), {
    kind: "primary-press",
    button: 0,
    column: 42,
    row: 9,
  });
  assert.deepEqual(parseSgrMouseInput("\x1b[<20;1;1M"), {
    kind: "primary-press",
    button: 20,
    column: 1,
    row: 1,
  });
  assert.deepEqual(parseSgrMouseInput("\x1b[<64;42;9M"), {
    kind: "wheel-up",
    button: 64,
    column: 42,
    row: 9,
  });
  assert.deepEqual(parseSgrMouseInput("\x1b[<69;42;9M"), {
    kind: "wheel-down",
    button: 69,
    column: 42,
    row: 9,
  }, "wheel modifiers are normalized before classification");
  assert.equal(parseSgrMouseInput("plain text"), undefined);

  for (const sequence of [
    "\x1b[<0;42;9m", // primary release
    "\x1b[<64;42;9m", // wheel release
    "\x1b[<32;42;9M", // primary motion
    "\x1b[<96;42;9M", // wheel motion
    "\x1b[<1;42;9M", // middle press
    "\x1b[<2;42;9M", // secondary press
  ]) {
    assert.equal(parseSgrMouseInput(sequence)?.kind, "other", sequence);
  }

  for (const sequence of [
    "\x1b[<0;42M",
    "\x1b[<x;42;9M",
    "\x1b[<0;0;9M",
    "\x1b[<0;42;0M",
    `\x1b[<${"9".repeat(70)};1;1M`,
  ]) {
    assert.deepEqual(parseSgrMouseInput(sequence), { kind: "malformed" }, sequence);
  }
});

test("screen bounds include their border cells", () => {
  const bounds: ScreenBounds = { left: 20, top: 3, right: 40, bottom: 18 };
  assert.equal(containsPoint(bounds, 20, 3), true);
  assert.equal(containsPoint(bounds, 40, 18), true);
  assert.equal(containsPoint(bounds, 19, 3), false);
  assert.equal(containsPoint(bounds, 40, 19), false);
});

function mouseHarness(options: { failOnWrite?: string } = {}) {
  let listener: TerminalInputHandler | undefined;
  let unsubscribeCount = 0;
  const writes: string[] = [];
  const ui = {
    onTerminalInput(handler: TerminalInputHandler) {
      listener = handler;
      return () => {
        unsubscribeCount += 1;
        listener = undefined;
      };
    },
  } as Pick<ExtensionUIContext, "onTerminalInput">;
  const tui = {
    terminal: {
      write(data: string) {
        writes.push(data);
        if (data === options.failOnWrite) throw new Error("terminal write failed");
      },
    },
  } as Pick<TUI, "terminal">;
  return {
    ui,
    tui,
    writes,
    emit(data: string) {
      return listener?.(data);
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
    hasListener() {
      return listener !== undefined;
    },
  };
}

test("mouse scope consumes events and gates wheel scrolling by current bounds and focus without changing focus", () => {
  const harness = mouseHarness();
  let bounds: ScreenBounds | undefined = { left: 80, top: 2, right: 119, bottom: 36 };
  let focused = true;
  let btwFocuses = 0;
  let mainFocuses = 0;
  const scrollDeltas: number[] = [];
  const scope = enableBtwMouseInput({
    ui: harness.ui,
    tui: harness.tui,
    getBounds: () => bounds,
    isBtwFocused: () => focused,
    scrollBtw: (delta) => scrollDeltas.push(delta),
    focusBtw: () => { btwFocuses += 1; },
    focusMain: () => { mainFocuses += 1; },
  });

  assert.deepEqual(harness.writes, [
    BTW_MOUSE_SEQUENCES.enableButtonReporting,
    BTW_MOUSE_SEQUENCES.enableSgrReporting,
  ]);
  assert.equal(harness.hasListener(), true);
  assert.deepEqual(harness.emit("\x1b[<0;80;2M"), { consume: true });
  assert.equal(btwFocuses, 1);
  assert.equal(mainFocuses, 0);
  assert.deepEqual(harness.emit("\x1b[<0;79;2M"), { consume: true });
  assert.equal(mainFocuses, 1);

  bounds = { left: 60, top: 8, right: 100, bottom: 24 };
  assert.deepEqual(harness.emit("\x1b[<0;65;10M"), { consume: true });
  assert.equal(btwFocuses, 2, "routing must read the latest render bounds");

  const focusesBeforeWheel = { btwFocuses, mainFocuses };
  assert.deepEqual(harness.emit("\x1b[<64;65;10M"), { consume: true });
  assert.deepEqual(harness.emit("\x1b[<69;65;10M"), { consume: true });
  assert.deepEqual(scrollDeltas, [3, -3]);
  assert.deepEqual({ btwFocuses, mainFocuses }, focusesBeforeWheel, "wheel input never changes focus");

  assert.deepEqual(harness.emit("\x1b[<64;59;10M"), { consume: true });
  assert.deepEqual(scrollDeltas, [3, -3], "outside wheel input is consumed without scrolling BTW");
  focused = false;
  assert.deepEqual(harness.emit("\x1b[<64;65;10M"), { consume: true });
  assert.deepEqual(scrollDeltas, [3, -3], "unfocused wheel input is consumed without scrolling BTW");

  for (const sequence of [
    "\x1b[<0;65;10m",
    "\x1b[<32;65;10M",
    "\x1b[<invalidM",
  ]) {
    assert.deepEqual(harness.emit(sequence), { consume: true }, sequence);
  }
  assert.equal(btwFocuses, 2);
  assert.equal(mainFocuses, 1);
  assert.deepEqual(harness.emit("\x1b[M !!"), { consume: true }, "legacy reports cannot pollute an editor");
  assert.equal(harness.emit("x"), undefined);

  bounds = undefined;
  assert.deepEqual(harness.emit("\x1b[<0;1;1M"), { consume: true });
  assert.equal(btwFocuses, 2);
  assert.equal(mainFocuses, 1);

  scope.dispose();
  scope.dispose();
  assert.deepEqual(harness.writes, [
    BTW_MOUSE_SEQUENCES.enableButtonReporting,
    BTW_MOUSE_SEQUENCES.enableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableButtonReporting,
  ]);
  assert.equal(harness.unsubscribeCount, 1);
  assert.equal(harness.hasListener(), false);
});

test("mouse setup failure restores every mode whose enable write began and removes its listener", () => {
  const harness = mouseHarness({ failOnWrite: BTW_MOUSE_SEQUENCES.enableSgrReporting });
  assert.throws(() => enableBtwMouseInput({
    ui: harness.ui,
    tui: harness.tui,
    getBounds: () => undefined,
    isBtwFocused: () => false,
    scrollBtw() {},
    focusBtw() {},
    focusMain() {},
  }), /terminal write failed/);

  assert.deepEqual(harness.writes, [
    BTW_MOUSE_SEQUENCES.enableButtonReporting,
    BTW_MOUSE_SEQUENCES.enableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableSgrReporting,
    BTW_MOUSE_SEQUENCES.disableButtonReporting,
  ]);
  assert.equal(harness.unsubscribeCount, 1);
  assert.equal(harness.hasListener(), false);
});
