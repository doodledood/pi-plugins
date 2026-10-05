import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { AGENTS_STATUS_KEY, DOCK_WIDGET_KEY, Dock, installDock, summarizeTodos, TOGGLE_KEY } from "./widget-dock.ts";

const theme = { fg: (_token: string, text: string) => `\x1b[2m${text}\x1b[22m` } as unknown as Theme;

/** A UI context that records what reaches pi, and builds factory widgets the way pi does. */
function fakeUi() {
	const widgets = new Map<string, { render(width: number): string[]; dispose?(): void }>();
	const statuses = new Map<string, string | undefined>();
	let renders = 0;
	const tui = { requestRender: () => renders++, terminal: { columns: 120, rows: 40 } } as unknown as TUI;
	const ui = {
		setWidget(key: string, content: unknown) {
			widgets.get(key)?.dispose?.();
			widgets.delete(key);
			if (typeof content === "function") widgets.set(key, content(tui, theme));
			else if (Array.isArray(content)) widgets.set(key, { render: () => content as string[] });
		},
		setStatus(key: string, text: string | undefined) {
			statuses.set(key, text);
		},
	} as unknown as ExtensionUIContext;
	const plain = (key: string, width = 120) => (widgets.get(key)?.render(width) ?? []).map((line) => stripTerminalSequences(line));
	return { ui, widgets, statuses, plain, renders: () => renders };
}

const TODOS = [
	"● Todos (0/3)",
	"├─ ◐ Push, deploy t205986, staging E2E (deploying t205986 and running staging E2E)",
	"├─ ○ Open PR, CI, handoff, final report",
	"└─ ○ Fix review-pr threads batch (15)",
	"",
];
const AGENTS = ["● Agents", "├─ ⠋ Agent (twin)  Arbiter bat · 14 tool uses · 93.3s", "│  ⎿  thinking…", "└─ +15 more (15 running)"];

test("widgets the dock doesn't own reach pi untouched", () => {
	const { ui, widgets, plain } = fakeUi();
	installDock(ui, new Dock());
	ui.setWidget("other", ["hello"]);
	assert.deepEqual(plain("other"), ["hello"]);
	assert.equal(widgets.has(DOCK_WIDGET_KEY), false, "no dock until there is something to dock");
});

test("the todo and agent widgets collapse into one line under the dock", () => {
	const { ui, widgets, statuses, plain } = fakeUi();
	installDock(ui, new Dock());
	ui.setWidget("rpiv-todos", TODOS);
	ui.setWidget("agents", () => ({ render: () => AGENTS, invalidate() {} }));
	ui.setStatus(AGENTS_STATUS_KEY, "20 running agents");
	assert.deepEqual([...widgets.keys()], [DOCK_WIDGET_KEY], "only the dock reaches pi's widget stack");
	assert.equal(statuses.has(AGENTS_STATUS_KEY), false, "the agents count moves from the footer to the dock");
	const [line, ...rest] = plain(DOCK_WIDGET_KEY);
	assert.deepEqual(rest, []);
	assert.match(line ?? "", /^ ● Todos 0\/3 · Push, deploy t205986, staging E2E {3}. 20 running agents +alt\+w to expand$/);
	for (const width of [30, 60, 120]) assert.ok(plain(DOCK_WIDGET_KEY, width).every((l) => visibleWidth(l) <= width), `fits ${width}`);
	assert.ok(ui.setStatus !== undefined && TOGGLE_KEY);
});

test("toggling opens the docked widgets in full and closes them again", () => {
	const { ui, plain } = fakeUi();
	const dock = new Dock();
	installDock(ui, dock);
	ui.setWidget("rpiv-todos", TODOS);
	ui.setWidget("agents", AGENTS);
	dock.toggle();
	assert.deepEqual(plain(DOCK_WIDGET_KEY), [...TODOS, ...AGENTS]);
	dock.toggle();
	assert.equal(plain(DOCK_WIDGET_KEY).length, 1);
});

test("clearing a docked widget disposes it; clearing the last one removes the dock", () => {
	const { ui, widgets } = fakeUi();
	installDock(ui, new Dock());
	let disposed = 0;
	ui.setWidget("agents", () => ({ render: () => AGENTS, invalidate() {}, dispose: () => disposed++ }));
	ui.setWidget("rpiv-todos", TODOS);
	ui.setWidget("agents", undefined);
	assert.equal(disposed, 1);
	assert.ok(widgets.has(DOCK_WIDGET_KEY), "todos still docked");
	ui.setWidget("rpiv-todos", undefined);
	assert.equal(widgets.has(DOCK_WIDGET_KEY), false);
});

test("docked widgets are built exactly once, whether set before or after the dock exists", () => {
	const { ui, plain } = fakeUi();
	installDock(ui, new Dock());
	let built = 0;
	ui.setWidget("agents", () => {
		built++;
		return { render: () => AGENTS, invalidate() {} };
	});
	assert.equal(built, 1, "built once, by the dock");
	assert.match(plain(DOCK_WIDGET_KEY)[0] ?? "", /Agents/);
	let todosBuilt = 0;
	ui.setWidget("rpiv-todos", () => {
		todosBuilt++;
		return { render: () => TODOS, invalidate() {} };
	});
	assert.equal(todosBuilt, 1, "a widget set while the dock is up is built once, right away");
	assert.match(plain(DOCK_WIDGET_KEY)[0] ?? "", /Todos 0\/3/);
});

test("the agents status alone keeps the dock up, and clearing it lets the dock go", () => {
	const { ui, widgets, plain } = fakeUi();
	installDock(ui, new Dock());
	ui.setStatus(AGENTS_STATUS_KEY, "2 running agents");
	assert.match(plain(DOCK_WIDGET_KEY)[0] ?? "", /2 running agents/);
	ui.setStatus(AGENTS_STATUS_KEY, undefined);
	assert.equal(widgets.has(DOCK_WIDGET_KEY), false);
	ui.setStatus("other", "x");
});

test("a UI context is routed once", () => {
	const { ui } = fakeUi();
	assert.equal(installDock(ui, new Dock()), true);
	assert.equal(installDock(ui, new Dock()), false);
});

test("todo summaries: heading counts and the task in progress", () => {
	assert.deepEqual(summarizeTodos(TODOS), { active: true, text: "Todos 0/3 · Push, deploy t205986, staging E2E" });
	assert.deepEqual(summarizeTodos(["○ Todos (3/3)", "└─ ✓ done"]), { active: false, text: "Todos 3/3" });
	assert.equal(summarizeTodos(["something else"]), undefined);
});
