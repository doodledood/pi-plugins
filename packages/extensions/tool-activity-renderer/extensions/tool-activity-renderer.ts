import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentToolResult, EditToolDetails, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	keyText,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { GraphiteDiff } from "./tool-activity-renderer/diff.ts";
import { clock, FRAME_MS, paint, type ThemeLike, tones } from "./tool-activity-renderer/palette.ts";
import { isFading, isLive, type MetaPart, type RowHead, renderFoldedRun, renderRow, runColumn, TOOL_KINDS, type TargetPart, type ToolKind } from "./tool-activity-renderer/row.ts";
import { ExploreRuns } from "./tool-activity-renderer/runs.ts";
import { cellLines } from "./tool-activity-renderer/text.ts";
import { registerWorkingLine } from "./tool-activity-renderer/working-line.ts";

type ToolRenderMode = "compact" | "default";
type BuiltInTools = ReturnType<typeof createBuiltInTools>;
type AnyToolDefinition = ToolDefinition<any, any, any>;
type ToolResult = AgentToolResult<unknown>;

/** The slice of pi's tool render context this renderer reads. */
interface RenderContext {
	args: unknown;
	toolCallId: string;
	state: RowState;
	cwd: string;
	expanded: boolean;
	isError: boolean;
	invalidate(): void;
}

interface RowState {
	head?: RowHead;
	view?: RowView;
	timer?: ReturnType<typeof setInterval>;
}

interface ConfigFile {
	mode?: unknown;
}

/** Wall-clock span of one execution, recorded from pi's tool events so restored rows carry none. */
interface Execution {
	startedAt: number;
	endedAt?: number;
}

/** State shared by every row of one extension instance. */
interface Shared {
	runs: ExploreRuns;
	executions: Map<string, Execution>;
}

const CONFIG_PATH = join(getAgentDir(), "tool-activity-renderer.json");
const COMPACT_MODE: ToolRenderMode = "compact";
const DEFAULT_MODE: ToolRenderMode = "default";
const EDIT_COLLAPSED_DIFF_LINES = 12;
const WRITE_COLLAPSED_DIFF_LINES = 12;
const FAILURE_PREVIEW_LINES = 5;
const RUNNING_TAIL_LINES = 2;

const toolCache = new Map<string, BuiltInTools>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

function getBuiltInTools(cwd: string): BuiltInTools {
	const cached = toolCache.get(cwd);
	if (cached) return cached;
	const tools = createBuiltInTools(cwd);
	toolCache.set(cwd, tools);
	return tools;
}

function getTemplateTool<Name extends ToolKind>(name: Name): BuiltInTools[Name] {
	return getBuiltInTools(process.cwd())[name];
}

function readMode(): ToolRenderMode {
	if (!existsSync(CONFIG_PATH)) return COMPACT_MODE;
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ConfigFile;
		return parsed.mode === DEFAULT_MODE ? DEFAULT_MODE : COMPACT_MODE;
	} catch {
		return COMPACT_MODE;
	}
}

function writeMode(mode: ToolRenderMode): void {
	writeFileSync(CONFIG_PATH, `${JSON.stringify({ mode }, null, 2)}\n`, "utf8");
}

// ─── arguments ────────────────────────────────────────────────────────────────

