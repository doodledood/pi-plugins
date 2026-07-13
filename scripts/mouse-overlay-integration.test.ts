import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  acquireSharedMouseLease as acquireBtwMouseLease,
  SHARED_MOUSE_LEASE_SYMBOL,
  SHARED_MOUSE_SEQUENCES,
} from "../packages/extensions/btw/src/mouse-lease.ts";
import { enableBtwMouseInput } from "../packages/extensions/btw/src/mouse.ts";
import { CacheReportOverlay } from "../packages/extensions/cache-optimization/extensions/cache-optimization.ts";
import { acquireSharedMouseLease as acquireCacheMouseLease } from "../packages/extensions/cache-optimization/extensions/cache-optimization/mouse-lease.ts";
import type { ReportLine } from "../packages/extensions/cache-optimization/extensions/cache-optimization/cache.ts";

afterEach(() => {
  delete (globalThis as any)[SHARED_MOUSE_LEASE_SYMBOL];
});

function terminalHarness(failOnWrite?: string) {
  const writes: string[] = [];
  return {
    writes,
    terminal: {
      write(data: string) {
        writes.push(data);
        if (data === failOnWrite) throw new Error("terminal write failed");
      },
    },
  };
}

function btwHarness(terminal: { write(data: string): void }) {
  let listener: ((data: string) => { consume: true } | undefined) | undefined;
  let focused = false;
  let btwFocuses = 0;
  let mainFocuses = 0;
  const scrolls: number[] = [];
  const scope = enableBtwMouseInput({
    ui: {
      onTerminalInput(handler: (data: string) => { consume: true } | undefined) {
        listener = handler;
        return () => { listener = undefined; };
      },
    } as any,
    tui: { terminal } as any,
    getBounds: () => ({ left: 80, top: 2, right: 119, bottom: 36 }),
    isBtwFocused: () => focused,
    scrollBtw: (delta) => scrolls.push(delta),
    focusBtw: () => { btwFocuses += 1; },
    focusMain: () => { mainFocuses += 1; },
  });
  return {
    scope,
    emit: (data: string) => listener?.(data),
    setFocused: (value: boolean) => { focused = value; },
    scrolls,
    get btwFocuses() { return btwFocuses; },
    get mainFocuses() { return mainFocuses; },
  };
}

function reportLines(count = 40): ReportLine[] {
  return Array.from({ length: count }, (_, index) => ({
    text: `line ${index + 1}`,
    tone: "text" as const,
  }));
}

const theme = {
  fg(_tone: string, text: string) { return text; },
  bold(text: string) { return text; },
};

function reportWindowStart(overlay: CacheReportOverlay): number {
  const rendered = overlay.render(100).join("\n");
  const start = rendered.match(/\((\d+)-\d+\/\d+\)/)?.[1];
  assert.ok(start, `expected report scroll hint in:\n${rendered}`);
  return Number(start);
}

test("two package-local implementations share one enable/disable lifecycle in either close order", () => {
  for (const closeFirst of ["btw", "cache"] as const) {
    const harness = terminalHarness();
    const btw = acquireBtwMouseLease(harness.terminal, { package: "btw" });
    const cache = acquireCacheMouseLease(harness.terminal, { package: "cache" });

    assert.deepEqual(harness.writes, [
      SHARED_MOUSE_SEQUENCES.enableButtonReporting,
      SHARED_MOUSE_SEQUENCES.enableSgrReporting,
    ]);

    (closeFirst === "btw" ? btw : cache).release();
    assert.equal(harness.writes.length, 2, `closing ${closeFirst} first must retain reporting`);
    (closeFirst === "btw" ? cache : btw).release();
    assert.deepEqual(harness.writes.slice(2), [
      SHARED_MOUSE_SEQUENCES.disableSgrReporting,
      SHARED_MOUSE_SEQUENCES.disableButtonReporting,
    ]);
  }
});

test("unfocused BTW defers SGR wheel input to the later focused cache overlay", () => {
  const harness = terminalHarness();
  const btw = btwHarness(harness.terminal);
  const cache = new CacheReportOverlay(theme, () => {}, reportLines(), 5, harness.terminal);
  cache.focused = true;

  const wheel = "\x1b[<65;100;10M";
  assert.equal(btw.emit(wheel), undefined, "BTW raw listener must defer while another owner exists");
  cache.handleInput(wheel); // Pi's normal focused-overlay route after raw handlers defer.

  assert.equal(reportWindowStart(cache), 4);
  assert.deepEqual(btw.scrolls, []);
  assert.equal(btw.btwFocuses, 0);
  assert.equal(btw.mainFocuses, 0);

  cache.dispose();
  btw.scope.dispose();
});

