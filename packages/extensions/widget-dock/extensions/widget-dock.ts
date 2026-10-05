/**
 * widget-dock — folds the todo and subagent widgets above the editor into one line.
 *
 * pi stacks extension widgets above the editor at full height, so a todo list and a fleet of
 * background agents can take twenty rows of transcript. pi gives every extension the same `ctx.ui`
 * object, and widgets are set through `ctx.ui.setWidget` at call time, so this extension wraps that
 * method once per UI context: the docked widgets' components are kept here instead of in pi's
 * stack, and one dock widget draws them, collapsed to a single summary line until toggled open.
 */
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Widget keys the dock takes over, in the order they appear on the dock line. */
export const DOCKED_KEYS = ["rpiv-todos", "agents"] as const;
type DockedKey = (typeof DOCKED_KEYS)[number];

/** The status a subagent fleet reports ("3 running agents"); the dock shows it instead of the footer. */
export const AGENTS_STATUS_KEY = "subagents";
export const DOCK_WIDGET_KEY = "widget-dock";
/** An alt chord: unlike ctrl+shift chords it arrives intact in every terminal (ctrl+shift+d degrades to ctrl+d, which quits pi). */
export const TOGGLE_KEY = "alt+w";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_FRAME_MS = 250;

type WidgetComponent = Component & { dispose?(): void };
type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent;
type WidgetContent = string[] | WidgetFactory;
type SetWidget = ExtensionUIContext["setWidget"];
type SetStatus = ExtensionUIContext["setStatus"];

function isDockedKey(key: string): key is DockedKey {
	return (DOCKED_KEYS as readonly string[]).includes(key);
}

/** A widget given as plain lines, drawn the way pi would draw it. */
function linesComponent(lines: readonly string[]): WidgetComponent {
	return { render: (width) => lines.map((line) => truncateToWidth(line, width, "…")), invalidate() {} };
}

/** The visible text of a widget's rendered lines, blank lines dropped. */
function plainLines(component: Component, width: number): string[] {
	return component
		.render(width)
		.map((line) => stripTerminalSequences(line).trimEnd())
		.filter((line) => line.trim() !== "");
}

/** ` Todos 1/3 · Push, deploy …` from the todo widget's heading and its task in progress. */
export function summarizeTodos(lines: readonly string[]): { active: boolean; text: string } | undefined {
	const heading = lines.find((line) => /Todos \(\d+\/\d+\)/.test(line));
	if (!heading) return undefined;
	const [, done, total] = /Todos \((\d+)\/(\d+)\)/.exec(heading) ?? [];
	const current = lines.find((line) => line.includes("◐"));
	const task = current
		?.slice(current.indexOf("◐") + 1)
		.replace(/\s+\(.*\)\s*$/, "")
		.trim();
	return { active: heading.includes("●"), text: `Todos ${done}/${total}${task ? ` · ${task}` : ""}` };
}

/** The docked widgets, drawn as one summary line or, toggled open, as the widgets themselves. */
export class Dock implements WidgetComponent {
	expanded = false;
	agentsStatus: string | undefined;
	private readonly contents = new Map<DockedKey, WidgetContent>();
	private readonly components = new Map<DockedKey, WidgetComponent>();
	private tui: TUI | undefined;
	private theme: Theme | undefined;

	get isEmpty(): boolean {
		return this.contents.size === 0 && this.agentsStatus === undefined;
	}

	/** pi created the dock widget: build the docked components it is now able to draw. */
	attach(tui: TUI, theme: Theme): this {
		this.tui = tui;
		this.theme = theme;
		for (const key of this.contents.keys()) this.build(key);
		return this;
	}

	set(key: DockedKey, content: WidgetContent | undefined): void {
		this.components.get(key)?.dispose?.();
		this.components.delete(key);
		if (content === undefined) this.contents.delete(key);
		else {
			this.contents.set(key, content);
			if (this.tui) this.build(key);
		}
		this.requestRender();
	}

	toggle(): void {
		this.expanded = !this.expanded;
		this.requestRender();
	}

