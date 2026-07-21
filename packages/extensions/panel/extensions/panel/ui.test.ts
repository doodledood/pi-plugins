import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PANELISTS, defaultConfig } from "./config.ts";
import type { PanelistState, PanelistSpec } from "./types.ts";
import { formatDuration, formatWidgetLines, OverlayModel, PanelInspectOverlay, PanelPickerComponent, PickerState } from "./ui.ts";

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

test("picker component: keys map to state; enter returns selection; esc returns null", () => {
  const lineup = [
    { model: "a/a", thinking: "high" as const },
    { model: "b/b", thinking: "high" as const },
  ];
  let result: PanelistSpec[] | null | undefined;
  const makeComponent = () => {
    result = undefined;
    const picker = new PickerState(lineup, [0, 1]);
    return new PanelPickerComponent(themeStub, picker, (r) => {
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

test("widget lines: header carries run state and hints, one line per panelist", () => {
  const states = [
    state({ id: 0, spec: { model: "anthropic/claude-fable-5", thinking: "xhigh" }, activity: "running bash", tokens: 41_000 }),
    state({ id: 1, spec: { model: "openai/gpt-5.6-sol", thinking: "xhigh" }, status: "done", activity: "answered", tokens: 38_000, cost: 0.71 }),
  ];
  const lines = formatWidgetLines(states, 135_000, "ctrl+p");
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /panel · 1 running · 2m15s · esc cancel · ctrl\+p inspect/);
  assert.match(lines[1] ?? "", /◐ anthropic\/claude-fable-5 xhigh {2}running bash {2}41k tok/);
  assert.match(lines[2] ?? "", /● openai\/gpt-5\.6-sol xhigh {2}answered {2}38k tok · \$0\.71/);
});

test("formatDuration", () => {
  assert.equal(formatDuration(9_000), "9s");
  assert.equal(formatDuration(135_000), "2m15s");
});

test("overlay model: tab cycles panelists and wraps; tail returns transcript", () => {
  const states = [
    state({ id: 0, spec: { model: "a/a", thinking: "high" }, transcript: ["a1", "a2"] }),
    state({ id: 1, spec: { model: "b/b", thinking: "low" }, transcript: ["b1"] }),
  ];
  const model = new OverlayModel(states);
  assert.match(model.titleLine(), /Panelist 1\/2: a\/a high/);
  assert.deepEqual(model.tail(10), ["a1", "a2"]);
  model.next();
  assert.match(model.titleLine(), /Panelist 2\/2: b\/b low/);
  model.next();
  assert.match(model.titleLine(), /Panelist 1\/2/); // wraps

  let closed = false;
  const overlay = new PanelInspectOverlay(themeStub, model, () => {
    closed = true;
  });
  overlay.handleInput(KEY.tab);
  assert.match(model.titleLine(), /Panelist 2\/2/);
  overlay.handleInput(KEY.escape);
  assert.equal(closed, true);
});
