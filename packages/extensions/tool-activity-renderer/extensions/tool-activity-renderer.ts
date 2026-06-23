import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, EditToolDetails, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	getAgentDir,
	keyHint,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";

type ToolRenderMode = "compact" | "default";
type BuiltInToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
type BuiltInTools = ReturnType<typeof createBuiltInTools>;
type BuiltInTool = BuiltInTools[BuiltInToolName];
type ToolResult = AgentToolResult<unknown>;

type RenderContext = {
	args: unknown;
	state: RowState;
	lastComponent?: unknown;
	executionStarted: boolean;
	isError: boolean;
	invalidate?: () => void;
};

type GlyphState = "muted" | "accent" | "running" | "success" | "error" | "warning" | "mdHeading" | "toolTitle";

interface ConfigFile {
	mode?: unknown;
}

interface RowState {
	call?: Text;
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
	glyphState?: GlyphState;
}

const CONFIG_PATH = join(getAgentDir(), "tool-activity-renderer.json");
const COMPACT_MODE: ToolRenderMode = "compact";
const DEFAULT_MODE: ToolRenderMode = "default";
const EDIT_COLLAPSED_DIFF_LINES = 12;
const WRITE_COLLAPSED_DIFF_LINES = 12;
const FAILURE_PREVIEW_LINES = 5;
const COLLAPSED_COMMAND_CHARS = 72;
const COLLAPSED_PATTERN_CHARS = 72;
const COLLAPSED_PATH_CHARS = 80;
const TOOL_NAMES: BuiltInToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];

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

