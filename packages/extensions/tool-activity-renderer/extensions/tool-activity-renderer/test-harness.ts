/** Shared harness for the renderer tests: a fake pi host, a fixed clock, and a Row driver that goes through renderCall/renderResult. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ThemeStyle } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, mixColors, parseColor, setCapabilities, stripTerminalSequences, styleText } from "@earendil-works/pi-tui";

const agentDir = mkdtempSync(join(tmpdir(), "pi-tool-renderer-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
initTheme("dark");

export const { default: registerExtension } = await import("../tool-activity-renderer.ts");

export const { clock, formatDuration } = await import("./palette.ts");

export type Component = { render(width: number): string[] };

export type Handler = (event: any, ctx: any) => unknown;

export type CapturedTool = {
	name: string;
	renderCall: (args: Record<string, unknown>, theme: unknown, context: RowContext) => Component;
	renderResult: (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown, context: RowContext) => Component;
};

export type RowContext = {
	args: Record<string, unknown>;
	toolCallId: string;
	state: Record<string, unknown>;
	lastComponent: undefined;
	cwd: string;
	executionStarted: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	isError: boolean;
	invalidate(): void;
	invalidations: number;
};

export const TOKENS: Record<string, string> = {
	text: "#ececf0",
	muted: "#8b8b94",
	dim: "#5d5d66",
	borderMuted: "#36363d",
	accent: "#6cb6ff",
	success: "#7fd18b",
	error: "#ff6b6b",
	warning: "#f2c46d",
	toolDiffAdded: "#7fd18b",
	toolDiffRemoved: "#ff7b7b",
	toolDiffContext: "#5d5d66",
	toolSuccessBg: "#15201a",
	toolErrorBg: "#231617",
};

/** A theme with real truecolor output, so widths and colors in rendered lines are the terminal's. */

export const theme = {
	colors: new Proxy({} as Record<string, Color>, { get: (_target, key) => parseColor(TOKENS[String(key)] ?? "#808080") }),
	style: (text: string, options: ThemeStyle) => styleText(text, options as { fg?: Color; bg?: Color }, "truecolor"),
};

export function createHarness() {
	const tools = new Map<string, CapturedTool>();
	const handlers = new Map<string, Handler[]>();
	registerExtension({
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI);
	const emit = (event: string, payload: Record<string, unknown>, ctx: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) handler({ type: event, ...payload }, ctx);
	};
	return { tools, emit };
}

export type Harness = ReturnType<typeof createHarness>;

/** One tool row, driven the way pi's ToolExecutionComponent drives it: call, then result, then render. */

export class Row {
	readonly context: RowContext;
	private result: { content: unknown[]; details?: unknown; isError: boolean; partial: boolean } | undefined;

	constructor(
		private readonly harness: Harness,
		readonly toolName: string,
		readonly id: string,
		args: Record<string, unknown>,
		cwd = "/workspace/project",
	) {
		this.context = {
			args,
			toolCallId: id,
			state: {},
			lastComponent: undefined,
			cwd,
			executionStarted: false,
			argsComplete: true,
			isPartial: false,
			expanded: false,
			showImages: false,
			isError: false,
			invalidations: 0,
			invalidate() {
				this.invalidations += 1;
			},
		};
	}

	start(): this {
		this.harness.emit("tool_execution_start", { toolCallId: this.id, toolName: this.toolName, args: this.context.args });
		this.context.executionStarted = true;
		return this;
	}

	partial(text: string): this {
		this.result = { content: [{ type: "text", text }], isError: false, partial: true };
		return this;
	}

	finish(text: string, options: { isError?: boolean; details?: unknown } = {}): this {
		this.harness.emit("tool_execution_end", { toolCallId: this.id, toolName: this.toolName, isError: options.isError ?? false });
		this.result = { content: [{ type: "text", text }], details: options.details, isError: options.isError ?? false, partial: false };
		return this;
	}

	/** Restored from history: a result with no execution events in this process. */
	restore(text: string, options: { isError?: boolean; details?: unknown; image?: boolean } = {}): this {
		const content: unknown[] = [{ type: "text", text }, ...(options.image ? [{ type: "image", data: "", mimeType: "image/png" }] : [])];
		this.result = { content, details: options.details, isError: options.isError ?? false, partial: false };
		return this;
	}

	expand(expanded = true): this {
		this.context.expanded = expanded;
		return this;
	}

	/** Lines this row contributes to the transcript at `width`: the call slot, then the result slot. */
	render(width = 120): string[] {
		const tool = this.harness.tools.get(this.toolName);
		assert.ok(tool, `${this.toolName} should be registered`);
		this.context.isError = this.result?.isError ?? false;
		this.context.isPartial = this.result?.partial ?? false;
		const call = tool.renderCall(this.context.args, theme, this.context);
		const result = this.result
			? tool.renderResult({ content: this.result.content, details: this.result.details }, { expanded: this.context.expanded, isPartial: this.result.partial }, theme, this.context)
			: undefined;
		return [...call.render(width), ...(result?.render(width) ?? [])];
	}

	/** A left click on this row's call component, the way pi's MouseRegion forwards it. */
	click(type = "click", button = "left"): unknown {
		const tool = this.harness.tools.get(this.toolName);
		assert.ok(tool);
		const component = tool.renderCall(this.context.args, theme, this.context) as Component & { handleMouse?(event: unknown): unknown };
		return component.handleMouse?.({ type, button, x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: 1 });
	}