function shortenPath(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

function normalizePathForLink(path: string): string {
	if (path.startsWith("file://")) return fileURLToPath(path);
	const home = homedir();
	if (path === "~") return home;
	if (path.startsWith("~/")) return join(home, path.slice(2));
	return path;
}

function fileHref(rawPath: string, cwd: string): string {
	const normalizedPath = normalizePathForLink(rawPath);
	const normalizedCwd = normalizePathForLink(cwd);
	return pathToFileURL(isAbsolute(normalizedPath) ? resolvePath(normalizedPath) : resolvePath(normalizedCwd, normalizedPath)).href;
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

/** A path as target parts: the directory quiet, the file name bright, both linked to the file. */
function pathTarget(value: unknown, cwd: string): TargetPart[] {
	if (value === undefined || value === null) return [{ text: "…", role: "secondary" }];
	if (typeof value !== "string") return [{ text: "[invalid arg]", role: "invalid" }];
	const shown = shortenPath(value);
	const href = fileHref(value, cwd);
	const slash = shown.lastIndexOf("/", shown.length - 2);
	if (slash < 0) return [{ text: shown, role: "primary", href }];
	return [
		{ text: shown.slice(0, slash + 1), role: "secondary", href, elidable: true },
		{ text: shown.slice(slash + 1), role: "primary", href },
	];
}

function readRange(args: Record<string, unknown>): string {
	const offset = numberArg(args.offset);
	const limit = numberArg(args.limit);
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
}

function targetFor(kind: ToolKind, args: Record<string, unknown>, cwd: string): TargetPart[] {
	switch (kind) {
		case "read": {
			const range = readRange(args);
			return [...pathTarget(args.file_path ?? args.path, cwd), ...(range ? [{ text: range, role: "secondary" as const }] : [])];
		}
		case "edit":
		case "write":
			return pathTarget(args.file_path ?? args.path, cwd);
		case "ls":
			return pathTarget(args.path ?? ".", cwd);
		case "bash": {
			const command = (stringArg(args.command) ?? "…").replace(/\s*\n\s*/g, " ⏎ ");
			const timeout = numberArg(args.timeout);
			return [
				{ text: "$ ", role: "secondary" },
				{ text: command, role: "primary" },
				...(timeout === undefined ? [] : [{ text: `  timeout ${timeout}s`, role: "secondary" as const }]),
			];
		}
		case "grep":
		case "find": {
			const flags = [stringArg(args.glob), args.ignoreCase === true ? "-i" : undefined, args.literal === true ? "literal" : undefined].filter(Boolean);
			return [
				{ text: stringArg(args.pattern) ?? "…", role: "primary" },
				{ text: `  in ${shortenPath(stringArg(args.path) ?? ".")}`, role: "secondary" },
				...(flags.length ? [{ text: `  ${flags.join(" ")}`, role: "secondary" as const }] : []),
			];
		}
	}
}

// ─── results ──────────────────────────────────────────────────────────────────

function getText(result: Pick<ToolResult, "content">): string {
	return cellLines(
		result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("\n"),
	);
}

function nonEmptyLines(text: string): string[] {
	if (!text || text === "(no output)") return [];
	return text.split("\n").filter((line) => line.trim().length > 0);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function countSearchResults(toolName: "grep" | "find" | "ls", text: string): number {
	const trimmed = text.trim();
	if (toolName === "grep" && trimmed === "No matches found") return 0;
	if (toolName === "find" && trimmed === "No files found matching pattern") return 0;
	if (toolName === "ls" && trimmed === "(empty directory)") return 0;
	return nonEmptyLines(text).length;
}

function searchResultLabel(toolName: "grep" | "find" | "ls", count: number): string {
	if (toolName === "grep") return plural(count, "match", "matches");
	if (toolName === "find") return plural(count, "file");
	return plural(count, "entry", "entries");
}

function hasImage(result: ToolResult): boolean {
	return result.content.some((part) => part.type === "image");
}

function hasTruncation(details: unknown): boolean {
	return typeof details === "object" && details !== null && "truncation" in details && Boolean((details as { truncation?: unknown }).truncation);
}

/**
 * pi's status line, which it appends last to a bash result (after a blank line when there is output).
 * Anchored to the end so a command that prints the same words itself can't be mistaken for it.
 */
const BASH_TRAILER = /(?:^|\n\n)Command (exited with code (\d+)|timed out|aborted)[^\n]*\n?$/;

function bashFailure(output: string): MetaPart {
	const status = output.match(BASH_TRAILER);
	if (status?.[2]) return { text: `exit ${status[2]}`, role: "error" };
	if (status?.[1] === "timed out") return { text: "timed out", role: "error" };
	if (status?.[1] === "aborted") return { text: "aborted", role: "error" };
	return { text: "failed", role: "error" };
}

function markFailed(head: RowHead, message: string): void {
	head.outcome = "error";
	head.meta = [{ text: "failed", role: "error" }];
	head.detail = [message];
	head.detailTone = "error";
}

/** The full output under an expanded row. A trailing newline ends the last line rather than adding a blank one. */
function outputBlock(text: string, theme: ThemeLike): Component {
	const color = tones(theme).dim;
	return new Text(text.replace(/\r?\n$/, "").split("\n").map((line) => `   ${paint(theme, line, color)}`).join("\n"), 0, 0);
}

function buildWriteDiffLines(content: string): string[] {
	if (!content) return [];
	const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	const width = String(lines.length).length;
	return lines.map((line, index) => `+${String(index + 1).padStart(width)} ${line}`);
}

/** pi's expand key as plain text, so every place that shows the hint can paint it in its own tone. */
function expandHint(): string {
	return `${keyText("app.tools.expand")} to expand`;
}

function moreLinesHint(hidden: number): string | undefined {
	return hidden > 0 ? `… ${plural(hidden, "more line")} (${expandHint()})` : undefined;
}

/** A diff under its row: changes paired across every line, then cut to the collapsed cap. */
function diffBlock(lines: string[], expanded: boolean, cap: number, theme: ThemeLike): Component {
	const shown = expanded ? lines.length : Math.min(cap, lines.length);
	return new GraphiteDiff(lines, shown, moreLinesHint(lines.length - shown), theme);
}

const emptyComponent: Component = { render: () => [], invalidate() {} };

// ─── rows ─────────────────────────────────────────────────────────────────────

/**
 * The component a tool row's call slot returns. It draws at render time from the row's latest head,
 * so fades and shimmer advance on every frame, and it asks the run registry whether to draw itself,
 * its whole exploratory run, or nothing.
 */
class RowView implements Component {
	theme: ThemeLike | undefined;
	private renders = 0;

	constructor(
		private readonly toolCallId: string,
		private readonly state: RowState,
		private readonly shared: Shared,
	) {}

	render(width: number): string[] {
		const head = this.state.head;
		const theme = this.theme;
		if (!head || !theme) return [];
		const now = clock.now();
		const runs = this.shared.runs;
		this.renders += 1;
		if (!runs.owns(this.toolCallId, this.state)) {
			// pi's TUI draws a row on every frame, so a second render proves this state is live, and it
			// takes the tool call over (from nobody, or from the state of a chat pi has since rebuilt).
			// Until then the result slot draws the row (see OneShotAware): a one-shot render like
			// /export's draws the call before the result exists, so the call can't know how it ended.
			if (this.renders < 2) return [];
			runs.claim(this.toolCallId, this.state);
		}
		const role = runs.role(this.toolCallId);
		if (role.kind === "follower") return [];
		if (role.kind === "solo") return renderRow(head, theme, width, now);
		if (role.complete && role.members.every((member) => member.outcome === "success")) {
			return [renderFoldedRun(role.members, theme, width, now, expandHint())];
		}
		const column = runColumn(role.members);
		return role.members.flatMap((member) => renderRow(member, theme, width, now, column));
	}

	/**
	 * A click on a packed or folded run opens it into ordinary rows, each then expandable on its own.
	 * pi would otherwise expand only this first row, whichever line was clicked, since one component
	 * draws the whole run and an extension can't toggle another row's expansion.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (this.shared.runs.role(this.toolCallId).kind !== "leader") return undefined;
		this.shared.runs.unpack(this.toolCallId);
		return { handled: true };
	}

	invalidate(): void {}
}

/**
 * Wraps a row's result component. Once the row's state owns its tool call (a live row from its second
 * frame on), it draws the result as is, under the call slot's head line. Before that it draws the
 * settled head line itself, so a one-shot render (/export, which draws the call before the result)
 * still shows how the row ended, and a row's first frame matches the frames after it.
 */
class OneShotAware implements Component {
	constructor(
		private readonly inner: Component,
		private readonly context: RenderContext,
		private readonly shared: Shared,
	) {}

	render(width: number): string[] {
		const { state, toolCallId } = this.context;
		const theme = state.view?.theme;
		if (this.shared.runs.owns(toolCallId, state) || !state.head || !theme) return this.inner.render(width);
		return [...renderRow(state.head, theme, width, clock.now()), ...this.inner.render(width)];
	}

	invalidate(): void {
		this.inner.invalidate();
	}
}

/** Start a fresh head for this render pass, keeping timings from the tool events. */
function beginRow(kind: ToolKind, args: unknown, theme: ThemeLike, context: RenderContext, shared: Shared): RowView {
	const state = context.state;
	const execution = shared.executions.get(context.toolCallId);
	// An ended execution whose result this row never received stays quiet rather than running.
	const running = execution !== undefined && execution.endedAt === undefined;
	const argRecord = (args ?? {}) as Record<string, unknown>;
	const target = targetFor(kind, argRecord, context.cwd);
	const head: RowHead = {
		kind,
		outcome: running ? "running" : "pending",
		target,
		meta: [],
		startedAt: running ? execution.startedAt : undefined,
		endedAt: undefined,
		detail: [],
		detailTone: "output",
		expanded: context.expanded,
		standalone: false,
		fullTarget: kind === "bash" ? `$ ${stringArg(argRecord.command) ?? "…"}` : target.map((part) => part.text).join(""),
	};
	state.head = head;
	state.view ??= new RowView(context.toolCallId, state, shared);
	state.view.theme = theme;
	animate(context, head, shared);
	return state.view;
}

/** The head `beginRow` started this pass; pi always renders the call before the result. */
function currentHead(context: RenderContext): RowHead {
	const head = context.state.head;
	if (!head) throw new Error(`tool-activity-renderer: result rendered before call for ${context.toolCallId}`);
	return head;
}

/** Settle the head for a final result: outcome, end time, and whether the result view is expanded. */
function settle(context: RenderContext, shared: Shared, expanded: boolean): RowHead {
	const head = currentHead(context);
	const execution = shared.executions.get(context.toolCallId);
	if (execution && execution.endedAt === undefined) execution.endedAt = clock.now();
	head.outcome = context.isError ? "error" : "success";
	head.startedAt = execution?.startedAt;
	head.endedAt = execution?.endedAt;
	head.expanded = expanded;
	animate(context, head, shared);
	return head;
}

/**
 * Keep redrawing a row while its tool runs or it recedes; stop the moment it settles. "Runs" is read
 * from the execution record, not the row: pi can drop a running row's component and give the result
 * to a rebuilt one, and the dropped row must not keep redrawing (and re-reporting) forever.
 */
function animate(context: RenderContext, head: RowHead, shared: Shared): void {
	const state = context.state;
	const needsFrames = () => {
		const latest = state.head ?? head;
		const running = isLive(latest.outcome) && shared.executions.get(context.toolCallId)?.endedAt === undefined;
		return (running && latest.startedAt !== undefined) || isFading(latest, clock.now());
	};
	if (!needsFrames()) {
		if (state.timer) clearInterval(state.timer);
		state.timer = undefined;
		return;
	}
	if (state.timer) return;
	state.timer = setInterval(() => {
		if (needsFrames()) {
			context.invalidate();
			return;
		}
		clearInterval(state.timer);
		state.timer = undefined;
	}, FRAME_MS);
	// A redraw timer must never be what keeps a process alive.
	state.timer.unref?.();
}

type RenderCall = NonNullable<AnyToolDefinition["renderCall"]>;
type RenderResult = NonNullable<AnyToolDefinition["renderResult"]>;

/** How one tool fills in its row. The registration settles the head before `done`/`failed` run. */
interface ResultHandlers {
	/** A streaming update while the tool runs. */
	partial?(result: ToolResult, head: RowHead): void;
	/** The final, successful result: set the meta, return what goes under the row. */
	done(result: ToolResult, head: RowHead, expanded: boolean, theme: ThemeLike, context: RenderContext): Component;
	/** The final, failed result. Defaults to the first output line as the error detail. */
	failed?(result: ToolResult, head: RowHead, expanded: boolean, theme: ThemeLike): Component;
}

function registerGraphiteTool(pi: ExtensionAPI, kind: ToolKind, shared: Shared, handlers: ResultHandlers): void {
	const template = getTemplateTool(kind) as AnyToolDefinition;
	const renderCall: RenderCall = (args, theme, context) => beginRow(kind, args, theme, context, shared);
	const result: RenderResult = (toolResult, options, theme, context) => new OneShotAware(resultBody(toolResult, options, theme, context), context, shared);
	const resultBody: RenderResult = (toolResult, { expanded, isPartial }, theme, context) => {
		const typed = toolResult as ToolResult;
		if (isPartial) {
			handlers.partial?.(typed, currentHead(context));
			return emptyComponent;
		}
		const head = settle(context, shared, expanded);
		if (!context.isError) return handlers.done(typed, head, expanded, theme, context);
		if (handlers.failed) return handlers.failed(typed, head, expanded, theme);
		markFailed(head, nonEmptyLines(getText(typed))[0] ?? `${kind} failed`);
		return emptyComponent;
	};
	pi.registerTool({
		...template,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = getBuiltInTools(ctx.cwd)[kind] as AnyToolDefinition;
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall,
		renderResult: result,
	} as AnyToolDefinition);
}

function registerGraphiteTools(pi: ExtensionAPI, shared: Shared): void {
	registerGraphiteTool(pi, "read", shared, {
		done(result, head, expanded, theme) {
			const text = getText(result);
			if (hasImage(result)) {
				head.meta = [{ text: "image", role: "success" }];
				// pi draws the image below this row's own component; only a row of its own keeps them together.
				head.standalone = true;
				return emptyComponent;
			}
			head.meta = [{ text: plural(nonEmptyLines(text).length, "line"), role: "result" }];
			if (hasTruncation(result.details)) head.meta.push({ text: "⚠ truncated", role: "warning" });
			return expanded && text ? outputBlock(text, theme) : emptyComponent;
		},
	});

	const bashBody = (result: ToolResult) => getText(result).replace(BASH_TRAILER, "");
	const bashOutput = (result: ToolResult, expanded: boolean, theme: ThemeLike) => {
		const output = getText(result);
		return expanded && output.trim() ? outputBlock(output, theme) : emptyComponent;
	};
	registerGraphiteTool(pi, "bash", shared, {
		partial(result, head) {
			head.detail = nonEmptyLines(bashBody(result)).slice(-RUNNING_TAIL_LINES);
		},
		done(result, head, expanded, theme) {
			const lineCount = nonEmptyLines(bashBody(result)).length;
			head.meta = [{ text: lineCount === 0 ? "no output" : plural(lineCount, "line"), role: "result" }];
			return bashOutput(result, expanded, theme);
		},
		failed(result, head, expanded, theme) {
			head.meta = [bashFailure(getText(result))];
			if (!expanded) head.detail = nonEmptyLines(bashBody(result)).slice(-FAILURE_PREVIEW_LINES);
			return bashOutput(result, expanded, theme);
		},
	});

	registerGraphiteTool(pi, "edit", shared, {
		done(result, head, expanded, theme) {
			const typed = result as AgentToolResult<EditToolDetails | undefined>;
			const diff = typed.details?.diff;
			if (!diff) {
				head.meta = [{ text: "applied", role: "result" }];
				return emptyComponent;
			}
			const diffLines = diff.split("\n").filter((line) => line.length > 0);
			head.meta = [
				{ text: `+${diffLines.filter((line) => line.startsWith("+")).length}`, role: "added" },
				{ text: `−${diffLines.filter((line) => line.startsWith("-")).length}`, role: "removed" },
			];
			return diffBlock(diffLines, expanded, EDIT_COLLAPSED_DIFF_LINES, theme);
		},
	});

	registerGraphiteTool(pi, "write", shared, {
		done(_result, head, expanded, theme, context) {
			const diffLines = buildWriteDiffLines(stringArg((context.args as Record<string, unknown>).content) ?? "");
			head.meta = [{ text: plural(diffLines.length, "line"), role: "result" }];
			return diffBlock(diffLines, expanded, WRITE_COLLAPSED_DIFF_LINES, theme);
		},
	});

	for (const kind of ["grep", "find", "ls"] as const) {
		registerGraphiteTool(pi, kind, shared, {
			done(result, head, expanded, theme) {
				const output = getText(result);
				head.meta = [{ text: searchResultLabel(kind, countSearchResults(kind, output)), role: "result" }];
				if (hasTruncation(result.details)) head.meta.push({ text: "⚠ truncated", role: "warning" });
				return expanded && output.trim() ? outputBlock(output, theme) : emptyComponent;
			},
		});
	}
}

function registerDefaultTool(pi: ExtensionAPI, name: ToolKind): void {
	const template = getTemplateTool(name) as AnyToolDefinition;
	const { execute: _execute, renderCall: _renderCall, renderResult: _renderResult, renderShell: _renderShell, ...metadata } = template;
	pi.registerTool({
		...metadata,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = getBuiltInTools(ctx.cwd)[name] as AnyToolDefinition;
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	} as AnyToolDefinition);
}

/** Track execution spans and the exploratory runs of each assistant message, live and on resume. */
function trackActivity(pi: ExtensionAPI, shared: Shared): void {
	pi.on("tool_execution_start", (event) => {
		shared.executions.set(event.toolCallId, { startedAt: clock.now() });
	});
	pi.on("tool_execution_end", (event) => {
		const execution = shared.executions.get(event.toolCallId);
		if (execution && execution.endedAt === undefined) execution.endedAt = clock.now();
	});
	pi.on("message_update", (event) => shared.runs.ingest(event.message));
	pi.on("message_end", (event) => shared.runs.ingest(event.message));
	const ingestBranch = (_event: unknown, ctx: { sessionManager: { getBranch(): unknown[] } }) => {
		shared.runs.clearRuns();
		shared.executions.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "message") shared.runs.ingest((entry as { message?: unknown }).message);
		}
	};
	pi.on("session_start", ingestBranch);
	pi.on("session_tree", ingestBranch);
}

export default function toolActivityRenderer(pi: ExtensionAPI): void {
	let mode = readMode();
	let overridesRegistered = false;
	const shared: Shared = { runs: new ExploreRuns(), executions: new Map() };

	function applyMode(nextMode: ToolRenderMode, persist: boolean): void {
		mode = nextMode;
		if (persist) writeMode(nextMode);
		if (nextMode === COMPACT_MODE) {
			registerGraphiteTools(pi, shared);
			overridesRegistered = true;
			return;
		}
		if (overridesRegistered) for (const name of TOOL_KINDS) registerDefaultTool(pi, name);
	}

	applyMode(mode, false);
	trackActivity(pi, shared);
	registerWorkingLine(pi);

	pi.registerCommand("tool-render", {
		description: "Switch built-in tool rendering: /tool-render compact|default",
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!requested) {
				ctx.ui.notify(`Tool renderer: ${mode}. Usage: /tool-render compact|default`, "info");
				return;
			}
			if (requested !== COMPACT_MODE && requested !== DEFAULT_MODE) {
				ctx.ui.notify(`Unknown tool renderer mode: ${requested}. Use compact or default.`, "warning");
				return;
			}
			applyMode(requested, true);
			ctx.ui.notify(`Tool renderer: ${requested}`, "info");
		},
	});
}