function getTemplateTool(name: BuiltInToolName): BuiltInTool {
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

function shortenPath(path: string | undefined): string {
	if (!path) return "...";
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function getText(result: Pick<ToolResult, "content">): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function nonEmptyLines(text: string): string[] {
	if (!text || text === "(no output)") return [];
	return text.split("\n").filter((line) => line.trim().length > 0);
}

function countLines(text: string): number {
	return nonEmptyLines(text).length;
}

function countSearchResults(toolName: "grep" | "find" | "ls", text: string): number {
	const trimmed = text.trim();
	if (toolName === "grep" && trimmed === "No matches found") return 0;
	if (toolName === "find" && trimmed === "No files found matching pattern") return 0;
	if (toolName === "ls" && trimmed === "(empty directory)") return 0;
	return countLines(text);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function searchResultLabel(toolName: "grep" | "find" | "ls", count: number): string {
	if (toolName === "grep") return plural(count, "match", "matches");
	if (toolName === "find") return plural(count, "file");
	return plural(count, "entry", "entries");
}

function formatDuration(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms)) return undefined;
	return `${(ms / 1000).toFixed(1)}s`;
}

function truncateMiddle(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	if (maxLength <= 3) return text.slice(0, maxLength);
	return `${text.slice(0, maxLength - 3)}...`;
}

function collapsedText(text: string, expanded: boolean, maxLength: number): string {
	return expanded ? text : truncateMiddle(text, maxLength);
}

function firstMeaningfulLine(text: string): string {
	return nonEmptyLines(text)[0] ?? text.trim().split("\n")[0] ?? "";
}

function lastMeaningfulLines(text: string, limit: number): string[] {
	return nonEmptyLines(text).slice(-limit);
}

function detailPrefix(theme: ThemeLike): string {
	return theme.fg("dim", "   │ ");
}

function indentLines(lines: string[], theme: ThemeLike): string {
	return lines.map((line) => `${detailPrefix(theme)}${theme.fg("dim", line)}`).join("\n");
}

function outputBlock(text: string, theme: ThemeLike): string {
	return text.split("\n").map((line) => `${detailPrefix(theme)}${theme.fg("toolOutput", line)}`).join("\n");
}

interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

function formatFileChangeHeader(action: "Create" | "Update", path: string | undefined, theme: ThemeLike, state: GlyphState, expanded: boolean): string {
	const displayPath = collapsedText(shortenPath(path), expanded, COLLAPSED_PATH_CHARS);
	const nameColor = state === "error" ? "error" : state === "success" ? "success" : action === "Create" ? "warning" : "mdHeading";
	return `${toolGlyph(theme, state)} ${theme.fg(nameColor, theme.bold(action))}${theme.fg("text", "(")}${theme.fg("accent", displayPath)}${theme.fg("text", ")")}`;
}

function formatEditHeader(path: string | undefined, theme: ThemeLike, state: GlyphState, expanded: boolean): string {
	return formatFileChangeHeader("Update", path, theme, state, expanded);
}

function formatWriteHeader(path: string | undefined, theme: ThemeLike, state: GlyphState, expanded: boolean): string {
	return formatFileChangeHeader("Create", path, theme, state, expanded);
}

function parseDiffLine(line: string): { prefix: string; lineNumber: string; content: string } | undefined {
	const match = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
	if (!match) return undefined;
	return { prefix: match[1] ?? " ", lineNumber: match[2] ?? "", content: match[3] ?? "" };
}

class ClaudeStyleDiff extends Container {
	constructor(
		private readonly summary: string,
		private readonly diffLines: string[],
		private readonly hiddenCount: number,
		private readonly expanded: boolean,
		private readonly theme: ThemeLike,
	) {
		super();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 5);
		const detailLine = (text: string) => toolDetail(this.theme, truncateToWidth(text, contentWidth));
		const lines = [detailLine(this.summary)];
		for (const rawLine of this.diffLines) {
			const parsed = parseDiffLine(rawLine);
			if (!parsed) {
				lines.push(`${detailPrefix(this.theme)}${this.theme.fg("toolDiffContext", truncateToWidth(rawLine, contentWidth))}`);
				continue;
			}

			const gutter = `${parsed.lineNumber.padStart(4)} ${parsed.prefix}`;
			const content = truncateToWidth(parsed.content, Math.max(1, contentWidth - gutter.length - 1));
			const color = parsed.prefix === "+" ? "toolDiffAdded" : parsed.prefix === "-" ? "toolDiffRemoved" : "toolDiffContext";
			const rendered = `${this.theme.fg(color, gutter)} ${this.theme.fg(color, content)}`;

			if (parsed.prefix === "+") {
				lines.push(`${detailPrefix(this.theme)}${this.theme.bg("toolSuccessBg", rendered)}`);
			} else if (parsed.prefix === "-") {
				lines.push(`${detailPrefix(this.theme)}${this.theme.bg("toolErrorBg", rendered)}`);
			} else {
				lines.push(`${detailPrefix(this.theme)}${rendered}`);
			}
		}
		if (this.hiddenCount > 0 && !this.expanded) {
			lines.push(detailLine(`... ${plural(this.hiddenCount, "more diff line")} (${keyHint("app.tools.expand", "to expand")})`));
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	invalidate(): void {}
}

function toolGlyph(theme: ThemeLike, state: GlyphState): string {
	if (state === "running") {
		const frames = ["◐", "◓", "◑", "◒"];
		const frame = frames[Math.floor(Date.now() / 250) % frames.length] ?? "◌";
		return theme.fg("warning", frame);
	}
	if (state === "success") return theme.fg("success", "●");
	if (state === "error") return theme.fg("error", "✕");
	return theme.fg(state, "●");
}

function toolName(theme: ThemeLike, color: string, name: string): string {
	return theme.fg(color, theme.bold(name));
}

function toolMeta(theme: ThemeLike, text: string): string {
	return theme.fg("dim", text);
}

function toolDetail(theme: ThemeLike, text: string): string {
	return `${detailPrefix(theme)}${theme.fg("muted", text)}`;
}

function getRowState(context: RenderContext): RowState {
	return context.state;
}

function getStoredCallText(context: Pick<RenderContext, "state">): Text {
	const state = context.state;
	if (state.call) return state.call;
	state.call = new Text("", 0, 0);
	return state.call;
}

function getCallText(context: RenderContext): Text {
	const state = getRowState(context);
	if (context.lastComponent instanceof Text) {
		state.call = context.lastComponent;
		return context.lastComponent;
	}
	return getStoredCallText(context);
}

function emptyText(): Text {
	return new Text("", 0, 0);
}

function emptyContainer(): Container {
	return new Container();
}

function setStarted(context: RenderContext): void {
	const state = getRowState(context);
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
	if (context.executionStarted && state.endedAt === undefined && state.interval === undefined && context.invalidate) {
		state.interval = setInterval(() => context.invalidate?.(), 250);
	}
}

function setEnded(context: RenderContext, isPartial: boolean): void {
	const state = getRowState(context);
	if (!isPartial && state.startedAt !== undefined && state.endedAt === undefined) {
		state.endedAt = Date.now();
	}
	if (!isPartial && state.interval !== undefined) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
}

function elapsedSuffix(context: RenderContext): string | undefined {
	const state = getRowState(context);
	if (state.startedAt === undefined) return undefined;
	return formatDuration((state.endedAt ?? Date.now()) - state.startedAt);
}

function currentGlyphState(context: RenderContext, pending: GlyphState): GlyphState {
	return context.state.glyphState ?? (context.executionStarted ? "running" : pending);
}

function settleGlyphState(context: RenderContext, isError: boolean): GlyphState {
	const next = isError ? "error" : "success";
	context.state.glyphState = next;
	return next;
}

function renderStatus(theme: ThemeLike, ok: boolean, label: string): string {
	return ok ? theme.fg("success", `✓ ${label}`) : theme.fg("error", `✗ ${label}`);
}

function getReadRange(args: Record<string, unknown>): string {
	const offset = numberArg(args.offset);
	const limit = numberArg(args.limit);
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	const end = limit === undefined ? undefined : start + limit - 1;
	return end === undefined ? `:${start}` : `:${start}-${end}`;
}

function formatReadCall(args: Record<string, unknown>, theme: ThemeLike, state: GlyphState = "muted", expanded = false): string {
	const path = collapsedText(shortenPath(stringArg(args.path)), expanded, COLLAPSED_PATH_CHARS);
	return `${toolGlyph(theme, state)} ${toolName(theme, state === "error" ? "error" : "muted", "read")} ${theme.fg("accent", path)}${theme.fg("warning", getReadRange(args))}`;
}

function formatBashCall(args: Record<string, unknown>, theme: ThemeLike, state: GlyphState = "running", expanded = false): string {
	const command = collapsedText(stringArg(args.command) ?? "...", expanded, COLLAPSED_COMMAND_CHARS);
	const timeout = numberArg(args.timeout);
	const timeoutSuffix = timeout === undefined ? "" : toolMeta(theme, ` (timeout ${timeout}s)`);
	const nameColor = state === "error" ? "error" : state === "success" ? "success" : "toolTitle";
	return `${toolGlyph(theme, state)} ${toolName(theme, nameColor, "bash")} ${theme.fg("accent", "$")} ${theme.fg("toolOutput", command)}${timeoutSuffix}`;
}

function formatPathCall(toolNameValue: BuiltInToolName, path: string | undefined, theme: ThemeLike, state?: GlyphState, expanded = false): string {
	const defaultColor = toolNameValue === "write" ? "warning" : toolNameValue === "edit" ? "mdHeading" : "muted";
	const glyphState = state ?? defaultColor;
	const nameColor = glyphState === "success" ? "success" : glyphState === "error" ? "error" : defaultColor;
	const displayPath = collapsedText(shortenPath(path), expanded, COLLAPSED_PATH_CHARS);
	return `${toolGlyph(theme, glyphState)} ${toolName(theme, nameColor, toolNameValue)} ${theme.fg("accent", displayPath)}`;
}

function formatGrepCall(args: Record<string, unknown>, theme: ThemeLike, state: GlyphState = "running", expanded = false): string {
	const pattern = collapsedText(stringArg(args.pattern) ?? "...", expanded, COLLAPSED_PATTERN_CHARS);
	const path = collapsedText(shortenPath(stringArg(args.path) ?? "."), expanded, COLLAPSED_PATH_CHARS);
	const glob = stringArg(args.glob);
	const ignoreCase = args.ignoreCase === true ? toolMeta(theme, " -i") : "";
	const literal = args.literal === true ? toolMeta(theme, " literal") : "";
	const globText = glob ? toolMeta(theme, ` (${collapsedText(glob, expanded, COLLAPSED_PATTERN_CHARS)})`) : "";
	const nameColor = state === "error" ? "error" : state === "success" ? "success" : "toolTitle";
	return `${toolGlyph(theme, state)} ${toolName(theme, nameColor, "grep")} ${theme.fg("accent", `/${pattern}/`)}${theme.fg("muted", ` in ${path}`)}${globText}${ignoreCase}${literal}`;
}

function formatFindCall(args: Record<string, unknown>, theme: ThemeLike, state: GlyphState = "running", expanded = false): string {
	const pattern = collapsedText(stringArg(args.pattern) ?? "...", expanded, COLLAPSED_PATTERN_CHARS);
	const path = collapsedText(shortenPath(stringArg(args.path) ?? "."), expanded, COLLAPSED_PATH_CHARS);
	const nameColor = state === "error" ? "error" : state === "success" ? "success" : "toolTitle";
	return `${toolGlyph(theme, state)} ${toolName(theme, nameColor, "find")} ${theme.fg("accent", pattern)}${theme.fg("muted", ` in ${path}`)}`;
}

function formatLsCall(args: Record<string, unknown>, theme: ThemeLike, state: GlyphState = "running", expanded = false): string {
	const nameColor = state === "error" ? "error" : state === "success" ? "success" : "muted";
	const path = collapsedText(shortenPath(stringArg(args.path) ?? "."), expanded, COLLAPSED_PATH_CHARS);
	return `${toolGlyph(theme, state)} ${toolName(theme, nameColor, "ls")} ${theme.fg("accent", path)}`;
}

function formatWriteCall(args: Record<string, unknown>, theme: ThemeLike, state?: GlyphState, expanded = false): string {
	return formatWriteHeader(stringArg(args.path), theme, state ?? "running", expanded);
}

function buildWriteDiffLines(content: string): string[] {
	if (!content) return [];
	const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	const width = String(lines.length).length;
	return lines.map((line, index) => `+${String(index + 1).padStart(width)} ${line}`);
}

function formatEditCall(args: Record<string, unknown>, theme: ThemeLike, state?: GlyphState, expanded = false): string {
	return formatEditHeader(stringArg(args.path), theme, state ?? "running", expanded);
}

function hasImage(result: ToolResult): boolean {
	return result.content.some((part) => part.type === "image");
}

function hasTruncation(details: unknown): boolean {
	return typeof details === "object" && details !== null && "truncation" in details && Boolean((details as { truncation?: unknown }).truncation);
}

function registerDefaultTool(pi: ExtensionAPI, name: BuiltInToolName): void {
	const template = getTemplateTool(name);
	const {
		execute: _execute,
		renderCall: _renderCall,
		renderResult: _renderResult,
		renderShell: _renderShell,
		...metadata
	} = template;

	pi.registerTool({
		...metadata,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = getBuiltInTools(ctx.cwd)[name];
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

function registerReadTool(pi: ExtensionAPI): void {
	const template = getTemplateTool("read");
	pi.registerTool({
		...template,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const rowContext = context as RenderContext;
			setStarted(rowContext);
			const call = getCallText(rowContext);
			call.setText(formatReadCall(args as Record<string, unknown>, theme, currentGlyphState(rowContext, "running"), context.expanded));
			return call;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const rowContext = context as RenderContext;
			setEnded(rowContext, isPartial);
			const typedResult = result as ToolResult;
			const args = context.args as Record<string, unknown>;
			const call = getStoredCallText(rowContext);
			const text = getText(typedResult);
			const abnormal = context.isError || hasImage(typedResult) || hasTruncation(typedResult.details);

			if (isPartial) {
				call.setText(`${formatReadCall(args, theme, currentGlyphState(rowContext, "running"), expanded)} ${theme.fg("muted", "…")}`);
				return emptyText();
			}

			if (context.isError) {
				const message = firstMeaningfulLine(text) || "read failed";
				call.setText(`${formatReadCall(args, theme, settleGlyphState(rowContext, true), expanded)} ${theme.fg("error", "failed")}`);
				return new Text(`${detailPrefix(theme)}${theme.fg("error", message)}`, 0, 0);
			}

			const successCall = formatReadCall(args, theme, settleGlyphState(rowContext, false), expanded);
			if (hasImage(typedResult)) {
				call.setText(`${successCall} ${theme.fg("success", "🖼 image")}`);
				return emptyText();
			}

			const lineCount = countLines(text);
			const warning = abnormal ? theme.fg("warning", " ⚠ truncated") : "";
			call.setText(`${successCall} ${renderStatus(theme, true, plural(lineCount, "line"))}${warning}`);

			if (!expanded) return emptyText();

			return text ? new Text(outputBlock(text, theme), 0, 0) : emptyText();
		},
	});
}

function registerBashTool(pi: ExtensionAPI): void {
	const template = getTemplateTool("bash");
	pi.registerTool({
		...template,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			setStarted(context as RenderContext);
			const rowContext = context as RenderContext;
			const call = getCallText(rowContext);
			const elapsed = elapsedSuffix(rowContext);
			const running = rowContext.executionStarted && !elapsed ? theme.fg("muted", " …") : elapsed ? theme.fg("dim", ` · ${elapsed}`) : "";
			call.setText(`${formatBashCall(args as Record<string, unknown>, theme, currentGlyphState(rowContext, "running"), context.expanded)}${running}`);
			return call;
		},
		renderResult(result, options, theme, context) {
			const rowContext = context as RenderContext;
			setEnded(rowContext, options.isPartial);
			const typedResult = result as ToolResult;
			const args = context.args as Record<string, unknown>;
			const output = getText(typedResult);
			const duration = elapsedSuffix(rowContext);
			const durationText = duration ? ` · ${duration}` : "";
			const outputLines = countLines(output.replace(/\n\nCommand (exited|timed out|aborted).*$/s, ""));
			const lineText = outputLines === 0 ? "no output" : plural(outputLines, "line");
			const statusLine = context.isError ? firstMeaningfulLine(output).match(/Command .*$/)?.[0] ?? "error" : lineText;
			const call = getCallText(rowContext);
			const settledState = settleGlyphState(rowContext, context.isError);
			call.setText(
				`${formatBashCall(args, theme, settledState, options.expanded)} ${renderStatus(theme, !context.isError, context.isError ? statusLine : lineText)}${theme.fg("dim", durationText)}`,
			);

			if (options.isPartial) {
				return emptyText();
			}

			if (options.expanded) {
				return output.trim() ? new Text(outputBlock(output, theme), 0, 0) : emptyText();
			}

			if (!context.isError) {
				return emptyText();
			}

			const previewSource = output.replace(/\n\nCommand .*$/s, "");
			const preview = lastMeaningfulLines(previewSource, FAILURE_PREVIEW_LINES);
			return preview.length > 0 ? new Text(indentLines(preview, theme), 0, 0) : emptyText();
		},
	});
}

function registerEditTool(pi: ExtensionAPI): void {
	const template = getTemplateTool("edit");
	pi.registerTool({
		...template,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const rowContext = context as RenderContext;
			setStarted(rowContext);
			const call = getCallText(rowContext);
			call.setText(formatEditCall(args as Record<string, unknown>, theme, currentGlyphState(rowContext, "running"), context.expanded));
			return call;
		},
		renderResult(result, options, theme, context) {
			const typedResult = result as AgentToolResult<EditToolDetails | undefined>;
			const args = context.args as Record<string, unknown>;
			const rowContext = context as RenderContext;
			setEnded(rowContext, options.isPartial);
			const call = getCallText(rowContext);

			if (options.isPartial) {
				call.setText(`${formatEditCall(args, theme, "running", options.expanded)} ${theme.fg("muted", "…")}`);
				return emptyText();
			}

			if (context.isError) {
				const message = firstMeaningfulLine(getText(typedResult as ToolResult)) || "edit failed";
				call.setText(`${formatEditCall(args, theme, settleGlyphState(rowContext, true), options.expanded)} ${theme.fg("error", "failed")}`);
				return new Text(`${detailPrefix(theme)}${theme.fg("error", message)}`, 0, 0);
			}

			const diff = typedResult.details?.diff;
			if (!diff) {
				call.setText(`${formatEditCall(args, theme, settleGlyphState(rowContext, false), options.expanded)} ${theme.fg("success", "applied")}`);
				return emptyText();
			}

			const diffLines = diff.split("\n").filter((line) => line.length > 0);
			const additions = diffLines.filter((line) => line.startsWith("+")).length;
			const removals = diffLines.filter((line) => line.startsWith("-")).length;
			const visibleDiffLines = options.expanded ? diffLines : diffLines.slice(0, EDIT_COLLAPSED_DIFF_LINES);
			const hiddenCount = diffLines.length - visibleDiffLines.length;
			const summary = `${additions === 0 ? "Added 0 lines" : `Added ${plural(additions, "line")}`}, ${removals === 0 ? "removed 0 lines" : `removed ${plural(removals, "line")}`}`;
			call.setText(formatEditCall(args, theme, settleGlyphState(rowContext, false), options.expanded));
			return new ClaudeStyleDiff(summary, visibleDiffLines, hiddenCount, options.expanded, theme);
		},
	});
}

function registerWriteTool(pi: ExtensionAPI): void {
	const template = getTemplateTool("write");
	pi.registerTool({
		...template,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const rowContext = context as RenderContext;
			setStarted(rowContext);
			const call = getCallText(rowContext);
			call.setText(formatWriteCall(args as Record<string, unknown>, theme, currentGlyphState(rowContext, "running"), context.expanded));
			return call;
		},
		renderResult(result, options, theme, context) {
			const args = context.args as Record<string, unknown>;
			const rowContext = context as RenderContext;
			setEnded(rowContext, options.isPartial);
			if (options.isPartial) return emptyText();
			const call = getCallText(rowContext);
			const content = stringArg(args.content) ?? "";
			const diffLines = buildWriteDiffLines(content);
			const lineCount = diffLines.length;
			const output = getText(result as ToolResult);
			if (context.isError) {
				const message = firstMeaningfulLine(output) || "write failed";
				call.setText(`${formatWriteHeader(stringArg(args.path), theme, settleGlyphState(rowContext, true), options.expanded)} ${theme.fg("error", "failed")}`);
				return new Text(`${detailPrefix(theme)}${theme.fg("error", message)}`, 0, 0);
			}
			const visibleDiffLines = options.expanded ? diffLines : diffLines.slice(0, WRITE_COLLAPSED_DIFF_LINES);
			const hiddenCount = diffLines.length - visibleDiffLines.length;
			const summary = `Added ${plural(lineCount, "line")}, removed 0 lines`;
			call.setText(`${formatWriteHeader(stringArg(args.path), theme, settleGlyphState(rowContext, false), options.expanded)} ${renderStatus(theme, true, plural(lineCount, "line"))}`);
			return new ClaudeStyleDiff(summary, visibleDiffLines, hiddenCount, options.expanded, theme);
		},
	});
}

function registerSearchLikeTool(pi: ExtensionAPI, name: "grep" | "find" | "ls"): void {
	const template = getTemplateTool(name);
	pi.registerTool({
		...template,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd)[name].execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const rowContext = context as RenderContext;
			setStarted(rowContext);
			const call = getCallText(rowContext);
			const recordArgs = args as Record<string, unknown>;
			const state: GlyphState = currentGlyphState(rowContext, "running");
			const text = name === "grep" ? formatGrepCall(recordArgs, theme, state, context.expanded) : name === "find" ? formatFindCall(recordArgs, theme, state, context.expanded) : formatLsCall(recordArgs, theme, state, context.expanded);
			call.setText(text);
			return call;
		},
		renderResult(result, options, theme, context) {
			const typedResult = result as ToolResult;
			const recordArgs = context.args as Record<string, unknown>;
			const rowContext = context as RenderContext;
			setEnded(rowContext, options.isPartial);
			if (options.isPartial) return emptyText();
			const call = getCallText(rowContext);
			const resultState: GlyphState = settleGlyphState(rowContext, context.isError);
			const callText = name === "grep" ? formatGrepCall(recordArgs, theme, resultState, options.expanded) : name === "find" ? formatFindCall(recordArgs, theme, resultState, options.expanded) : formatLsCall(recordArgs, theme, resultState, options.expanded);
			const output = getText(typedResult);
			const count = countSearchResults(name, output);
			const truncated = hasTruncation(typedResult.details) ? theme.fg("warning", " ⚠ truncated") : "";

			if (context.isError) {
				const message = firstMeaningfulLine(output) || `${name} failed`;
				call.setText(`${callText} ${theme.fg("error", "failed")}`);
				return new Text(`${detailPrefix(theme)}${theme.fg("error", message)}`, 0, 0);
			}

			const countText = searchResultLabel(name, count);
			const status = count === 0 ? theme.fg("muted", countText) : renderStatus(theme, true, countText);
			call.setText(`${callText} ${status}${truncated}`);
			if (!options.expanded) return emptyText();

			return output.trim() ? new Text(outputBlock(output, theme), 0, 0) : emptyText();
		},
	});
}

function registerCompactTools(pi: ExtensionAPI): void {
	registerReadTool(pi);
	registerBashTool(pi);
	registerEditTool(pi);
	registerWriteTool(pi);
	registerSearchLikeTool(pi, "grep");
	registerSearchLikeTool(pi, "find");
	registerSearchLikeTool(pi, "ls");
}

function registerDefaultTools(pi: ExtensionAPI): void {
	for (const name of TOOL_NAMES) registerDefaultTool(pi, name);
}

export default function compactToolRenderer(pi: ExtensionAPI): void {
	let mode = readMode();
	let overridesRegistered = false;

	function applyMode(nextMode: ToolRenderMode, persist: boolean): void {
		mode = nextMode;
		if (persist) writeMode(nextMode);

		if (nextMode === COMPACT_MODE) {
			registerCompactTools(pi);
			overridesRegistered = true;
			return;
		}

		if (overridesRegistered) {
			registerDefaultTools(pi);
		}
	}

	applyMode(mode, false);

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
