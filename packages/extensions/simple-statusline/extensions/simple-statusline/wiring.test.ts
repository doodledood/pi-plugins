import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import simpleStatusline from "../simple-statusline.ts";
import type { SessionEntryLike } from "./cache.ts";
import { deriveChildSessionDir, PRICE_TIER_RECORD_TYPE } from "./session-cost.ts";

type Handler = (event: any, ctx: any) => unknown;

interface Harness {
  handlers: Map<string, Handler>;
  commands: Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> | void }>;
  footerFactory?: (tui: any, theme: any, footerData: any) => { render(width: number): string[]; dispose?(): void };
  ctx: any;
  themeCalls: Array<{ tone: string; text: string }>;
  notices: string[];
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

function createHarness(branch: SessionEntryLike[], session?: { file?: string; id?: string; entries?: unknown[] }): Harness {
  const harness: Harness = { handlers: new Map(), commands: new Map(), ctx: undefined, themeCalls: [], notices: [] };
  const ctx = {
    cwd: "/tmp/project",
    model: { id: "test-model", provider: "test" },
    getContextUsage: () => undefined,
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => session?.entries ?? branch,
      getSessionFile: () => session?.file,
      getSessionId: () => session?.id,
    },
    ui: {
      setStatus() {},
      setFooter(factory: any) {
        harness.footerFactory = factory;
      },
      notify(message: string) {
        harness.notices.push(message);
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

// ── session-tree cost in the footer (D1) ─────────────────────────────────────

let costRoots: string[] = [];

function tempSessionTree(): { parent: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "statusline-cost-"));
  costRoots.push(root);
  const parent = join(root, "parent.jsonl");
  writeFileSync(parent, `${JSON.stringify({ type: "session", version: 3, id: "parent-1", timestamp: new Date().toISOString(), cwd: "/tmp/project" })}\n`);
  return { parent, dir: root };
}

function writeChildSession(parent: string, kind: string, name: string, costs: number[]): void {
  const dir = deriveChildSessionDir(parent, kind);
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, id: `${kind}-${name}`, timestamp: new Date().toISOString(), cwd: "/tmp/project", parentSession: "parent-1" })];
  costs.forEach((cost, index) => {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `${kind}-${name}-${index}`,
        message: {
          role: "assistant",
          provider: "openai",
          model: "child-model",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
        },
      }),
    );
  });
  writeFileSync(join(dir, `${name}.jsonl`), `${lines.join("\n")}\n`);
}

function ownAssistant(cost: number, id: string): unknown {
  return {
    type: "message",
    id,
    message: {
      role: "assistant",
      provider: "openai",
      model: "parent-model",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
    },
  };
}

test.afterEach(() => {
  for (const dir of costRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  costRoots = [];
});

test("footer cost is the whole session tree, not just this session's own turns", () => {
  const { parent } = tempSessionTree();
  writeChildSession(parent, "tasks", "audit-a", [0.39, 0.1]);
  writeChildSession(parent, "advisor", "consult", [0.25]);
  const own = [ownAssistant(1.0, "own-1"), ownAssistant(0.26, "own-2")];

  const harness = createHarness(own as SessionEntryLike[], { file: parent, id: "parent-1", entries: own });
  const line = renderFooter(harness);

  // own 1.26 + tasks 0.49 + advisor 0.25 = 2.00, computed independently here.
  assert.match(line, /\$2\.00/);
  assert.doesNotMatch(line, /\$1\.26/, "the parent-only figure is not what the footer shows");
});

test("footer marks the total approximate when some spend cannot be priced exactly", () => {
  const { parent } = tempSessionTree();
  writeChildSession(parent, "tasks", "unpriced", [0]);
  const own = [ownAssistant(0.5, "own-1")];
  const harness = createHarness(own as SessionEntryLike[], { file: parent, id: "parent-1", entries: own });
  assert.match(renderFooter(harness), /~\$0\.500/, "an unpriceable model shows the total as a floor");
});

test("footer prices priority-tier turns as approximate until a multiplier is configured", () => {
  const { parent } = tempSessionTree();
  const own = [
    { type: "custom", id: "tier", customType: PRICE_TIER_RECORD_TYPE, data: { tier: "priority" } },
    ownAssistant(0.4, "own-1"),
  ];
  const harness = createHarness(own as SessionEntryLike[], { file: parent, id: "parent-1", entries: own });
  assert.match(renderFooter(harness), /~\$0\.400/);
});

test("a large tree renders within a bounded time and is never re-read while rendering", async () => {
  const { parent } = tempSessionTree();
  // 60 spawned sessions: past the point where re-reading them per paint would show.
  for (let i = 0; i < 60; i += 1) writeChildSession(parent, "tasks", `child-${i}`, [0.01, 0.01]);
  const own = [ownAssistant(0.5, "own-1")];
  const harness = createHarness(own as SessionEntryLike[], { file: parent, id: "parent-1", entries: own });

  const recording = createRecordingTheme();
  const component = harness.footerFactory!(fakeTui, recording.theme, fakeFooterData);
  const start = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) component.render(400);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 400, `200 renders of a 60-child tree took ${elapsedMs.toFixed(0)}ms`);
  // own 0.5 + 60 children × 0.02 = 1.70
  assert.match(component.render(400).join("\n"), /\$1\.70/);

  // The scan report is the freshness evidence: a refresh after all those renders finds
  // every child already folded and reads no file bytes again.
  await harness.commands.get("cost")!.handler("", harness.ctx);
  const report = harness.notices.join("\n");
  assert.match(report, /Scan: 60 spawned session file\(s\) found, 0 read on the last refresh/);
});

