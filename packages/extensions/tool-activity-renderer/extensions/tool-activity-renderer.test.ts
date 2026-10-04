import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ThemeStyle } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, mixColors, parseColor, setCapabilities, stripTerminalSequences, styleText, visibleWidth } from "@earendil-works/pi-tui";

const agentDir = mkdtempSync(join(tmpdir(), "pi-tool-renderer-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
initTheme("dark");

const { default: registerExtension } = await import("./tool-activity-renderer.ts");
const { clock, formatDuration } = await import("./tool-activity-renderer/palette.ts");

// ─── harness ──────────────────────────────────────────────────────────────────

type Component = { render(width: number): string[] };
type Handler = (event: any, ctx: any) => unknown;
type CapturedTool = {
	name: string;
	renderCall: (args: Record<string, unknown>, theme: unknown, context: RowContext) => Component;
	renderResult: (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown, context: RowContext) => Component;
};
type RowContext = {
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

const TOKENS: Record<string, string> = {
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
const theme = {
	colors: new Proxy({} as Record<string, Color>, { get: (_target, key) => parseColor(TOKENS[String(key)] ?? "#808080") }),
	style: (text: string, options: ThemeStyle) => styleText(text, options as { fg?: Color; bg?: Color }, "truecolor"),
};

function createHarness() {
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

type Harness = ReturnType<typeof createHarness>;

/** One tool row, driven the way pi's ToolExecutionComponent drives it: call, then result, then render. */
class Row {
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

	plain(width = 120): string[] {
		return this.render(width).map((line) => stripTerminalSequences(line));
	}

	stop(): void {
		const timer = this.context.state.timer as ReturnType<typeof setInterval> | undefined;
		if (timer) clearInterval(timer);
	}
}

function at<T>(now: number, run: () => T): T {
	const original = clock.now;
	clock.now = () => now;
	try {
		return run();
	} finally {
		clock.now = original;
	}
}

function setHyperlinks(enabled: boolean): void {
	setCapabilities({ images: null, trueColor: true, hyperlinks: enabled });
}

/** The 24-bit foreground in effect where `needle` starts in `line`. */
function fgAt(line: string, needle: string): string | undefined {
	const index = line.indexOf(needle);
	assert.ok(index >= 0, `"${needle}" not in ${JSON.stringify(line)}`);
	const matches = [...line.slice(0, index).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)];
	const last = matches.at(-1);
	return last ? `#${[last[1], last[2], last[3]].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}` : undefined;
}

const hex = (color: Color) => colorToHex(color).toLowerCase();

// ─── paths and links (kept from the original renderer) ────────────────────────

test("read, edit and write keep long file path suffixes when the row has room", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const longPath = `/tmp/${Array.from({ length: 12 }, (_, index) => `very-long-segment-${index}`).join("/")}/final-file-name-with-important-suffix.ts`;
	for (const toolName of ["read", "edit", "write"]) {
		const rendered = new Row(harness, toolName, `${toolName}-1`, { path: longPath }).plain(800).join("\n");
		assert.ok(rendered.includes("final-file-name-with-important-suffix.ts"), `${toolName} should preserve the suffix: ${rendered}`);
		assert.ok(!rendered.includes("…") && !rendered.includes("..."), `${toolName} should not truncate when it fits: ${rendered}`);
	}
});

test("read uses file_path render compatibility before path", () => {
	setHyperlinks(false);
	const rendered = new Row(createHarness(), "read", "r", { file_path: "src/from-file-path.ts", path: "src/from-path.ts" }).plain().join("\n");
	assert.ok(rendered.includes("src/from-file-path.ts"));
	assert.ok(!rendered.includes("src/from-path.ts"));
});

test("relative paths display as provided and hyperlink to cwd-relative file URLs", () => {
	setHyperlinks(true);
	const rendered = new Row(createHarness(), "read", "r", { path: "src/file.ts" }).render().join("\n");
	const expectedHref = pathToFileURL(resolve("/workspace/project", "src/file.ts")).href;
	assert.ok(stripTerminalSequences(rendered).includes("src/file.ts"));
	assert.ok(rendered.includes(`\u001B]8;;${expectedHref}\u001B\\`), rendered);
});

test("tilde paths hyperlink under the home directory", () => {
	setHyperlinks(true);
	const rendered = new Row(createHarness(), "read", "r", { path: "~/notes.txt" }).render().join("\n");
	assert.ok(stripTerminalSequences(rendered).includes("~/notes.txt"));
	assert.ok(rendered.includes(`\u001B]8;;${pathToFileURL(join(homedir(), "notes.txt")).href}\u001B\\`), rendered);
});

test("file URL paths hyperlink to the referenced file instead of cwd-relative text", () => {
	setHyperlinks(true);
	const fileUrl = pathToFileURL("/tmp/file-url-source.ts").href;
	const rendered = new Row(createHarness(), "read", "r", { path: fileUrl }).render().join("\n");
	assert.ok(stripTerminalSequences(rendered).includes(fileUrl));
	assert.ok(rendered.includes(`\u001B]8;;${fileUrl}\u001B\\`), rendered);
	assert.ok(!rendered.includes("/workspace/project/file:"), rendered);
});

test("invalid path arguments render as invalid args without hyperlink escape sequences", () => {
	setHyperlinks(true);
	const rendered = new Row(createHarness(), "read", "r", { path: 123 }).render().join("\n");
	assert.ok(stripTerminalSequences(rendered).includes("[invalid arg]"));
	assert.ok(!rendered.includes("\u001B]8;;"));
});

test("disabled hyperlink capability returns plain styled path text", () => {
	setHyperlinks(false);
	const rendered = new Row(createHarness(), "read", "r", { path: "src/plain.ts" }).render().join("\n");
	assert.ok(stripTerminalSequences(rendered).includes("src/plain.ts"));
	assert.ok(!rendered.includes("\u001B]8;;"));
});

// ─── row anatomy ──────────────────────────────────────────────────────────────

const CASES = [
	{ tool: "read", args: { path: "packages/app/src/index.ts", offset: 10, limit: 20 }, running: "Reading", done: "Read", target: "index.ts:10-29", output: "a\nb\nc", meta: "3 lines" },
	{ tool: "grep", args: { pattern: "computeStats", path: "packages" }, running: "Searching", done: "Searched", target: "computeStats  in packages", output: "a.ts:1\nb.ts:2", meta: "2 matches" },
	{ tool: "find", args: { pattern: "*.ts", path: "src" }, running: "Finding", done: "Found", target: "*.ts  in src", output: "a.ts", meta: "1 file" },
	{ tool: "ls", args: { path: "src" }, running: "Listing", done: "Listed", target: "src", output: "a\nb", meta: "2 entries" },
	{ tool: "bash", args: { command: "npm test" }, running: "Running", done: "Ran", target: "$ npm test", output: "ok\npassed", meta: "2 lines" },
	{ tool: "write", args: { path: "src/new.ts", content: "one\ntwo\n" }, running: "Writing", done: "Wrote", target: "new.ts", output: "written", meta: "2 lines" },
	{ tool: "edit", args: { path: "src/old.ts" }, running: "Editing", done: "Edited", target: "old.ts", output: "ok", meta: "\\+1  −1", details: { diff: "- 3 a = 1\n+ 3 a = 2" } },
] as const;

for (const c of CASES) {
	test(`${c.tool} rows read present tense while running and past tense with a right-aligned result when done`, () => {
		setHyperlinks(false);
		for (const width of [60, 100, 200]) {
			const harness = createHarness();
			const row = new Row(harness, c.tool, `${c.tool}-${width}`, { ...c.args });
			at(1_000, () => row.start());
			const running = at(1_500, () => row.plain(width));
			assert.match(running[0] ?? "", new RegExp(`^ ● ${c.running}\\s`), `running head at ${width}: ${running[0]}`);
			assert.match(running[0] ?? "", /0\.5s$/, "live duration sits at the right edge");
			for (const line of at(1_500, () => row.render(width))) assert.ok(visibleWidth(line) <= width, `running line fits ${width}: ${stripTerminalSequences(line)}`);

			at(1_800, () => row.finish(c.output, { details: "details" in c ? c.details : undefined }));
			const done = at(1_900, () => row.plain(width));
			assert.match(done[0] ?? "", new RegExp(`^ ● ${c.done}\\s`), `finished head at ${width}: ${done[0]}`);
			assert.match(done[0] ?? "", new RegExp(`${c.meta}  0\\.8s$`), `result and duration right-aligned at ${width}: ${done[0]}`);
			if (width >= 100) assert.ok((done[0] ?? "").includes(c.target), `target shown at ${width}: ${done[0]}`);
			for (const line of at(1_900, () => row.render(width))) assert.ok(visibleWidth(line) <= width, `line fits ${width}: ${stripTerminalSequences(line)}`);
			row.stop();
		}
	});
}

test("failed rows show a cross, the failure in the result column, and the error underneath", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const read = new Row(harness, "read", "r-err", { path: "missing.ts" });
	at(0, () => read.start());
	at(100, () => read.finish("ENOENT: no such file", { isError: true }));
	const lines = at(200, () => read.plain(80));
	assert.match(lines[0] ?? "", /^ ✕ Read\s+missing\.ts\s+failed  0\.1s$/);
	assert.equal(lines[1], "   ENOENT: no such file");

	for (const [trailer, label] of [
		["Command timed out after 5 seconds", "timed out"],
		["Command aborted", "aborted"],
		["", "failed"],
	] as const) {
		const row = new Row(harness, "bash", `b-${label}`, { command: "sleep 9" }).restore(`partial\n\n${trailer}`, { isError: true });
		assert.match(row.plain(80)[0] ?? "", new RegExp(`${label}$`));
	}

	const bash = new Row(harness, "bash", "b-err", { command: "npm test" });
	at(0, () => bash.start());
	at(300, () => bash.finish("1 failing\nexpected 2\n\nCommand exited with code 1", { isError: true }));
	const bashLines = at(400, () => bash.plain(80));
	assert.match(bashLines[0] ?? "", /exit 1  0\.3s$/);
	assert.deepEqual(bashLines.slice(1), ["   1 failing", "   expected 2"]);
	read.stop();
	bash.stop();
});

test("a running command shows the tail of its output under the row", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "bash", "b", { command: "npm test" });
	at(0, () => row.start());
	row.partial("line 1\nline 2\nline 3");
	assert.deepEqual(at(100, () => row.plain(80)).slice(1), ["   line 2", "   line 3"]);
	row.stop();
});

