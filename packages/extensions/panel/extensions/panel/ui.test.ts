import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PANELISTS, defaultConfig } from "./config.ts";
import type { PanelistState, PanelistSpec } from "./types.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  answerPreview,
  clipText,
  estimatePanelCostUsd,
  stripThinkingSuffix,
  formatAmbientLines,
  formatAnswerLines,
  formatDuration,
  formatMetaLines,
  formatPickerLines,
  PanelMonitorComponent,
  PanelPickerComponent,
  PickerState,
  renderInspectView,
} from "./ui.ts";

const KEY = { escape: "\x1b", enter: "\r", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", tab: "\t" };

const themeStub = { bold: (t: string) => t, fg: (_role: string, t: string) => t };

function state(partial: Partial<PanelistState> & { spec: PanelistSpec }): PanelistState {
  return {
    id: 0,
    status: "running",
    activity: "thinking",
    transcript: [],
    tokens: 0,
    cost: undefined,
    startedAt: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

test("picker: default config preselects the built-in fallback lineup", () => {
  const config = defaultConfig();
  const picker = new PickerState(config.panelists, config.preselected);
  assert.deepEqual(picker.selection(), DEFAULT_PANELISTS);
});

test("picker: toggle, cursor bounds, and effort cycling", () => {
  const picker = new PickerState(
    [
      { model: "a/a", thinking: "high" },
      { model: "b/b", thinking: "xhigh" },
    ],
    [0, 1],
  );
  picker.toggle();
  assert.deepEqual(picker.selection().map((s) => s.model), ["b/b"]);
  picker.move(-5);
  assert.equal(picker.cursor, 0);
  picker.move(1);
  picker.move(99);
  assert.equal(picker.cursor, 1);
  picker.cycleEffort(1);
  assert.equal(picker.rows[1]?.spec.thinking, "max");
  picker.cycleEffort(1);
  assert.equal(picker.rows[1]?.spec.thinking, "off"); // wraps
  picker.cycleEffort(-1);
  assert.equal(picker.rows[1]?.spec.thinking, "max");
});

test("picker rendering: bordered frame, header with count + estimate, provider column, segmented effort", () => {
  const picker = new PickerState(
    [
      { model: "anthropic/claude-fable-5", thinking: "xhigh" },
      { model: "openai/gpt-5.6-sol", thinking: "high" },
    ],
    [0, 1],
  );
  const lines = formatPickerLines(picker, 1.68, themeStub);
  assert.match(lines[0] ?? "", /┌─ Panel lineup · 2 selected · est ~\$1\.68 /);
  assert.match(lines[1] ?? "", /‹enter› run {2}‹space› select {2}‹←\/→› effort {2}‹esc› back/);
  assert.match(lines[2] ?? "", /● claude-fable-5\s+‹ xhigh ›\s+anthropic/);
  assert.match(lines[3] ?? "", /● gpt-5\.6-sol\s+‹ high ›\s+openai/);
  assert.match(lines.at(-1) ?? "", /└─+┘/);

  // No estimate → header omits it; nothing selected → warning row.
  picker.toggle();
  picker.move(1);
  picker.toggle();
  const empty = formatPickerLines(picker, undefined, themeStub);
  assert.match(empty[0] ?? "", /0 selected /);
  assert.ok(!(empty[0] ?? "").includes("est ~$"));
  assert.ok(empty.some((line) => /select at least one panelist/.test(line)));
});

test("picker component: keys map to state; enter returns selection; esc returns null", () => {
  const lineup = [
    { model: "a/a", thinking: "high" as const },
    { model: "b/b", thinking: "high" as const },
  ];
  let result: PanelistSpec[] | null | undefined;
  const makeComponent = () => {
    result = undefined;
    const picker = new PickerState(lineup, [0, 1]);
    return new PanelPickerComponent(themeStub, picker, () => 0.5, (r) => {
      result = r;
    });
  };

  let component = makeComponent();
  component.handleInput(KEY.down);
  component.handleInput(" "); // deselect second row
  component.handleInput(KEY.right); // effort up on second row
  component.handleInput(KEY.enter);
  assert.deepEqual(result, [{ model: "a/a", thinking: "high" }]);

  component = makeComponent();
  component.handleInput(KEY.escape);
  assert.equal(result, null);

  // Enter with nothing selected must not run.
  component = makeComponent();
  component.handleInput(" ");
  component.handleInput(KEY.down);
  component.handleInput(" ");
  component.handleInput(KEY.enter);
  assert.equal(result, undefined);
});

test("cost estimate: fork tokens × input price, summed; undefined when no model is priced", () => {
  const prices: Record<string, number | undefined> = { "a/a": 3, "b/b": 15, "c/c": undefined };
  const lookup = (ref: string) => prices[ref];
  const specs: PanelistSpec[] = [
    { model: "a/a", thinking: "high" },
    { model: "b/b", thinking: "xhigh" },
  ];
  // 100k tokens: 0.1M × ($3 + $15) = $1.80
  assert.equal(estimatePanelCostUsd(specs, 100_000, lookup), 1.8);
  assert.equal(estimatePanelCostUsd([{ model: "c/c", thinking: "off" }], 100_000, lookup), undefined);
  // Unpriced models are skipped, priced ones still counted.
  assert.equal(estimatePanelCostUsd([...specs, { model: "c/c", thinking: "off" }], 100_000, lookup), 1.8);
});

// ---------------------------------------------------------------------------
// Ambient bar
// ---------------------------------------------------------------------------

test("ambient bar: spinner header with hints, per-panelist glyph/elapsed/tokens/cost/activity", () => {
  const states = [
    state({ id: 0, spec: { model: "anthropic/claude-fable-5", thinking: "xhigh" }, activity: "running bash", tokens: 41_000 }),
    state({
      id: 1,
      spec: { model: "openai/gpt-5.6-sol", thinking: "xhigh" },
      status: "done",
      activity: "answered",
      tokens: 38_000,
      cost: 0.71,
      endedAt: 61_000, // finished earlier: its elapsed must freeze at 1m01s
    }),
  ];
  const lines = formatAmbientLines(states, 135_000, "ctrl+p", themeStub);
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] panel · 2m15s · esc cancel · ctrl\+p inspect$/);
  assert.match(lines[1] ?? "", /◐ claude-fable-5 xhigh\s+2m15s · 41k tok\s+running bash/);
  assert.match(lines[2] ?? "", /● gpt-5\.6-sol xhigh\s+1m01s · 38k tok · \$0\.71\s+answered/);

  // All done → static glyph instead of spinner.
  const finished = states.map((s) => ({ ...s, status: "done" as const, endedAt: 61_000 }));
  assert.match(formatAmbientLines(finished, 135_000, "ctrl+p", themeStub)[0] ?? "", /^▣ panel/);
});

test("formatDuration", () => {
  assert.equal(formatDuration(9_000), "9s");
  assert.equal(formatDuration(135_000), "2m15s");
});

// ---------------------------------------------------------------------------
// Drill-in split view
// ---------------------------------------------------------------------------

const splitStates = [
  state({ id: 0, spec: { model: "a/fable", thinking: "xhigh" }, transcript: ["fable line one", "fable line two"], tokens: 41_000 }),
  state({ id: 1, spec: { model: "b/sol", thinking: "high" }, transcript: ["sol line one"], tokens: 38_000, cost: 0.71 }),
];

test("clipText clips by display columns: CJK and tabs cannot overflow a pane", () => {
  const cjk = "対話の文脈を確認しています。これは長い行です。";
  const clipped = clipText(cjk, 20);
  assert.ok(visibleWidth(clipped) <= 20, `expected ≤20 cols, got ${visibleWidth(clipped)}`);
  const tabs = "\t\t\tfunc main() { fmt.Println(\"hello\") }";
  assert.ok(visibleWidth(clipText(tabs, 24)) <= 24);
  assert.equal(clipText("short", 20), "short");
});

test("stripThinkingSuffix: drops valid :level suffixes only", () => {
  assert.equal(stripThinkingSuffix("anthropic/claude-fable-5:high"), "anthropic/claude-fable-5");
  assert.equal(stripThinkingSuffix("openai/gpt-5.6-sol"), "openai/gpt-5.6-sol");
  assert.equal(stripThinkingSuffix("openrouter/model:exacto"), "openrouter/model:exacto"); // not a level
});

test("every rendered line respects the component width: bar, split, zoomed, many panelists", () => {
  const cjkState = state({
    id: 0,
    spec: { model: "anthropic/claude-sonnet-4-5-20250929", thinking: "xhigh" },
    transcript: ["対話の文脈を確認しています。これはとても長いトランスクリプト行です。".repeat(3)],
    tokens: 123_000,
    cost: 1.23,
    activity: "running snowflake_mcp_run_snowflake_query with a very long tool name",
  });
  const many = [cjkState, ...[1, 2, 3].map((i) => state({ id: i, spec: { model: `provider/model-name-${i}-20250929`, thinking: "low" }, transcript: [`t${i}`] }))];
  const monitor = new PanelMonitorComponent(themeStub, () => many, "ctrl+p", () => {});
  for (const width of [64, 80, 110]) {
    for (const line of monitor.render(width)) {
      assert.ok(visibleWidth(line) <= width, `bar/inspect line exceeds ${width}: ${visibleWidth(line)}`);
    }
    monitor.handleInput("i"); // switch view and re-check
  }
  monitor.dispose();
});

test("split view: content rows align exactly with the frame borders (remainder redistributed)", () => {
  for (const width of [80, 100, 110]) {
    const lines = renderInspectView(splitStates, { focus: 0, zoomed: false }, width, 135_000, themeStub);
    const widths = new Set(lines.map((l) => visibleWidth(l)));
    assert.equal(widths.size, 1, `expected uniform row width at ${width}, got ${[...widths].join(",")}`);
  }
});

test("split view: bordered, one column per panelist with header stats and transcript", () => {
  const lines = renderInspectView(splitStates, { focus: 0, zoomed: false }, 100, 135_000, themeStub);
  assert.match(lines[0] ?? "", /┌─ ▣ Panel · 2 running /);
  assert.match(lines.at(-1) ?? "", /esc back · tab zoom · 1-2 focus/);
  const body = lines.join("\n");
  assert.ok(body.includes("fable · xhigh"));
  assert.ok(body.includes("sol · high"));
  assert.ok(body.includes("fable line two"));
  assert.ok(body.includes("sol line one"));
  // Column separator present on pane rows.
  assert.ok(lines.some((line) => line.split("│").length >= 4), "expected two columns separated by │");
});

test("split view: zoomed shows chip strip + a single full-width pane for the focused panelist", () => {
  const lines = renderInspectView(splitStates, { focus: 1, zoomed: true }, 100, 135_000, themeStub);
  const body = lines.join("\n");
  assert.ok(body.includes("[● sol]") || body.includes("[◐ sol]"), "focused chip highlighted");
  assert.ok(body.includes("sol line one"));
  assert.ok(!body.includes("fable line two"), "unfocused transcript hidden when zoomed");
});

test("split view: more than 3 panelists forces the zoomed single-pane degradation", () => {
  const many = [0, 1, 2, 3].map((i) =>
    state({ id: i, spec: { model: `p/m${i}`, thinking: "low" }, transcript: [`t${i}`] }),
  );
  const lines = renderInspectView(many, { focus: 2, zoomed: false }, 100, 1_000, themeStub);
  const body = lines.join("\n");
  assert.ok(body.includes("[◐ m2]"), "chip strip with focused panelist");
  assert.ok(body.includes("t2"));
  assert.ok(!body.includes("t0"), "only the focused pane renders");
});

// ---------------------------------------------------------------------------
// Monitor component (bar ⇄ inspect)
// ---------------------------------------------------------------------------

test("monitor: esc cancels in bar view; inspect key/i toggles; tab zooms; digits focus; esc backs out", () => {
  let cancelled = 0;
  const monitor = new PanelMonitorComponent(themeStub, () => splitStates, "ctrl+p", () => {
    cancelled++;
  });

  // Bar view renders ambient lines.
  assert.match(monitor.render(100)[0] ?? "", /panel · /);

  // ctrl+p opens inspect; tab toggles zoom; digit focuses; esc returns to bar without cancelling.
  monitor.handleInput("\x10"); // ctrl+p
  assert.equal(monitor.view, "inspect");
  assert.match(monitor.render(100)[0] ?? "", /┌─ ▣ Panel/);
  monitor.handleInput(KEY.tab);
  assert.equal(monitor.inspect.zoomed, true);
  monitor.handleInput("2");
  assert.equal(monitor.inspect.focus, 1);
  monitor.handleInput(KEY.escape);
  assert.equal(monitor.view, "bar");
  assert.equal(cancelled, 0, "esc in inspect view must not cancel the panel");

  // `i` also toggles inspect.
  monitor.handleInput("i");
  assert.equal(monitor.view, "inspect");
  monitor.handleInput("i");
  assert.equal(monitor.view, "bar");

  // Esc in bar view cancels.
  monitor.handleInput(KEY.escape);
  assert.equal(cancelled, 1);
  monitor.dispose();
});

// ---------------------------------------------------------------------------
// Result rendering
// ---------------------------------------------------------------------------

test("answer rendering: collapsed styled row with quoted first-line preview; expanded verbatim body", () => {
  const ok = {
    model: "a/a",
    thinking: "xhigh",
    ok: true,
    cancelled: false,
    elapsedMs: 182_000,
    tokens: 41_000,
    cost: 0.84,
    preview: "The TTL assumption has a real hole in it.",
  };
  const content = "Independent opinion from panelist a/a (xhigh) — one model's fallible take, not ground truth:\n\nThe TTL assumption has a real hole in it.\nSecond line of detail.";
  const collapsed = formatAnswerLines(ok, content, false, themeStub);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0] ?? "", /▸ ◆ panelist a\/a xhigh\s+3m02s · 41k tok · \$0\.84 · answered/);
  assert.match(collapsed[0] ?? "", /"The TTL assumption has a real hole in it\."/);

  const expanded = formatAnswerLines(ok, content, true, themeStub);
  assert.match(expanded[0] ?? "", /▾ ◆ panelist/);
  assert.ok(expanded.join("\n").includes("Second line of detail."));

  const cancelledLine = formatAnswerLines({ ...ok, ok: false, cancelled: true, cost: undefined }, "x", false, themeStub);
  assert.match(cancelledLine[0] ?? "", /◌ .* cancelled/);
  assert.ok(!(cancelledLine[0] ?? "").includes('"'), "no preview on non-answers");

  const failed = formatAnswerLines({ model: undefined, ok: false, cancelled: false }, "x", false, themeStub);
  assert.match(failed[0] ?? "", /✗ panelist \?\s+0s · 0 tok · failed/);
});

test("answerPreview: quotes the first non-empty line and clips long lines by display width", () => {
  const preview = answerPreview("x".repeat(200));
  assert.ok(preview.startsWith('"xxx'));
  assert.ok(preview.length <= 60);
  assert.ok(preview.endsWith('…"') || preview.endsWith('"'));
  assert.equal(answerPreview(""), "");
});

test("meta rendering: collapsed count line; expanded session paths with missing-file fallback", () => {
  const data = { panelists: [{ model: "a/a", sessionFile: "/s/a.jsonl" }, { model: "b/b" }] };
  assert.match(formatMetaLines(data, false, themeStub)[0] ?? "", /▸ panel run · 2 panelists · sessions saved/);
  const expanded = formatMetaLines(data, true, themeStub);
  assert.match(expanded[1] ?? "", /a\/a: \/s\/a\.jsonl/);
  assert.match(expanded[2] ?? "", /b\/b: \(no session file\)/);
});