	/**
	 * Render the way pi's HTML export does: fresh state per tool call, the call drawn once before the
	 * result exists, then the collapsed and expanded results. Returns each surface's plain lines.
	 */
	exportRender(width = 120): { call: string[]; collapsed: string[]; expanded: string[] } {
		const tool = this.harness.tools.get(this.toolName);
		assert.ok(tool && this.result, "export renders a finished tool");
		const context = { ...this.context, state: {}, executionStarted: true, isPartial: true, isError: false, expanded: false };
		const plain = (component: Component) => component.render(width).map((line) => stripTerminalSequences(line));
		const call = plain(tool.renderCall(context.args, theme, context));
		const content = { content: this.result.content, details: this.result.details };
		const settled = { ...context, isPartial: false, isError: this.result.isError };
		const collapsed = plain(tool.renderResult(content, { expanded: false, isPartial: false }, theme, settled));
		const expanded = plain(tool.renderResult(content, { expanded: true, isPartial: false }, theme, { ...settled, expanded: true }));
		return { call, collapsed, expanded };
	}

	plain(width = 120): string[] {
		return this.render(width).map((line) => stripTerminalSequences(line));
	}

	stop(): void {
		const timer = this.context.state.timer as ReturnType<typeof setInterval> | undefined;
		if (timer) clearInterval(timer);
	}
}

export function at<T>(now: number, run: () => T): T {
	const original = clock.now;
	clock.now = () => now;
	try {
		return run();
	} finally {
		clock.now = original;
	}
}

export function setHyperlinks(enabled: boolean): void {
	setCapabilities({ images: null, trueColor: true, hyperlinks: enabled });
}

/** The 24-bit foreground in effect where `needle` starts in `line`. */

export function fgAt(line: string, needle: string): string | undefined {
	const index = line.indexOf(needle);
	assert.ok(index >= 0, `"${needle}" not in ${JSON.stringify(line)}`);
	const matches = [...line.slice(0, index).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
	const last = matches.at(-1);
	return last ? `#${[last[1], last[2], last[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}` : undefined;
}

export const hex = (color: Color) => colorToHex(color).toLowerCase();

export const CASES = [
	{ tool: "read", args: { path: "packages/app/src/index.ts", offset: 10, limit: 20 }, running: "Reading", done: "Read", target: "index.ts:10-29", output: "a\nb\nc", meta: "3 lines" },
	{ tool: "grep", args: { pattern: "computeStats", path: "packages" }, running: "Searching", done: "Searched", target: "computeStats  in packages", output: "a.ts:1\nb.ts:2", meta: "2 matches" },
	{ tool: "find", args: { pattern: "*.ts", path: "src" }, running: "Finding", done: "Found", target: "*.ts  in src", output: "a.ts", meta: "1 file" },
	{ tool: "ls", args: { path: "src" }, running: "Listing", done: "Listed", target: "src", output: "a\nb", meta: "2 entries" },
	{ tool: "bash", args: { command: "npm test" }, running: "Running", done: "Ran", target: "$ npm test", output: "ok\npassed", meta: "2 lines" },
	{ tool: "write", args: { path: "src/new.ts", content: "one\ntwo\n" }, running: "Writing", done: "Wrote", target: "new.ts", output: "written", meta: "2 lines" },
	{ tool: "edit", args: { path: "src/old.ts" }, running: "Editing", done: "Edited", target: "old.ts", output: "ok", meta: "\\+1  −1", details: { diff: "- 3 a = 1\n+ 3 a = 2" } },
] as const;

export function message(...calls: Array<[id: string, name: string]>) {
	return { role: "assistant", content: [{ type: "text", text: "Looking." }, ...calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} }))] };
}

export function runFixture() {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["r1", "read"], ["g1", "grep"], ["b1", "bash"], ["r2", "read"]) });
	const rows = {
		r1: new Row(harness, "read", "r1", { path: "src/a.ts" }),
		g1: new Row(harness, "grep", "g1", { pattern: "needle", path: "src" }),
		b1: new Row(harness, "bash", "b1", { command: "ls" }),
		r2: new Row(harness, "read", "r2", { path: "src/b.ts" }),
	};
	return { harness, rows };
}

export function recordingUi() {
	const calls: Array<{ method: "indicator" | "message"; value: unknown }> = [];
	const rawMessages: string[] = [];
	return {
		calls,
		rawMessages,
		ui: {
			theme,
			setWorkingIndicator(options?: unknown) {
				calls.push({ method: "indicator", value: options });
			},
			setWorkingMessage(message?: string) {
				if (message !== undefined) rawMessages.push(message);
				calls.push({ method: "message", value: message === undefined ? undefined : stripTerminalSequences(message) });
			},
		},
	};
}

export function strongSpans(line: string, bg: string, ink: string): string {
	const strong = hex(mixColors(parseColor(TOKENS[bg]!), parseColor(TOKENS[ink]!), 0.28, "srgb"));
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(strong.slice(i, i + 2), 16));
	return [...line.matchAll(new RegExp(`\\x1b\\[48;2;${r};${g};${b}m(?:\\x1b\\[[0-9;]*m)*([^\\x1b]*)`, "g"))].map((m) => m[1]).join("");
}