// ─── temporal depth ───────────────────────────────────────────────────────────

test("a finished row recedes from bright to muted, then stops redrawing", () => {
	setHyperlinks(false);
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const row = new Row(createHarness(), "read", "r", { path: "src/a.ts" });
		at(0, () => row.start());
		at(500, () => row.finish("x"));
		const fresh = at(600, () => row.render(100))[0] ?? "";
		const receded = at(2_600, () => row.render(100))[0] ?? "";
		const soft = mixColors(parseColor(TOKENS.text!), parseColor(TOKENS.muted!), 0.35, "srgb");
		assert.equal(fgAt(fresh, "Read"), hex(soft), "verb starts at the soft text tone");
		assert.equal(fgAt(receded, "Read"), hex(parseColor(TOKENS.muted!)), "verb ends at muted");
		assert.equal(fgAt(fresh, "a.ts"), hex(parseColor(TOKENS.text!)), "file name starts at full text");
		assert.notEqual(fgAt(receded, "a.ts"), fgAt(fresh, "a.ts"), "file name recedes");

		at(2_600, () => mock.timers.tick(100));
		const settled = row.context.invalidations;
		at(5_000, () => mock.timers.tick(1_000));
		assert.equal(row.context.invalidations, settled, "no redraws once the row has settled");
		assert.equal(row.context.state.timer, undefined, "the row's timer is cleared");
	} finally {
		mock.timers.reset();
	}
});

test("rows restored from history render already settled, without timings or timers", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const restored = new Row(harness, "read", "old", { path: "src/a.ts" }).restore("x");
	const line = restored.render(100)[0] ?? "";
	assert.equal(fgAt(line, "Read"), hex(parseColor(TOKENS.muted!)));
	assert.match(stripTerminalSequences(line), /1 line$/);
	assert.equal(restored.context.state.timer, undefined);
});

test("failed rows never recede", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "read", "r", { path: "a.ts" });
	at(0, () => row.start());
	at(100, () => row.finish("boom", { isError: true }));
	assert.equal(at(200, () => row.render(80)).join("\n"), at(9_000, () => row.render(80)).join("\n"));
	assert.equal(fgAt(at(9_000, () => row.render(80))[0] ?? "", "a.ts"), hex(parseColor(TOKENS.text!)), "the target stays at full text");
	row.stop();
});