test("/cost reports the tree breakdown, the branch subtotal, and what it cannot see", async () => {
  const { parent } = tempSessionTree();
  writeChildSession(parent, "tasks", "audit", [0.75]);
  const own = [ownAssistant(0.25, "own-1")];
  const harness = createHarness(own as SessionEntryLike[], { file: parent, id: "parent-1", entries: own });

  const command = harness.commands.get("cost");
  assert.ok(command, "/cost registered");
  await command!.handler("", harness.ctx);
  const report = harness.notices.join("\n");
  assert.match(report, /Session tree lifetime cost: \$1\.00/);
  assert.match(report, /active branch/);
  assert.match(report, /tasks\//);
  assert.match(report, /openai\/child-model/);
  assert.match(report, /Not included/);
  assert.match(report, /pi-web-access|web search/);
});

test("a scan failure leaves the previous total rather than blanking the footer", () => {
  const { parent } = tempSessionTree();
  const own = [ownAssistant(0.5, "own-1")];
  const harness = createHarness(own as SessionEntryLike[], { file: parent, id: "parent-1", entries: own });
  assert.match(renderFooter(harness), /\$0\.500/);

  harness.ctx.sessionManager.getEntries = () => {
    throw new Error("session manager replaced mid-flight");
  };
  harness.handlers.get("turn_end")!({}, harness.ctx);
  assert.match(renderFooter(harness), /\$0\.500/, "last known total survives a failed scan");
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

test("/cost's branch subtotal counts tool and compaction usage, not assistant turns alone", async () => {
  const { parent } = tempSessionTree();
  const branch = [
    ownAssistant(1, "own-1"),
    { type: "message", id: "tr-1", timestamp: "2026-07-28T10:00:00.000Z", message: { role: "toolResult", toolName: "advisor_consult", usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } } } },
    { type: "compaction", id: "cmp-1", timestamp: "2026-07-28T10:05:00.000Z", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } } },
  ];
  const harness = createHarness(branch as SessionEntryLike[], { file: parent, id: "parent-1", entries: branch });

  await harness.commands.get("cost")!.handler("", harness.ctx);
  const report = harness.notices.join("\n");
  // 1 + 0.5 + 0.25: the assistant-only rule would have reported $1.00.
  assert.match(report, /active branch \(this session only\): \$1\.75/);
});

test("/cost states the total is a floor and names each reason, over real fixtures", async () => {
  const { parent } = tempSessionTree();
  // A child whose model has no resolvable price, and a priority-tier window in the
  // parent with no configured premium: both reasons must reach the report.
  writeChildSession(parent, "tasks", "unpriced", [0]);
  const own = [
    { type: "custom", id: "tier", customType: PRICE_TIER_RECORD_TYPE, data: { tier: "priority" } },
    ownAssistant(0.4, "own-1"),
  ];
  const harness = createHarness(own as SessionEntryLike[], { file: parent, id: "parent-1", entries: own });

  await harness.commands.get("cost")!.handler("", harness.ctx);
  const report = harness.notices.join("\n");
  assert.match(report, /Session tree lifetime cost: ~\$0\.400/, "the report headline carries the floor marker too");
  assert.match(report, /Approximate, because:/);
  assert.match(report, /priority-tier turns priced at standard rates/);
  assert.match(report, /no price resolved for openai\/child-model/);
  assert.match(report, /priority-tier turns billed above the \$0\.400 counted here/);
});

test("/cost drops the approximation section once everything is priced", async () => {
  const { parent } = tempSessionTree();
  writeChildSession(parent, "tasks", "priced", [0.5]);
  const own = [ownAssistant(0.5, "own-1")];
  const harness = createHarness(own as SessionEntryLike[], { file: parent, id: "parent-1", entries: own });

  await harness.commands.get("cost")!.handler("", harness.ctx);
  const report = harness.notices.join("\n");
  assert.match(report, /Session tree lifetime cost: \$1\.00/);
  assert.doesNotMatch(report, /Approximate, because/);
  assert.doesNotMatch(report, /~\$/);
});
