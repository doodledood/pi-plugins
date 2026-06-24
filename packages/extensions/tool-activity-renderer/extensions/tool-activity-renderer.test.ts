import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setCapabilities } from "@earendil-works/pi-tui";

const agentDir = mkdtempSync(join(tmpdir(), "pi-tool-renderer-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: registerExtension } = await import("./tool-activity-renderer.ts");

type CapturedTool = {
	name: string;
	renderCall?: (args: Record<string, unknown>, theme: ThemeStub, context: RenderContextStub) => { render(width: number): string[] };
};

type ThemeStub = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
};

type RenderContextStub = {
	args: Record<string, unknown>;
	state: Record<string, unknown>;
	lastComponent: undefined;
	executionStarted: boolean;
	isError: boolean;
	argsComplete: boolean;
	isPartial: boolean;
	expanded: boolean;
	showImages: boolean;
	cwd: string;
	toolCallId: string;
	invalidate(): void;
};

const theme: ThemeStub = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
	bold: (text) => text,
};

function captureTools(): Map<string, CapturedTool> {
	const tools = new Map<string, CapturedTool>();
	registerExtension({
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
	} as unknown as ExtensionAPI);
	return tools;
}

function renderCall(toolName: "read" | "edit" | "write", args: Record<string, unknown>, cwd = "/workspace/project"): string {
	const tool = captureTools().get(toolName);
	assert.ok(tool?.renderCall, `${toolName} renderCall should be registered`);
	const context: RenderContextStub = {
		args,
		state: {},
		lastComponent: undefined,
		executionStarted: false,
		isError: false,
		argsComplete: false,
		isPartial: false,
		expanded: false,
		showImages: false,
		cwd,
		toolCallId: "test-tool-call",
		invalidate() {},
	};
	return tool.renderCall(args, theme, context).render(800).join("\n").trim();
}

function setHyperlinks(enabled: boolean): void {
	setCapabilities({ images: null, trueColor: true, hyperlinks: enabled });
}

test("read, Update, and Create preserve long file path suffixes without fixed ellipsis truncation", () => {
	setHyperlinks(false);
	const longPath = `/tmp/${Array.from({ length: 12 }, (_, index) => `very-long-segment-${index}`).join("/")}/final-file-name-with-important-suffix.ts`;

	for (const toolName of ["read", "edit", "write"] as const) {
		const rendered = renderCall(toolName, { path: longPath });
		assert.ok(rendered.includes("final-file-name-with-important-suffix.ts"), `${toolName} should preserve the suffix: ${rendered}`);
		assert.ok(!rendered.includes("..."), `${toolName} should not use fixed ellipsis truncation: ${rendered}`);
	}
});

test("read uses file_path render compatibility before path", () => {
	setHyperlinks(false);
	const rendered = renderCall("read", { file_path: "src/from-file-path.ts", path: "src/from-path.ts" });

	assert.ok(rendered.includes("src/from-file-path.ts"));
	assert.ok(!rendered.includes("src/from-path.ts"));
});

test("relative paths display as provided and hyperlink to cwd-relative file URLs", () => {
	setHyperlinks(true);
	const cwd = "/workspace/project";
	const rendered = renderCall("read", { path: "src/file.ts" }, cwd);
	const expectedHref = pathToFileURL(resolve(cwd, "src/file.ts")).href;

	assert.ok(rendered.includes("src/file.ts"));
	assert.ok(rendered.includes(`\u001B]8;;${expectedHref}\u001B\\`), rendered);
});

test("tilde paths hyperlink under the home directory", () => {
	setHyperlinks(true);
	const rendered = renderCall("read", { path: "~/notes.txt" });
	const expectedHref = pathToFileURL(join(homedir(), "notes.txt")).href;

	assert.ok(rendered.includes("~/notes.txt"));
	assert.ok(rendered.includes(`\u001B]8;;${expectedHref}\u001B\\`), rendered);
});

test("file URL paths hyperlink to the referenced file instead of cwd-relative text", () => {
	setHyperlinks(true);
	const fileUrl = pathToFileURL("/tmp/file-url-source.ts").href;
	const rendered = renderCall("read", { path: fileUrl }, "/workspace/project");

	assert.ok(rendered.includes(fileUrl));
	assert.ok(rendered.includes(`\u001B]8;;${fileUrl}\u001B\\`), rendered);
	assert.ok(!rendered.includes("/workspace/project/file:"), rendered);
});

test("invalid path arguments render as invalid args without hyperlink escape sequences", () => {
	setHyperlinks(true);
	const rendered = renderCall("read", { path: 123 });

	assert.ok(rendered.includes("[invalid arg]"));
	assert.ok(!rendered.includes("\u001B]8;;"));
});

test("disabled hyperlink capability returns plain styled path text", () => {
	setHyperlinks(false);
	const rendered = renderCall("read", { path: "src/plain.ts" });

	assert.ok(rendered.includes("src/plain.ts"));
	assert.ok(!rendered.includes("\u001B]8;;"));
});
