/** Temporal depth: recession, shimmer, durations, redraw timers, settled history. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { mock, test } from "node:test";
import { mixColors, parseColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { clock, formatDuration, TOKENS, createHarness, Row, at, setHyperlinks, fgAt, hex, message, recordingUi } from "./test-harness.ts";

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
		const softTone = hex(mixColors(parseColor(TOKENS.text!), parseColor(TOKENS.muted!), 0.35, "srgb"));
		assert.equal(fgAt(receded, "a.ts"), softTone, "file name settles at the soft tone");

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

test("work that finished in under a tenth of a second reads <0.1s, not 0.0s", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "read", "fast", { path: "a.ts" });
	at(0, () => row.start());
	at(40, () => row.finish("x"));
	assert.match(at(50, () => row.plain(80))[0] ?? "", /1 line  <0\.1s$/);
	row.stop();
});

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

test("durations round before choosing the unit", () => {
	assert.equal(formatDuration(59_940), "59.9s");
	assert.equal(formatDuration(59_960), "1m 00s");
	assert.equal(formatDuration(61_500), "1m 01s");
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

test("a landing row flashes its glyph at full text before it settles", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "read", "l", { path: "a.ts" });
	at(0, () => row.start());
	at(500, () => row.finish("x"));
	assert.equal(fgAt(at(600, () => row.render(80))[0] ?? "", "●"), hex(parseColor(TOKENS.text!)));
	assert.notEqual(fgAt(at(800, () => row.render(80))[0] ?? "", "●"), hex(parseColor(TOKENS.text!)));
	row.stop();
});

test("a settled row lands on the specified tones: directory dim, file name soft, result dim", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "read", "rs", { path: "src/lib/cart.js" });
	at(0, () => row.start());
	at(500, () => row.finish("one\ntwo"));
	const fresh = at(600, () => row.render(100))[0] ?? "";
	const settled = at(3_000, () => row.render(100))[0] ?? "";
	const soft = hex(mixColors(parseColor(TOKENS.text!), parseColor(TOKENS.muted!), 0.35, "srgb"));
	assert.equal(fgAt(fresh, "src/lib/"), hex(parseColor(TOKENS.muted!)), "the directory starts muted");
	assert.equal(fgAt(settled, "src/lib/"), hex(parseColor(TOKENS.dim!)), "the directory settles dim");
	assert.equal(fgAt(settled, "cart.js"), soft, "the file name settles soft");
	assert.equal(fgAt(fresh, "2 lines"), hex(parseColor(TOKENS.muted!)), "the result starts muted");
	assert.equal(fgAt(settled, "2 lines"), hex(parseColor(TOKENS.dim!)), "the result settles dim");
	row.stop();
});
