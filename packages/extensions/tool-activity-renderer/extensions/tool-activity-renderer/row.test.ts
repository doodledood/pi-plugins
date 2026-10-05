/** Row anatomy: verbs, targets, paths, links, result column, failures, spacing. */
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { createHarness, Row, at, setHyperlinks, CASES, message } from "./test-harness.ts";

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

test("an expanded bash failure shows its output once, in the output block", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "bash", "x", { command: "npm test" }).restore("1 failing\n\nCommand exited with code 1", { isError: true }).expand();
	assert.equal(row.plain(80).filter((line) => line.includes("1 failing")).length, 1);
});

test("expand hints draw in one quiet tone, whatever styling pi's key hint carries", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["h1", "read"], ["h2", "read"]) });
	const h1 = new Row(harness, "read", "h1", { path: "a.ts" }).restore("x");
	new Row(harness, "read", "h2", { path: "b.ts" }).restore("y").render();
	const line = h1.render(100)[0] ?? "";
	assert.match(stripTerminalSequences(line), /2 files {3}ctrl\+o to expand/, "the hint names the expand key");
	// From the color that starts the key to the end of the words: one tone.
	const hint = line.slice(line.lastIndexOf("\x1b[38;2", line.indexOf("ctrl+o")), line.indexOf("to expand") + "to expand".length);
	const colors = new Set([...hint.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map((m) => m[1]));
	assert.equal(colors.size, 1, `one tone across the hint: ${JSON.stringify(hint)}`);
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

test("bash status comes from pi's final status line, not from output that repeats its words", () => {
	setHyperlinks(false);
	const h = createHarness();
	const echo = new Row(h, "bash", "e", { command: "x" }).restore("Command exited with code 2\n\nCommand exited with code 1", { isError: true }).plain(100);
	assert.match(echo[0] ?? "", /exit 1$/);
	const log = "build log\n\nCommand exited with code 2\nmore output\nlast error line\n\nCommand timed out after 5 seconds";
	const timed = new Row(h, "bash", "t", { command: "x" }).restore(log, { isError: true }).plain(100);
	assert.match(timed[0] ?? "", /timed out$/);
	assert.deepEqual(timed.slice(-2), ["   more output", "   last error line"]);
	const bare = new Row(h, "bash", "b", { command: "false" }).restore("Command exited with code 1", { isError: true }).plain(100);
	assert.deepEqual(bare.slice(1), [], "a bare status is not repeated as detail");
});

test("a single row puts its target two spaces after the verb, in either tense", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "bash", "sp", { command: "npm test" });
	at(0, () => row.start());
	assert.match(at(100, () => row.plain(80))[0] ?? "", /^ ● Running {2}\$ npm test/);
	at(200, () => row.finish("ok"));
	assert.match(at(300, () => row.plain(80))[0] ?? "", /^ ● Ran {2}\$ npm test/);
	row.stop();
});

test("an expanded row shows the whole argument when the head line had to shorten it", () => {
	setHyperlinks(false);
	const command = `node scripts/build.js --target production --out ${"x".repeat(80)} --verbose`;
	const row = new Row(createHarness(), "bash", "fa", { command }).restore("done");
	assert.ok(!row.plain(60)[0]?.includes("--verbose"), "collapsed, the head line elides the command");
	const expanded = row.expand().plain(60);
	assert.ok(expanded.every((line) => visibleWidth(line) <= 60));
	assert.ok(expanded.join("").replace(/\s+/g, "").includes(`$${command}`.replace(/\s+/g, "")), "expanded, the full command is shown");
});

test("an expanded multi-line command keeps its lines", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "bash", "ml", { command: "cd src\nnpm test -- --grep cart" }).restore("ok");
	const lines = row.expand().plain(100);
	assert.ok(lines.some((line) => line.trim() === "$ cd src"));
	assert.ok(lines.some((line) => line.trim() === "npm test -- --grep cart"));
});

test("a long grep pattern and a deep path are shown whole when expanded", () => {
	setHyperlinks(false);
	const pattern = `function\\s+${"veryLongIdentifier".repeat(5)}`;
	const grep = new Row(createHarness(), "grep", "gp", { pattern, path: "packages/app/src" }).restore("no matches");
	assert.ok(grep.expand().plain(60).join("").replace(/\s+/g, "").includes(pattern));
	const path = `packages/${"nested/".repeat(10)}deep.ts`;
	const read = new Row(createHarness(), "read", "rp", { path }).restore("x");
	assert.ok(read.expand().plain(60).join("").replace(/\s+/g, "").includes(path));
});

test("expanded output that ends with a newline adds no blank line under it", () => {
	setHyperlinks(false);
	const lines = new Row(createHarness(), "read", "nl", { path: "src/a.ts" }).restore("one\ntwo\n").expand().plain(80);
	assert.deepEqual(lines.slice(1).map((line) => line.trimEnd()), ["   one", "   two"]);
});
