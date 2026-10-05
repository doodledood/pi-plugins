/** Diffs: word emphasis, pairing, cuts, widths. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { mixColors, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { TOKENS, createHarness, Row, at, setHyperlinks, hex, strongSpans } from "./test-harness.ts";

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

test("the collapsed diff's expand hint is one quiet tone", () => {
	setHyperlinks(false);
	const diff = Array.from({ length: 15 }, (_, i) => `+ ${i + 1} line ${i + 1}`).join("\n");
	const hint = new Row(createHarness(), "edit", "e", { path: "a.ts" }).restore("ok", { details: { diff } }).render(100).at(-1) ?? "";
	assert.match(stripTerminalSequences(hint), /… 3 more lines \(ctrl\+o to expand\)/);
	assert.deepEqual([...new Set([...hint.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map((m) => m[1]))].length, 1);
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

test("CRLF write content still draws as an added diff", () => {
	setHyperlinks(false);
	const lines = new Row(createHarness(), "write", "w", { path: "a.txt", content: "a\r\nb\r\n" }).restore("ok").render(80);
	assert.deepEqual(lines.slice(1).map((l) => stripTerminalSequences(l).trim()), ["1 + a", "2 + b"]);
	assert.ok(lines[1]?.includes("\x1b[48;2;21;32;26m"));
});

test("edit meta counts additions and removals separately", () => {
	setHyperlinks(false);
	const h = createHarness();
	assert.match(new Row(h, "edit", "a1", { path: "a.ts" }).restore("ok", { details: { diff: "  1 keep\n- 2 a\n+ 2 b\n+ 3 c" } }).plain(100)[0] ?? "", /\+2 {2}−1$/);
	assert.match(new Row(h, "edit", "a2", { path: "a.ts" }).restore("ok", { details: { diff: "  1 keep\n+ 2 new\n+ 3 new\n+ 4 new" } }).plain(100)[0] ?? "", /\+3 {2}−0$/);
});

test("diff bands fill the row width", () => {
	setHyperlinks(false);
	const lines = new Row(createHarness(), "edit", "f", { path: "a.ts" }).restore("ok", { details: { diff: "- 1 a = 1\n+ 1 a = 2" } }).render(80);
	for (const line of lines.slice(1)) {
		assert.equal(visibleWidth(line), 80);
		assert.match(line, /\x1b\[48;2;\d+;\d+;\d+m {2,}/, "trailing cells carry the band");
	}
});

test("an emoji change that shares its low surrogate is not split either", () => {
	setHyperlinks(false);
	const raw = new Row(createHarness(), "edit", "s", { path: "a.ts" }).restore("ok", { details: { diff: "- 1 x \u{1F600} y\n+ 1 x \u{1F200} y" } }).render(80);
	const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
	for (const line of raw) assert.ok(!lone.test(line), JSON.stringify(line));
});