test("the live verb shimmers: same text, moving color", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "read", "r", { path: "a.ts" });
	at(0, () => row.start());
	const a = at(300, () => row.render(80))[0] ?? "";
	const b = at(700, () => row.render(80))[0] ?? "";
	assert.equal(stripTerminalSequences(a).slice(0, 12), stripTerminalSequences(b).slice(0, 12));
	// Only the verb: the glyph breathes and the duration ticks on their own.
	const verb = (line: string) => line.slice(line.indexOf("●") + 1, line.indexOf("a.ts"));
	assert.notEqual(verb(a), verb(b), "the verb's colors move");
	assert.notEqual(fgAt(at(0, () => row.render(80))[0] ?? "", "●"), fgAt(at(600, () => row.render(80))[0] ?? "", "●"), "the live glyph breathes");
	assert.ok(row.context.state.timer, "a running row redraws on a timer");
	row.stop();
});

// ─── exploratory runs ─────────────────────────────────────────────────────────

function message(...calls: Array<[id: string, name: string]>) {
	return { role: "assistant", content: [{ type: "text", text: "Looking." }, ...calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} }))] };
}

function runFixture() {
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

test("consecutive exploratory calls pack under their first row while running", () => {
	const { rows } = runFixture();
	at(0, () => {
		rows.r1.start();
		rows.g1.start();
	});
	// pi renders a message's rows in content order, so the leader reports before its followers draw.
	at(100, () => rows.r1.render());
	const g1 = at(100, () => rows.g1.plain());
	const r1 = at(100, () => rows.r1.plain());
	assert.deepEqual(g1, [], "the follower draws nothing — its leader draws it");
	assert.equal(r1.length, 2, "the leader draws both rows, with no blank line between them");
	assert.match(r1[0] ?? "", /^ ● Reading\s+src\/a\.ts/);
	assert.match(r1[1] ?? "", /^ ● Searching\s+needle/);
	assert.equal(at(100, () => rows.b1.plain()).length, 1, "a non-exploratory call breaks the run");
	assert.equal(at(100, () => rows.r2.plain()).length, 1, "a lone exploratory call is an ordinary row");
	for (const row of Object.values(rows)) row.stop();
});

test("a finished run folds into one Explored line; a failure keeps it unfolded with the error shown", () => {
	const { rows } = runFixture();
	at(0, () => {
		rows.r1.start();
		rows.g1.start();
	});
	at(300, () => {
		rows.r1.finish("one\ntwo");
		rows.g1.finish("a:1");
	});
	const folded = at(400, () => {
		rows.g1.render();
		return rows.r1.plain();
	});
	assert.equal(folded.length, 1);
	assert.match(folded[0] ?? "", /^ ● Explored\s+1 file · 1 search\b.*0\.3s$/);

	const failing = runFixture();
	at(0, () => {
		failing.rows.r1.start();
		failing.rows.g1.start();
	});
	at(300, () => {
		failing.rows.r1.finish("one");
		failing.rows.g1.finish("bad regex", { isError: true });
	});
	at(400, () => failing.rows.g1.render());
	const unfolded = at(400, () => failing.rows.r1.plain());
	assert.equal(unfolded.length, 3);
	assert.match(unfolded[1] ?? "", /^ ✕ Searched/);
	assert.equal(unfolded[2], "   bad regex");
	for (const row of [...Object.values(rows), ...Object.values(failing.rows)]) row.stop();
});

test("expanded view shows every exploratory row on its own with its output", () => {
	const { rows } = runFixture();
	rows.r1.restore("one\ntwo").expand();
	rows.g1.restore("a:1").expand();
	const r1 = rows.r1.plain().map((line) => line.trimEnd());
	assert.match(r1[0] ?? "", /^ ● Read\s/);
	assert.deepEqual(r1.slice(1), ["   one", "   two"]);
	assert.match(rows.g1.plain()[0] ?? "", /^ ● Searched\s/);
});

test("rows pi draws before session_start (resume, reload) fold once the branch is read", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const r1 = new Row(harness, "read", "r1", { path: "a.ts" }).restore("x");
	const r2 = new Row(harness, "read", "r2", { path: "b.ts" }).restore("y");
	r1.render();
	r2.render();
	harness.emit("session_start", { reason: "resume" }, { sessionManager: { getBranch: () => [{ type: "message", message: message(["r1", "read"], ["r2", "read"]) }] } });
	const leader = r1.plain();
	assert.equal(leader.length, 1);
	assert.match(leader[0] ?? "", /^ ● Explored\s+2 files/);
});

test("runs restored from session history fold the same way", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("session_start", { reason: "resume" }, { sessionManager: { getBranch: () => [{ type: "message", message: message(["r1", "read"], ["r2", "read"], ["l1", "ls"]) }] } });
	const r1 = new Row(harness, "read", "r1", { path: "a.ts" }).restore("x");
	const r2 = new Row(harness, "read", "r2", { path: "b.ts" }).restore("y");
	const l1 = new Row(harness, "ls", "l1", { path: "." }).restore("a");
	r1.render();
	r2.render();
	assert.deepEqual(l1.plain(), []);
	const folded = r1.plain();
	assert.equal(folded.length, 1);
	assert.match(folded[0] ?? "", /^ ● Explored\s+2 files · 1 listing/);
});

// ─── diffs ────────────────────────────────────────────────────────────────────

test("edits draw a diff whose changed words carry a stronger tint, with +/− in the result column", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "edit", "e", { path: "src/a.ts" });
	at(0, () => row.start());
	at(100, () => row.finish("ok", { details: { diff: "  181 const keep = 1;\n- 182 const a = foo(x);\n+ 182 const a = foo(x, y);" } }));
	const lines = at(200, () => row.render(80));
	assert.match(stripTerminalSequences(lines[0] ?? ""), /\+1  −1  0\.1s$/);
	assert.equal(lines.length, 4);
	const added = lines[3] ?? "";
	const strong = hex(mixColors(parseColor(TOKENS.toolSuccessBg!), parseColor(TOKENS.toolDiffAdded!), 0.28, "srgb"));
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(strong.slice(i, i + 2), 16));
	const emphasized = [...added.matchAll(new RegExp(`\\x1b\\[48;2;${r};${g};${b}m(?:\\x1b\\[[0-9;]*m)*([^\\x1b]*)`, "g"))].map((m) => m[1]).join("");
	assert.equal(emphasized, ", y", "only the changed span is emphasized");
	assert.ok(lines.slice(1).every((line) => visibleWidth(line) <= 80));
	row.stop();
});

