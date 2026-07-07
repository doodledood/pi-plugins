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

const fakeTui = {
  renderRequests: 0,
  requestRender() {
    this.renderRequests += 1;
  },
};
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
    },
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

test("footer computes context percent against the model window without a compact hint below threshold", () => {
  const harness = createHarness([]);
  harness.ctx.model.contextWindow = 200_000;
  harness.ctx.getContextUsage = () => ({ tokens: 98_000 });

  const line = renderFooter(harness);
  assert.match(line, /49% 98k\/200k/);
  assert.doesNotMatch(line, /compact at boundary/);
});

test("footer shows compact-at-boundary hint and warning tone at the threshold", () => {
  const harness = createHarness([]);
  harness.ctx.model.contextWindow = 200_000;
  harness.ctx.getContextUsage = () => ({ tokens: 100_000 });

  const line = renderFooter(harness);
  assert.match(line, /50% 100k\/200k · compact at boundary/);
  assert.ok(
    harness.themeCalls.some((call) => call.tone === "warning" && /compact at boundary/.test(call.text)),
    "context segment renders in warning tone once the boundary hint is active",
  );
});

test("footer refresh hooks cover compaction and branch changes", () => {
  const harness = createHarness([]);
  assert.ok(harness.handlers.get("session_compact"), "post-compaction hook registered");
  assert.ok(harness.handlers.get("session_tree"), "branch/tree hook registered");
  harness.ctx.model.contextWindow = 100_000;
  harness.ctx.getContextUsage = () => ({ tokens: 55_000 });
  assert.match(renderFooter(harness), /compact at boundary/);

  harness.ctx.getContextUsage = () => ({ tokens: 10_000 });
  fakeTui.renderRequests = 0;
  harness.handlers.get("session_compact")!({ reason: "manual" }, harness.ctx);
  assert.equal(fakeTui.renderRequests, 1, "post-compaction hook requests a footer rerender");
  assert.doesNotMatch(renderFooter(harness), /compact at boundary/, "compaction refresh reflects the reset/lower context");

  harness.ctx.getContextUsage = () => ({ tokens: 55_000 });
  fakeTui.renderRequests = 0;
  harness.handlers.get("session_compact")!({ reason: "manual" }, harness.ctx);
  assert.equal(fakeTui.renderRequests, 1, "post-compaction hook requests rerender after recrossing");
  assert.match(renderFooter(harness), /compact at boundary/, "compaction hook re-arms the hint when context crosses again");

  harness.ctx.getContextUsage = () => ({ tokens: 10_000 });
  fakeTui.renderRequests = 0;
  harness.handlers.get("session_tree")!({ newLeafId: "other" }, harness.ctx);
  assert.ok(fakeTui.renderRequests >= 1, "branch/tree hook requests a footer rerender");
  assert.doesNotMatch(renderFooter(harness), /compact at boundary/, "branch refresh reflects the reset/lower context");
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

test("statusline remains footer-only and owns no model-context mutation surfaces", () => {
  const harness = createHarness([assistantEntry(1_000, 1_000, 1_000, 0)]);
  assert.equal(harness.commands.get("cache"), undefined, "no /cache command registered");
  assert.equal(harness.handlers.get("before_provider_request"), undefined, "no payload observation");
  assert.equal(harness.handlers.get("before_agent_start"), undefined, "no system prompt mutation");
  assert.equal(harness.handlers.get("context"), undefined, "no message/context injection");
  assert.equal(harness.handlers.get("tool_result"), undefined, "no tool-result/session mutation");
  assert.ok(harness.footerFactory, "footer renderer installed");
});