	requestRender(): void {
		this.tui?.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		if (!theme) return [];
		if (this.expanded) {
			return DOCKED_KEYS.flatMap((key) => this.components.get(key)?.render(width) ?? []).map((line) => truncateToWidth(line, width, "…"));
		}
		return [this.summaryLine(theme, width)];
	}

	invalidate(): void {
		for (const component of this.components.values()) component.invalidate();
	}

	dispose(): void {
		for (const component of this.components.values()) component.dispose?.();
		this.components.clear();
		this.tui = undefined;
	}

	private build(key: DockedKey): void {
		const content = this.contents.get(key);
		if (!content || !this.tui || !this.theme) return;
		this.components.set(key, Array.isArray(content) ? linesComponent(content) : content(this.tui, this.theme));
	}

	/** ` ● Todos 1/3 · current task   ⠋ 3 running agents ……… alt+w to expand` */
	private summaryLine(theme: Theme, width: number): string {
		const hint = theme.fg("dim", `${TOGGLE_KEY} to expand`);
		const segments: string[] = [];
		const todos = this.components.get("rpiv-todos");
		if (todos) {
			const summary = summarizeTodos(plainLines(todos, width));
			if (summary) segments.push(`${theme.fg(summary.active ? "accent" : "dim", summary.active ? "●" : "○")} ${theme.fg("text", summary.text)}`);
		}
		const agents = this.components.get("agents");
		if (agents || this.agentsStatus) {
			const running = this.agentsStatus !== undefined;
			const glyph = running ? SPINNER[Math.floor(Date.now() / SPINNER_FRAME_MS) % SPINNER.length] : "○";
			const text = this.agentsStatus ?? (agents ? (plainLines(agents, width)[0] ?? "Agents").replace(/^\W+/, "") : "Agents");
			segments.push(`${theme.fg(running ? "accent" : "dim", glyph ?? "○")} ${theme.fg("muted", text)}`);
		}
		const left = ` ${segments.join("   ")}`;
		const room = width - visibleWidth(hint) - 3;
		if (room < 10) return truncateToWidth(left, width, "…");
		const fitted = truncateToWidth(left, room, "…");
		return `${fitted}${" ".repeat(width - visibleWidth(fitted) - visibleWidth(hint))}${hint}`;
	}
}

/**
 * Route the docked widgets and the agents status on `ui` through `dock`. Returns false when `ui`
 * is already routed (pi reuses one UI context until /reload or a session switch replaces it).
 */
export function installDock(ui: ExtensionUIContext, dock: Dock): boolean {
	if (routed.has(ui)) return false;
	routed.add(ui);
	const setWidget: SetWidget = ui.setWidget.bind(ui);
	const setStatus: SetStatus = ui.setStatus.bind(ui);
	let shown = false;
	const sync = () => {
		if (dock.isEmpty && shown) setWidget(DOCK_WIDGET_KEY, undefined);
		if (!dock.isEmpty && !shown) setWidget(DOCK_WIDGET_KEY, (tui, theme) => dock.attach(tui, theme));
		shown = !dock.isEmpty;
	};
	// One implementation behind setWidget's two overloads (lines or a component factory).
	const passThrough = setWidget as (key: string, content: WidgetContent | undefined, options?: Parameters<SetWidget>[2]) => void;
	const routedSetWidget = (key: string, content: WidgetContent | undefined, options?: Parameters<SetWidget>[2]) => {
		if (!isDockedKey(key)) return passThrough(key, content, options);
		dock.set(key, content);
		sync();
	};
	ui.setWidget = routedSetWidget as SetWidget;
	ui.setStatus = (key, text) => {
		if (key !== AGENTS_STATUS_KEY) return setStatus(key, text);
		dock.agentsStatus = text;
		sync();
		dock.requestRender();
	};
	return true;
}

const routed = new WeakSet<ExtensionUIContext>();

export default function widgetDock(pi: ExtensionAPI): void {
	let dock = new Dock();
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		// A new UI context (reload, session switch) starts with an empty widget stack.
		if (!routed.has(ctx.ui)) dock = new Dock();
		installDock(ctx.ui, dock);
	});
	pi.registerShortcut(TOGGLE_KEY, {
		description: "Expand or collapse the todo and agent widgets",
		handler: () => dock.toggle(),
	});
}