// ─── working line ─────────────────────────────────────────────────────────────

function recordingUi() {
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

test("the working line names the current activity with elapsed time, then hands the indicator back to pi", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		const lastMessage = () => calls.filter((c) => c.method === "message").at(-1)?.value;

		at(0, () => harness.emit("agent_start", {}, ctx));
		const indicator = calls.find((c) => c.method === "indicator")?.value as { frames: string[]; intervalMs: number };
		assert.equal(indicator.frames.length, 10, "one breath of the dot");
		assert.ok(indicator.frames.every((frame) => stripTerminalSequences(frame) === "●"));
		assert.equal(lastMessage(), "Working  0.0s");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "thinking_delta" } });
		at(1_200, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Thinking  1.2s");

		harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: {} });
		at(1_500, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Reading  1.5s");

		harness.emit("tool_execution_start", { toolCallId: "t2", toolName: "subagent", args: {} });
		at(1_600, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Working  1.6s", "a tool the renderer doesn't know reads as plain work");

		harness.emit("tool_execution_end", { toolCallId: "t2" });
		harness.emit("tool_execution_end", { toolCallId: "t1" });
		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "text_delta" } });
		at(2_000, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Writing  2.0s");

		harness.emit("agent_end", { messages: [] }, ctx);
		assert.deepEqual(calls.slice(-2), [
			{ method: "indicator", value: undefined },
			{ method: "message", value: undefined },
		]);
		const settled = calls.length;
		mock.timers.tick(1_000);
		assert.equal(calls.length, settled, "no updates after the run ends");
	} finally {
		mock.timers.reset();
	}
});

test("the working line resets when the session shuts down mid-run, and a second run replaces the first", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		at(0, () => harness.emit("agent_start", {}, ctx));
		at(0, () => harness.emit("agent_start", {}, ctx));
		harness.emit("tool_execution_start", { toolCallId: "t1", toolName: "read", args: {} });
		harness.emit("session_shutdown", {}, ctx);
		assert.deepEqual(calls.slice(-2), [
			{ method: "indicator", value: undefined },
			{ method: "message", value: undefined },
		]);
		const settled = calls.length;
		mock.timers.tick(1_000);
		assert.equal(calls.length, settled, "no timer survives the shutdown or the replaced run");

		// A leaked interval would draw again once the next run sets a UI: exactly one draw per frame.
		at(2_000, () => harness.emit("agent_start", {}, ctx));
		const before = calls.filter((c) => c.method === "message").length;
		at(2_100, () => mock.timers.tick(100));
		assert.equal(calls.filter((c) => c.method === "message").length - before, 1, "one timer, one draw per frame");
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		mock.timers.reset();
	}
});

test("the breathing dot changes color across its frames", () => {
	const harness = createHarness();
	const { calls, ui } = recordingUi();
	harness.emit("agent_start", {}, { hasUI: true, ui });
	const { frames } = calls.find((c) => c.method === "indicator")?.value as { frames: string[] };
	assert.ok(new Set(frames).size > 1, "frames differ in color");
	harness.emit("agent_end", { messages: [] }, { hasUI: true, ui });
});

test("the working line stays out of the way without a UI", () => {
	const harness = createHarness();
	const { calls, ui } = recordingUi();
	harness.emit("agent_start", {}, { hasUI: false, ui });
	harness.emit("agent_end", { messages: [] }, { hasUI: false, ui });
	assert.deepEqual(calls, []);
});

test("work that finished in under a tenth of a second reads <0.1s, not 0.0s", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "read", "fast", { path: "a.ts" });
	at(0, () => row.start());
	at(40, () => row.finish("x"));
	assert.match(at(50, () => row.plain(80))[0] ?? "", /1 line  <0\.1s$/);
	row.stop();
});

test("grep and find both count as searches when a run folds", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["f1", "find"], ["g1", "grep"], ["r1", "read"]) });
	const rows = [
		new Row(harness, "find", "f1", { pattern: "*.md" }).restore("a.md"),
		new Row(harness, "grep", "g1", { pattern: "x" }).restore("a:1"),
		new Row(harness, "read", "r1", { path: "a.ts" }).restore("x"),
	];
	const [leader, ...followers] = rows;
	leader?.render();
	for (const row of followers) row.render();
	assert.match(leader?.plain()[0] ?? "", /^ ● Explored\s+2 searches · 1 file\b/);
});

// ─── review-driven cases ──────────────────────────────────────────────────────

test("a finished row keeps redrawing on a frame timer while it fades, and a running row redraws every frame", () => {
	setHyperlinks(false);
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const row = new Row(createHarness(), "read", "r", { path: "src/a.ts" });
		at(0, () => row.start());
		at(0, () => row.render(100));
		at(100, () => mock.timers.tick(100));
		assert.equal(row.context.invalidations, 1, "a running row redraws within one 100ms frame");

		at(500, () => row.finish("x"));
		at(600, () => row.render(100));
		const before = row.context.invalidations;
		at(700, () => mock.timers.tick(100));
		assert.equal(row.context.invalidations, before + 1, "the fade redraws on the next frame");
		at(1_500, () => mock.timers.tick(100));
		assert.equal(row.context.invalidations, before + 2, "still fading at 1.5s");
		at(2_500, () => mock.timers.tick(100));
		const settled = row.context.invalidations;
		at(3_000, () => mock.timers.tick(100));
		assert.equal(row.context.invalidations, settled, "no redraws after the fade ends");
		assert.equal(row.context.state.timer, undefined);
	} finally {
		mock.timers.reset();
	}
});

