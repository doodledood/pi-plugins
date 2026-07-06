import assert from "node:assert/strict";
import test from "node:test";
import simpleStatusline from "../simple-statusline.ts";
import type { SessionEntryLike } from "./cache.ts";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
  handlers: Map<string, Handler>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> | void }>;
  footerFactory?: (tui: any, theme: any, footerData: any) => { render(width: number): string[]; dispose?(): void };
  ctx: any;
  themeCalls: Array<{ tone: string; text: string }>;
}

// Records fg() calls while leaving text unchanged so layout math stays exact.
function createRecordingTheme(): { theme: any; calls: Array<{ tone: string; text: string }> } {
  const calls: Array<{ tone: string; text: string }> = [];
  return {
    calls,
    theme: {
      fg(tone: string, text: string) {
        calls.push({ tone, text });
        return text;
      },
    },
  };
}

const fakeTui = { requestRender() {} };
const fakeFooterData = {
  getGitBranch: () => "main",
  getExtensionStatuses: () => undefined,
  onBranchChange: () => () => {},
};

function assistantEntry(timestamp: number, input: number, read: number, write: number): SessionEntryLike {
  return { type: "message", message: { role: "assistant", timestamp, usage: { input, cacheRead: read, cacheWrite: write } } };
}

function createHarness(branch: SessionEntryLike[]): Harness {
  const harness: Harness = { handlers: new Map(), commands: new Map(), ctx: undefined, themeCalls: [] };
  const ctx = {
    cwd: "/tmp/project",
    model: { id: "test-model", provider: "test" },
    getContextUsage: () => undefined,
    sessionManager: { getBranch: () => branch },
    ui: {
      setStatus() {},
      setFooter(factory: any) {
        harness.footerFactory = factory;
      },
      async custom(factory: any) {
        const recording = createRecordingTheme();
        const component = factory(fakeTui, recording.theme, undefined, () => {});
        harness.ctx.lastOverlay = component;
        return undefined;
      },
    },
    lastOverlay: undefined as any,
  };
  harness.ctx = ctx;

  const pi = {
    on(event: string, handler: Handler) {
      harness.handlers.set(event, handler);
    },
    getThinkingLevel: () => "off" as const,
    registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: any) => Promise<void> | void }) {
      harness.commands.set(name, options);
    },
  };

  simpleStatusline(pi);
  harness.handlers.get("session_start")!({ reason: "startup" }, ctx);
  return harness;
}

function renderFooter(harness: Harness): string {
  const recording = createRecordingTheme();
  const component = harness.footerFactory!(fakeTui, recording.theme, fakeFooterData);
  const line = component.render(400).join("\n");
  harness.themeCalls.length = 0;
  harness.themeCalls.push(...recording.calls);
  return line;
}

test("footer shows the cumulative session cache rate, not the latest turn's rate", () => {
  // turn 1: 0% hit rate (20k prompt, all write); turn 2: 97.5% hit rate.
  // Cumulative: 19500 / 40000 = 49%. Latest-turn would be 98%.
  const harness = createHarness([
    assistantEntry(1_000, 2_000, 0, 18_000),
    assistantEntry(2_000, 500, 19_500, 0),
  ]);
  const line = renderFooter(harness);
  assert.match(line, /cache 49%/);
  assert.doesNotMatch(line, /cache 9[78]%/);
  assert.doesNotMatch(line, /cache 49%!/, "no break flag when the latest turn hit cache");
});

test("footer flags a cache break with a warning tone and marker", () => {
  // Previous prompt 20k, latest read 100 < 50% of 20k -> break.
  const harness = createHarness([
    assistantEntry(1_000, 2_000, 0, 18_000),
    assistantEntry(2_000, 20_000, 100, 5_000),
  ]);
  const line = renderFooter(harness);
  assert.match(line, /cache \d+%!/, "break marker shown");
  assert.ok(
    harness.themeCalls.some((call) => call.tone === "warning" && /^cache \d+%!/.test(call.text)),
    "break rendered in warning tone",
  );
});

test("footer omits the cache token when the branch has no cache data", () => {
  const harness = createHarness([assistantEntry(1_000, 50_000, 0, 0)]);
  const line = renderFooter(harness);
  assert.doesNotMatch(line, /cache \d+%/);
});

async function runCacheReport(harness: Harness): Promise<string> {
  const command = harness.commands.get("cache");
  assert.ok(command, "/cache command registered");
  await command.handler("", harness.ctx);
  const overlay = harness.ctx.lastOverlay;
  assert.ok(overlay, "overlay component created");
  assert.ok(Array.isArray(overlay.render(300)), "overlay renders lines");
  // Assert on the full report content (render() shows a scrollable viewport).
  return overlay.lines.map((line: { text: string }) => line.text).join("\n");
}