test("closing cache retains reporting for BTW and restores BTW click/wheel behavior", () => {
  const harness = terminalHarness();
  const btw = btwHarness(harness.terminal);
  const cache = new CacheReportOverlay(theme, () => {}, reportLines(), 5, harness.terminal);

  cache.dispose();
  assert.equal(harness.writes.length, 2, "cache release cannot disable BTW's reporting");

  btw.setFocused(true); // Pi restores focus to the previously focused BTW overlay.
  assert.deepEqual(btw.emit("\x1b[<0;90;10M"), { consume: true });
  assert.deepEqual(btw.emit("\x1b[<64;90;10M"), { consume: true });
  assert.equal(btw.btwFocuses, 1);
  assert.deepEqual(btw.scrolls, [3]);

  btw.scope.dispose();
  assert.deepEqual(harness.writes.slice(2), [
    SHARED_MOUSE_SEQUENCES.disableSgrReporting,
    SHARED_MOUSE_SEQUENCES.disableButtonReporting,
  ]);
});

test("closing BTW retains reporting and cache wheel behavior", () => {
  const harness = terminalHarness();
  const btw = btwHarness(harness.terminal);
  const cache = new CacheReportOverlay(theme, () => {}, reportLines(), 5, harness.terminal);

  btw.scope.dispose();
  assert.equal(harness.writes.length, 2, "BTW release cannot disable cache reporting");
  cache.handleInput("\x1b[<65;10;5M");
  assert.equal(reportWindowStart(cache), 4);

  cache.dispose();
  assert.deepEqual(harness.writes.slice(2), [
    SHARED_MOUSE_SEQUENCES.disableSgrReporting,
    SHARED_MOUSE_SEQUENCES.disableButtonReporting,
  ]);
});

test("acquire/release are exact-owner idempotent and setup failures roll back", () => {
  const repeated = terminalHarness();
  const owner = {};
  const first = acquireBtwMouseLease(repeated.terminal, owner);
  const sameOwnerAgain = acquireCacheMouseLease(repeated.terminal, owner);
  assert.equal(repeated.writes.length, 2, "reacquiring an exact owner does not add terminal writes");
  sameOwnerAgain.release();
  sameOwnerAgain.release();
  first.release();
  assert.equal(repeated.writes.length, 4, "exact owner and releases are idempotent");

  const failed = terminalHarness(SHARED_MOUSE_SEQUENCES.enableSgrReporting);
  assert.throws(
    () => acquireCacheMouseLease(failed.terminal, {}),
    /terminal write failed/,
  );
  assert.deepEqual(failed.writes, [
    SHARED_MOUSE_SEQUENCES.enableButtonReporting,
    SHARED_MOUSE_SEQUENCES.enableSgrReporting,
    SHARED_MOUSE_SEQUENCES.disableSgrReporting,
    SHARED_MOUSE_SEQUENCES.disableButtonReporting,
  ]);
  assert.equal((globalThis as any)[SHARED_MOUSE_LEASE_SYMBOL], undefined);

  const recovered = terminalHarness();
  const lease = acquireBtwMouseLease(recovered.terminal, {});
  lease.release();
  assert.equal(recovered.writes.length, 4, "a failed setup does not poison later acquisition");

  const releaseFailed = terminalHarness(SHARED_MOUSE_SEQUENCES.disableSgrReporting);
  const failingRelease = acquireCacheMouseLease(releaseFailed.terminal, {});
  assert.doesNotThrow(() => failingRelease.release());
  assert.doesNotThrow(() => failingRelease.release());
  assert.deepEqual(releaseFailed.writes, [
    SHARED_MOUSE_SEQUENCES.enableButtonReporting,
    SHARED_MOUSE_SEQUENCES.enableSgrReporting,
    SHARED_MOUSE_SEQUENCES.disableSgrReporting,
    SHARED_MOUSE_SEQUENCES.disableButtonReporting,
  ], "a failed SGR disable still attempts button disable exactly once");
  assert.equal((globalThis as any)[SHARED_MOUSE_LEASE_SYMBOL], undefined);
});