test("exploratory calls in different assistant messages stay ordinary rows, and a streaming message forms its run", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["r1", "read"]) });
	harness.emit("message_end", { message: message(["r2", "read"]) });
	const r1 = new Row(harness, "read", "r1", { path: "a.ts" }).restore("x");
	const r2 = new Row(harness, "read", "r2", { path: "b.ts" }).restore("y");
	r1.render();
	assert.match(r1.plain()[0] ?? "", /^ ● Read\s+a\.ts/);
	assert.match(r2.plain()[0] ?? "", /^ ● Read\s+b\.ts/);
	assert.equal(r1.plain().length, 1);
	assert.equal(r2.plain().length, 1);

	harness.emit("message_update", { message: message(["s1", "read"]), assistantMessageEvent: { type: "toolcall_delta" } });
	harness.emit("message_update", { message: message(["s1", "read"], ["s2", "grep"]), assistantMessageEvent: { type: "toolcall_delta" } });
	const s1 = new Row(harness, "read", "s1", { path: "c.ts" }).restore("z");
	const s2 = new Row(harness, "grep", "s2", { pattern: "q" }).restore("c:1");
	s1.render();
	assert.deepEqual(s2.plain(), [], "the streamed second call joins the first call's run");
	assert.match(s1.plain()[0] ?? "", /^ ● Explored\s+1 file · 1 search/);
});

test("collapsed diffs stop at twelve lines with an expand hint; expanded diffs show everything; writes show their body", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const diff = Array.from({ length: 15 }, (_, i) => `+ ${i + 1} line ${i + 1}`).join("\n");
	const edit = new Row(harness, "edit", "e", { path: "a.ts" }).restore("ok", { details: { diff } });
	const collapsed = edit.plain(100);
	assert.equal(collapsed.length, 1 + 12 + 1);
	assert.match(collapsed.at(-1) ?? "", /… 3 more lines/);
	const expanded = edit.expand().plain(100);
	assert.equal(expanded.length, 1 + 15);
	assert.ok(!expanded.some((line) => line.includes("more line")));

	const write = new Row(harness, "write", "w", { path: "b.ts", content: "one\ntwo\n" }).restore("written");
	const lines = write.render(100);
	assert.deepEqual(lines.slice(1).map((line) => stripTerminalSequences(line).trim()), ["1 + one", "2 + two"]);
	assert.ok(lines[1]?.includes("\x1b[48;2;21;32;26m"), "added lines sit on the success background");
});

test("diff rows and the expand hint never exceed a narrow width", () => {
	setHyperlinks(false);
	const diff = Array.from({ length: 30 }, (_, i) => `+ ${i + 1} a fairly long line of code number ${i + 1}`).join("\n");
	const edit = new Row(createHarness(), "edit", "e", { path: "a.ts" }).restore("ok", { details: { diff } });
	for (const width of [30, 20, 8, 3]) {
		for (const line of edit.render(width)) assert.ok(visibleWidth(line) <= width, `fits ${width}: ${JSON.stringify(stripTerminalSequences(line))}`);
	}
});

test("deep paths lose leading directories before the file name or range", () => {
	setHyperlinks(false);
	const path = "packages/extensions/tool-activity-renderer/extensions/tool-activity-renderer/working-line.ts";
	for (const width of [60, 100]) {
		const harness = createHarness();
		const read = new Row(harness, "read", `r${width}`, { path, offset: 10, limit: 20 }).restore("a\nb");
		const line = read.plain(width)[0] ?? "";
		assert.ok(line.includes("working-line.ts:10-29"), `file name and range survive at ${width}: ${line}`);
		assert.ok(line.includes("…/"), `the directory is elided from the left at ${width}: ${line}`);
		assert.match(line, /2 lines$/);
		assert.ok(visibleWidth(line) <= width);
	}
	const roomy = new Row(createHarness(), "read", "wide", { path }).restore("a").plain(200)[0] ?? "";
	assert.ok(roomy.includes(path), "the full path shows when it fits");
	const wide = new Row(createHarness(), "read", "cjk", { path: "文档/目录/子目录/更多目录/文件.ts" }).restore("a").plain(40)[0] ?? "";
	assert.ok(wide.includes("文件.ts"), `double-width directories elide by cells: ${wide}`);
	assert.ok(visibleWidth(wide) <= 40);
});

test("a running command's tail shows what the terminal would: no escape codes, carriage-return redraws collapsed", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "bash", "b", { command: "curl -o f url" });
	at(0, () => row.start());
	row.partial("start\n  % Total\r  10  100k\r  55  100k\r\x1b[32m 100  100k\x1b[0m\x07");
	const rendered = at(100, () => row.render(80));
	assert.deepEqual(rendered.slice(1).map((line) => stripTerminalSequences(line)), ["   start", "    100  100k"]);
	assert.ok(!rendered.join("").includes("\r"));
	row.partial("a\tb\r\n\x1b(Bc\x1b[m\x1b=\x1b7d\r\n");
	assert.deepEqual(at(200, () => row.plain(80)).slice(1), ["   a   b", "   cd"], "tabs expand, CRLF endings survive, every escape form goes");
	row.stop();

	const failing = new Row(createHarness(), "bash", "f", { command: "make" });
	at(0, () => failing.start());
	at(100, () => failing.finish("\x1b[31merror\x1b[0m: bad\r\n\nCommand exited with code 2", { isError: true }));
	assert.deepEqual(at(200, () => failing.plain(80)).slice(1), ["   error: bad"]);
	const expanded = at(200, () => failing.expand().render(80)).join("\n");
	assert.ok(!/\x1b\[31m|\r/.test(expanded), "the expanded output is clean too");
	failing.stop();
});

test("a follower rendered before its leader draws itself rather than vanishing", () => {
	const { rows } = runFixture();
	rows.r1.restore("one");
	rows.g1.restore("a:1");
	assert.match(rows.g1.plain()[0] ?? "", /^ ● Searched\s/);
});

test("expanding one member of a run turns every member back into its own row, with no duplicates", () => {
	const { rows } = runFixture();
	rows.r1.restore("one");
	rows.g1.restore("a:1").expand();
	const r1 = rows.r1.plain();
	const g1 = rows.g1.plain();
	assert.equal(r1.length, 1);
	assert.match(r1[0] ?? "", /^ ● Read\s/);
	assert.match(g1[0] ?? "", /^ ● Searched\s/);
	assert.equal([...r1, ...g1].filter((line) => line.includes("Searched")).length, 1);
});