test("/cache reports per-turn stats and entry-correlated break causes", async () => {
  const branch: SessionEntryLike[] = [
    assistantEntry(1_000, 2_000, 0, 18_000),
    { type: "compaction" },
    assistantEntry(2_000, 5_000, 100, 10_000),
    { type: "model_change", modelId: "other-model" },
    assistantEntry(3_000, 16_000, 200, 0),
    // idle > 5 minutes before this turn -> probable TTL expiry
    assistantEntry(3_000 + 6 * 60_000, 16_000, 300, 0),
  ];
  // Insert a branch_summary before a final breaking turn.
  branch.push({ type: "branch_summary" });
  branch.push(assistantEntry(3_000 + 6 * 60_000 + 1_000, 16_000, 400, 0));

  const harness = createHarness(branch);
  const text = await runCacheReport(harness);

  assert.match(text, /Session cache rate: \d+%/);
  assert.match(text, /#1/);
  assert.match(text, /BREAK/);
  assert.match(text, /compaction rewrote the context/);
  assert.match(text, /model switched to other-model/);
  assert.match(text, /probable cache TTL expiry/);
  assert.match(text, /branch\/tree navigation rewrote the prefix/);
});

test("/cache attributes an unexplained break via prefix fingerprints when observed in-process", async () => {
  const branch: SessionEntryLike[] = [
    assistantEntry(1_000, 2_000, 0, 18_000),
    assistantEntry(2_000, 20_000, 100, 0),
  ];
  const harness = createHarness(branch);

  // Simulate the two provider requests this process observed.
  harness.handlers.get("before_provider_request")!({ payload: { system: "prompt-v1", messages: [{ role: "user", content: "hi" }] } }, harness.ctx);
  harness.handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 1_000 } }, harness.ctx);
  harness.handlers.get("before_provider_request")!({ payload: { system: "prompt-v2", messages: [{ role: "user", content: "hi" }] } }, harness.ctx);
  harness.handlers.get("turn_end")!({ message: { role: "assistant", timestamp: 2_000 } }, harness.ctx);

  const text = await runCacheReport(harness);
  assert.match(text, /prefix changed: system prompt changed/);
  assert.match(text, /fingerprints cover 1\/2 turns/i);
});

test("/cache labels breaks without a retained fingerprint as entry-correlation only", async () => {
  const branch: SessionEntryLike[] = [
    assistantEntry(1_000, 2_000, 0, 18_000),
    assistantEntry(2_000, 20_000, 100, 0),
  ];
  const harness = createHarness(branch);
  const text = await runCacheReport(harness);
  assert.match(text, /no fingerprint retained for this turn — predates this process or pruned; entry-correlation only/);
});

test("/cache overlay supports wheel, page keys, and mouse-mode lifecycle", async () => {
  // Long branch so the report overflows the viewport.
  const branch: SessionEntryLike[] = [];
  for (let i = 0; i < 80; i++) branch.push(assistantEntry(i, 10, 10, 10));
  const harness = createHarness(branch);

  const writes: string[] = [];
  harness.ctx.ui.custom = async (factory: any) => {
    const recording = createRecordingTheme();
    const tui = { requestRender() {}, terminal: { write: (data: string) => writes.push(data), rows: 40 } };
    harness.ctx.lastOverlay = factory(tui, recording.theme, undefined, () => {});
    return undefined;
  };
  await harness.commands.get("cache")!.handler("", harness.ctx);
  const overlay = harness.ctx.lastOverlay;

  assert.ok(writes.some((w) => w.includes("\x1b[?1006h")), "SGR mouse reporting enabled on open");

  const windowOf = (rendered: string[]) => rendered.join("\n").match(/\((\d+)-\d+\/\d+\)/)?.[1];
  assert.equal(windowOf(overlay.render(100)), "1");

  // Wheel down: one notch scrolls 3 lines.
  overlay.handleInput("\x1b[<65;10;5M");
  assert.equal(windowOf(overlay.render(100)), "4");
  // Wheel up returns to the top (clamped).
  overlay.handleInput("\x1b[<64;10;5M");
  overlay.handleInput("\x1b[<64;10;5M");
  assert.equal(windowOf(overlay.render(100)), "1");

  // PageDown/PageUp jump by a full viewport.
  overlay.handleInput("\x1b[6~");
  const afterPageDown = Number(windowOf(overlay.render(100)));
  assert.ok(afterPageDown > 10, `page down jumps a viewport (got ${afterPageDown})`);
  overlay.handleInput("\x1b[5~");
  assert.equal(windowOf(overlay.render(100)), "1");

  // Click sequences are ignored (no scroll, no close).
  overlay.handleInput("\x1b[<0;10;5M");
  assert.equal(windowOf(overlay.render(100)), "1");

  // Closing (q) disables mouse reporting; dispose is idempotent.
  overlay.handleInput("q");
  assert.ok(writes.some((w) => w.includes("\x1b[?1006l")), "SGR mouse reporting disabled on close");
  const disableCount = writes.filter((w) => w.includes("\x1b[?1006l")).length;
  overlay.dispose();
  assert.equal(writes.filter((w) => w.includes("\x1b[?1006l")).length, disableCount, "dispose after close does not double-disable");
});

test("fingerprint state stores hashes only and stays bounded to 500 pairs", async () => {
  const turns = 600;
  const branch: SessionEntryLike[] = [];
  for (let i = 0; i < turns; i++) branch.push(assistantEntry(i, 10, 10, 10));

  const harness = createHarness(branch);
  const before = harness.handlers.get("before_provider_request")!;
  const turnEnd = harness.handlers.get("turn_end")!;
  const secret = "TOP-SECRET-CONTENT";
  for (let i = 0; i < turns; i++) {
    before({ payload: { system: secret, messages: [{ role: "user", content: secret }] } }, harness.ctx);
    turnEnd({ message: { role: "assistant", timestamp: i } }, harness.ctx);
  }

  const text = await runCacheReport(harness);
  // Pruned to the most recent 500 pairs, so only those turns carry fingerprints.
  assert.match(text, /fingerprints cover 500\/600 turns/i);
  // Retained state is hashes only — raw payload content never reaches the report.
  assert.doesNotMatch(text, /TOP-SECRET-CONTENT/);
});