test("emphasis widens to whole words on both sides of a pair", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "edit", "e", { path: "a.ts" }).restore("ok", {
		details: { diff: "- 2   let sum = 0;\n+ 2   let subtotal = 0;" },
	});
	const lines = row.render(80);
	const emphasized = (line: string, bg: string, ink: string) => {
		const strong = hex(mixColors(parseColor(TOKENS[bg]!), parseColor(TOKENS[ink]!), 0.28, "srgb"));
		const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(strong.slice(i, i + 2), 16));
		return [...line.matchAll(new RegExp(`\\x1b\\[48;2;${r};${g};${b}m(?:\\x1b\\[[0-9;]*m)*([^\\x1b]*)`, "g"))].map((m) => m[1]).join("");
	};
	assert.equal(emphasized(lines[1] ?? "", "toolErrorBg", "toolDiffRemoved"), "sum");
	assert.equal(emphasized(lines[2] ?? "", "toolSuccessBg", "toolDiffAdded"), "subtotal");
});

test("tabs expand to cells, so tab-indented diffs and commands stay within the width", () => {
	setHyperlinks(false);
	const edit = new Row(createHarness(), "edit", "e", { path: "main.go" }).restore("ok", { details: { diff: "- 12 \tfoo := 1\n+ 12 \tfoo := 2\n+ 13 \t\treturn x" } });
	const bash = new Row(createHarness(), "bash", "b", { command: "printf 'a\tb'" }).restore("a b");
	for (const line of [...edit.render(80), ...bash.render(80)]) {
		assert.ok(!line.includes("\t"), `no raw tab: ${JSON.stringify(line)}`);
		assert.ok(visibleWidth(line) <= 80);
	}
	assert.ok(edit.plain(80)[3]?.includes("      return x"), "two tabs become six cells");
});

test("a line that changed end to end gets no emphasis", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "edit", "e", { path: "a.ts" }).restore("ok", { details: { diff: "- 1 abc\n+ 1 xyz" } });
	const lines = row.render(80);
	for (const [line, bg, ink] of [[lines[1], "toolErrorBg", "toolDiffRemoved"], [lines[2], "toolSuccessBg", "toolDiffAdded"]] as const) {
		const strong = hex(mixColors(parseColor(TOKENS[bg]!), parseColor(TOKENS[ink]!), 0.28, "srgb"));
		const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(strong.slice(i, i + 2), 16));
		assert.ok(!(line ?? "").includes(`\x1b[48;2;${r};${g};${b}m`), "no strong tint");
	}
});

test("word emphasis never splits an emoji", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "edit", "e", { path: "a.ts" }).restore("ok", { details: { diff: "- 1 x 😀 y\n+ 1 x 😃 y" } });
	const raw = row.render(80);
	const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
	for (const line of raw) assert.ok(!loneSurrogate.test(line), `no half emoji between style codes: ${JSON.stringify(line)}`);
	const lines = row.plain(80);
	assert.ok(lines[1]?.includes("x 😀 y"), lines[1]);
	assert.ok(lines[2]?.includes("x 😃 y"), lines[2]);
});

test("durations round before choosing the unit", () => {
	assert.equal(formatDuration(59_940), "59.9s");
	assert.equal(formatDuration(59_960), "1m 00s");
	assert.equal(formatDuration(61_500), "1m 01s");
});

// ─── review round 3 ───────────────────────────────────────────────────────────

test("detail lines under a row never exceed the width: long error output and long running tails", () => {
	setHyperlinks(false);
	for (const width of [60, 100, 200]) {
		const harness = createHarness();
		const failing = new Row(harness, "bash", `f${width}`, { command: "make" });
		at(0, () => failing.start());
		at(100, () => failing.finish(`${"x".repeat(300)}\n\nCommand exited with code 1`, { isError: true }));
		const running = new Row(harness, "bash", `r${width}`, { command: "make" });
		at(0, () => running.start());
		running.partial("y".repeat(300));
		const read = new Row(harness, "read", `e${width}`, { path: "a.ts" });
		at(0, () => read.start());
		at(100, () => read.finish(`ENOENT ${"z".repeat(300)}`, { isError: true }));
		for (const row of [failing, running, read]) {
			for (const line of at(200, () => row.render(width))) assert.ok(visibleWidth(line) <= width, `fits ${width}: ${stripTerminalSequences(line).slice(0, 40)}…`);
			row.stop();
		}
	}
});

function strongSpans(line: string, bg: string, ink: string): string {
	const strong = hex(mixColors(parseColor(TOKENS[bg]!), parseColor(TOKENS[ink]!), 0.28, "srgb"));
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(strong.slice(i, i + 2), 16));
	return [...line.matchAll(new RegExp(`\\x1b\\[48;2;${r};${g};${b}m(?:\\x1b\\[[0-9;]*m)*([^\\x1b]*)`, "g"))].map((m) => m[1]).join("");
}

test("multi-line replacements pair line by line; an unpaired line gets no emphasis", () => {
	setHyperlinks(false);
	const pairs = new Row(createHarness(), "edit", "p", { path: "a.ts" }).restore("ok", { details: { diff: "- 1 a = 1\n- 2 b = 2\n+ 1 a = 10\n+ 2 b = 20" } }).render(80);
	assert.equal(strongSpans(pairs[1] ?? "", "toolErrorBg", "toolDiffRemoved"), "1");
	assert.equal(strongSpans(pairs[2] ?? "", "toolErrorBg", "toolDiffRemoved"), "2");
	assert.equal(strongSpans(pairs[3] ?? "", "toolSuccessBg", "toolDiffAdded"), "10");
	assert.equal(strongSpans(pairs[4] ?? "", "toolSuccessBg", "toolDiffAdded"), "20");

	const uneven = new Row(createHarness(), "edit", "u", { path: "a.ts" }).restore("ok", { details: { diff: "- 1 a = 1\n- 2 b = 2\n+ 1 a = 3\n  3 b = 9" } }).render(80);
	assert.equal(strongSpans(uneven[1] ?? "", "toolErrorBg", "toolDiffRemoved"), "1");
	assert.equal(strongSpans(uneven[2] ?? "", "toolErrorBg", "toolDiffRemoved"), "", "the unpaired removed line has no strong tint");
	assert.equal(strongSpans(uneven[3] ?? "", "toolSuccessBg", "toolDiffAdded"), "3");
});

test("a row whose component pi dropped mid-run stops redrawing once its tool ends", () => {
	setHyperlinks(false);
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const orphan = new Row(harness, "bash", "o", { command: "sleep 1" });
		at(0, () => orphan.start());
		at(0, () => orphan.render(80));
		at(100, () => mock.timers.tick(100));
		assert.equal(orphan.context.invalidations, 1, "redraws while the tool runs");
		harness.emit("tool_execution_end", { toolCallId: "o", toolName: "bash", isError: false });
		at(200, () => mock.timers.tick(100));
		at(300, () => mock.timers.tick(100));
		assert.equal(orphan.context.invalidations, 1, "no redraws after the execution ended");
		assert.equal(orphan.context.state.timer, undefined);
	} finally {
		mock.timers.reset();
	}
});

test("the working line shimmers its label, reads Working for tool-call streaming and between turns", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const { calls, rawMessages, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		const lastMessage = () => calls.filter((c) => c.method === "message").at(-1)?.value;
		at(0, () => harness.emit("agent_start", {}, ctx));
		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "thinking_delta" } });
		at(300, () => mock.timers.tick(100));
		const first = rawMessages.at(-1) ?? "";
		at(1_000, () => mock.timers.tick(100));
		const second = rawMessages.at(-1) ?? "";
		const label = (raw: string) => raw.slice(0, raw.lastIndexOf("Thinking") + "Thinking".length + 12);
		assert.equal(stripTerminalSequences(first).split("  ")[0], "Thinking");
		assert.notEqual(label(first), label(second), "the label's colors move");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "toolcall_delta" } });
		at(1_100, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Working  1.1s");

		harness.emit("message_update", { message: {}, assistantMessageEvent: { type: "text_delta" } });
		at(1_200, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Writing  1.2s");
		harness.emit("message_end", { message: { role: "assistant", content: [] } });
		at(1_300, () => mock.timers.tick(100));
		assert.equal(lastMessage(), "Working  1.3s", "a finished reply no longer reads as Writing");
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		mock.timers.reset();
	}
});

test("the finished glyph recedes with its row, and a live-finished folded run recedes too", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "read", "g", { path: "a.ts" });
	at(0, () => row.start());
	at(500, () => row.finish("x"));
	assert.notEqual(fgAt(at(800, () => row.render(80))[0] ?? "", "●"), fgAt(at(3_000, () => row.render(80))[0] ?? "", "●"));
	row.stop();

	const { rows } = runFixture();
	at(0, () => rows.r1.start());
	at(200, () => rows.g1.start());
	at(100, () => rows.r1.finish("one"));
	at(300, () => rows.g1.finish("a:1"));
	const fresh = at(400, () => {
		rows.g1.render();
		return rows.r1.render()[0] ?? "";
	});
	const settled = at(3_000, () => rows.r1.render()[0] ?? "");
	assert.match(stripTerminalSequences(fresh), /0\.3s$/, "the fold spans the whole run, first start to last end");
	assert.notEqual(fgAt(fresh, "Explored"), fgAt(settled, "Explored"));
	for (const r of Object.values(rows)) r.stop();
});

test("session_tree re-reads the branch: the new branch's runs fold", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["x1", "read"]) });
	harness.emit("session_tree", {}, { sessionManager: { getBranch: () => [{ type: "message", message: message(["t1", "read"], ["t2", "ls"]) }] } });
	const t1 = new Row(harness, "read", "t1", { path: "a.ts" }).restore("x");
	const t2 = new Row(harness, "ls", "t2", { path: "." }).restore("a");
	t1.render();
	assert.deepEqual(t2.plain(), []);
	assert.match(t1.plain()[0] ?? "", /^ ● Explored\s+1 file · 1 listing/);
});

test("an expanded bash failure shows its output once, in the output block", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "bash", "x", { command: "npm test" }).restore("1 failing\n\nCommand exited with code 1", { isError: true }).expand();
	assert.equal(row.plain(80).filter((line) => line.includes("1 failing")).length, 1);
});

test("receded success glyphs stay in the success family, not the accent's", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "read", "hue", { path: "a.ts" });
	at(0, () => row.start());
	at(100, () => row.finish("x"));
	const settled = fgAt(at(5_000, () => row.render(80))[0] ?? "", "●") ?? "";
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(settled.slice(i, i + 2), 16)) as [number, number, number];
	assert.ok(g > r && g > b, `green leads the settled glyph: ${settled}`);
	row.stop();
});

test("expand hints draw in one quiet tone, whatever styling pi's key hint carries", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["h1", "read"], ["h2", "read"]) });
	const h1 = new Row(harness, "read", "h1", { path: "a.ts" }).restore("x");
	new Row(harness, "read", "h2", { path: "b.ts" }).restore("y").render();
	const line = h1.render(100)[0] ?? "";
	const hint = line.slice(line.lastIndexOf("\x1b[38;2", line.indexOf("to expand")));
	const colors = new Set([...hint.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map((m) => m[1]));
	assert.equal(colors.size, 1, `one tone across the hint: ${JSON.stringify(hint)}`);
});

// ─── review round 4 ───────────────────────────────────────────────────────────

test("a row rendered after its tool ended without a result stays quiet: no shimmer, no running clock", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const orphan = new Row(harness, "bash", "o", { command: "sleep 1" });
	at(0, () => orphan.start());
	harness.emit("tool_execution_end", { toolCallId: "o", toolName: "bash", isError: false });
	const a = at(500, () => orphan.render(80))[0] ?? "";
	const b = at(900, () => orphan.render(80))[0] ?? "";
	assert.equal(a, b, "nothing moves");
	assert.match(stripTerminalSequences(a), /^ ● Running\s+\$ sleep 1$/, "no duration");
	assert.equal(fgAt(a, "Running"), hex(parseColor(TOKENS.muted!)));
	orphan.stop();
});

test("a row still waiting for its tool shows a dim glyph", () => {
	setHyperlinks(false);
	const line = new Row(createHarness(), "read", "w", { path: "a.ts" }).render(80)[0] ?? "";
	assert.equal(fgAt(line, "●"), hex(parseColor(TOKENS.dim!)));
});

test("the collapsed diff's expand hint is one quiet tone", () => {
	setHyperlinks(false);
	const diff = Array.from({ length: 15 }, (_, i) => `+ ${i + 1} line ${i + 1}`).join("\n");
	const hint = new Row(createHarness(), "edit", "e", { path: "a.ts" }).restore("ok", { details: { diff } }).render(100).at(-1) ?? "";
	assert.match(stripTerminalSequences(hint), /… 3 more lines/);
	assert.deepEqual([...new Set([...hint.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map((m) => m[1]))].length, 1);
});

test("a branch switch forgets execution timings: a re-rendered row settles without a duration", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const row = new Row(harness, "read", "s", { path: "a.ts" });
	at(0, () => row.start());
	at(500, () => row.finish("x"));
	harness.emit("session_start", { reason: "resume" }, { sessionManager: { getBranch: () => [] } });
	const line = at(600, () => row.render(80))[0] ?? "";
	assert.match(stripTerminalSequences(line), /1 line$/);
	assert.equal(fgAt(line, "Read"), hex(parseColor(TOKENS.muted!)));
	row.stop();
});

test("a collapsed diff pairs changes across the cut, so every shown line keeps its emphasis", () => {
	setHyperlinks(false);
	const ctx = ["  1 a", "  2 b", "  3 c", "  4 d"];
	const removed = [5, 6, 7, 8, 9].map((n) => `- ${n} let foo${n} = 1;`);
	const added = [5, 6, 7, 8, 9].map((n) => `+ ${n} let bar${n} = 1;`);
	const lines = new Row(createHarness(), "edit", "e", { path: "a.ts" }).restore("ok", { details: { diff: [...ctx, ...removed, ...added].join("\n") } }).render(100);
	for (const n of [5, 6, 7, 8, 9]) {
		const line = lines.find((l) => stripTerminalSequences(l).includes(`foo${n}`)) ?? "";
		assert.equal(strongSpans(line, "toolErrorBg", "toolDiffRemoved"), `foo${n}`, `removed line ${n} keeps its emphasis`);
	}
});

test("an image read keeps its run unpacked, so the image stays under its own row", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["i1", "read"], ["i2", "read"]) });
	const text = new Row(harness, "read", "i1", { path: "a.ts" }).restore("x");
	const image = new Row(harness, "read", "i2", { path: "shot.png" }).restore("Read image", { image: true });
	assert.match(text.plain()[0] ?? "", /^ ● Read\s+a\.ts/);
	assert.equal(text.plain().length, 1);
	assert.match(image.plain()[0] ?? "", /^ ● Read\s+shot\.png.*image$/);
});

test("result and target variants: applied, no output, no matches, truncated, timeouts, multi-line commands, offset-only ranges", () => {
	setHyperlinks(false);
	const h = createHarness();
	assert.match(new Row(h, "edit", "v1", { path: "a.ts" }).restore("ok", { details: {} }).plain(100)[0] ?? "", /applied$/);
	assert.match(new Row(h, "bash", "v2", { command: "true" }).restore("").plain(100)[0] ?? "", /no output$/);
	assert.match(new Row(h, "grep", "v3", { pattern: "zzz" }).restore("No matches found").plain(100)[0] ?? "", /0 matches$/);
	assert.match(new Row(h, "read", "v4", { path: "big.ts" }).restore("a\nb", { details: { truncation: { truncated: true } } }).plain(100)[0] ?? "", /2 lines  ⚠ truncated$/);
	assert.match(new Row(h, "bash", "v5", { command: "a\nb", timeout: 5 }).restore("x").plain(100)[0] ?? "", /\$ a ⏎ b  timeout 5s/);
	assert.match(new Row(h, "read", "v6", { path: "a.ts", offset: 10 }).restore("x").plain(100)[0] ?? "", /a\.ts:10\s/);
	assert.match(new Row(h, "grep", "v7", { pattern: "x", glob: "*.ts", ignoreCase: true, literal: true }).restore("a:1").plain(100)[0] ?? "", /x {2}in \. {2}\*\.ts -i literal/);
});

// ─── review round 5 ───────────────────────────────────────────────────────────

test("CRLF write content still draws as an added diff", () => {
	setHyperlinks(false);
	const lines = new Row(createHarness(), "write", "w", { path: "a.txt", content: "a\r\nb\r\n" }).restore("ok").render(80);
	assert.deepEqual(lines.slice(1).map((l) => stripTerminalSequences(l).trim()), ["1 + a", "2 + b"]);
	assert.ok(lines[1]?.includes("\x1b[48;2;21;32;26m"));
});

test("empty find/ls results, grep truncation, and the five-line failure preview cap", () => {
	setHyperlinks(false);
	const h = createHarness();
	assert.match(new Row(h, "find", "f0", { pattern: "*.zz" }).restore("No files found matching pattern").plain(100)[0] ?? "", /0 files$/);
	assert.match(new Row(h, "ls", "l0", { path: "empty" }).restore("(empty directory)").plain(100)[0] ?? "", /0 entries$/);
	assert.match(new Row(h, "grep", "g0", { pattern: "x" }).restore("a:1", { details: { truncation: { truncated: true } } }).plain(100)[0] ?? "", /1 match {2}⚠ truncated$/);
	const out = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join("\n");
	const failed = new Row(h, "bash", "b8", { command: "make" }).restore(`${out}\n\nCommand exited with code 2`, { isError: true }).plain(100);
	assert.deepEqual(failed.slice(1), ["   line 4", "   line 5", "   line 6", "   line 7", "   line 8"]);
});

test("a result that arrives without tool_execution_end (aborted message) still settles with its duration", () => {
	setHyperlinks(false);
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const harness = createHarness();
		const row = new Row(harness, "read", "a", { path: "a.ts" });
		at(0, () => row.start());
		row.restore("Operation aborted", { isError: true });
		assert.match(at(300, () => row.plain(80))[0] ?? "", /^ ✕ Read\s+a\.ts\s+failed {2}0\.3s$/);
		assert.match(at(900, () => row.plain(80))[0] ?? "", /failed {2}0\.3s$/, "the duration is fixed when the result lands, not a running clock");
		assert.equal(row.context.state.timer, undefined, "not running");

		const { calls, ui } = recordingUi();
		const ctx = { hasUI: true, ui };
		at(0, () => harness.emit("agent_start", {}, ctx));
		harness.emit("tool_execution_start", { toolCallId: "never-ends", toolName: "read", args: {} });
		harness.emit("agent_end", { messages: [] }, ctx);
		at(1_000, () => harness.emit("agent_start", {}, ctx));
		at(1_100, () => mock.timers.tick(100));
		assert.equal(calls.filter((c) => c.method === "message").at(-1)?.value, "Working  0.1s", "an unfinished tool from the last run is forgotten");
		harness.emit("agent_end", { messages: [] }, ctx);
	} finally {
		mock.timers.reset();
	}
});
