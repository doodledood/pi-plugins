/**
 * Frame cost: pi's fullscreen TUI redraws the whole transcript on every frame and keeps no lines
 * between frames, so a row that has stopped changing must reuse its own drawing. Without that, every
 * frame repaints every row since the last compaction, and a long session slows down.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { isStill } from "./row.ts";
import { at, CASES, createHarness, FRAME_MS, message, Row, setHyperlinks, theme, TOKENS } from "./test-harness.ts";

/** Settled rows covering every way a finished row draws: solo, packed, folded, expanded, failed, with a diff. */
function settledTranscript() {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["r1", "read"], ["g1", "grep"], ["b1", "bash"], ["r2", "read"], ["f1", "find"]) });
	const rows = [
		new Row(harness, "read", "r1", { path: "src/a.ts" }).restore("a\nb"),
		new Row(harness, "grep", "g1", { pattern: "needle", path: "src" }).restore("a.ts:1"),
		new Row(harness, "bash", "b1", { command: longCommand(3_000) }).restore("ok").expand(),
		new Row(harness, "read", "r2", { path: "src/b.ts" }).restore("x"),
		new Row(harness, "find", "f1", { pattern: "*.ts" }).restore("Command failed", { isError: true }),
		new Row(harness, "edit", "e1", { path: "src/c.ts" }).restore("ok", { details: { diff: "- 3 a = 1\n+ 3 a = 2" } }),
		new Row(harness, "bash", "b2", { command: "false" }).restore("boom\n\nCommand exited with code 1", { isError: true }),
	];
	for (const row of rows) row.render(100);
	return rows;
}

/** A multi-line command of about `size` characters, the shape of a heredoc an agent writes. */
function longCommand(size: number): string {
	const lines = ["cat > /tmp/script.mjs <<'EOF'"];
	for (let i = 0; lines.join("\n").length < size; i++) lines.push(`const value${i} = compute(${i}, "naïve — résumé", { depth: ${i % 7} });`);
	lines.push("EOF", "node /tmp/script.mjs");
	return lines.join("\n");
}

test("a settled row reuses its drawing on the next frame instead of painting again", () => {
	const rows = settledTranscript();
	const style = mock.method(theme, "style");
	try {
		for (const row of rows) {
			const first = row.slots().map((component) => component.render(100));
			style.mock.resetCalls();
			const second = row.slots().map((component) => component.render(100));
			assert.equal(style.mock.callCount(), 0, `${row.toolName} ${row.id} painted again on an unchanged frame`);
			for (const [index, lines] of second.entries()) {
				// An empty slot has nothing to reuse; every slot that draws lines hands back the same ones.
				if (lines.length > 0) assert.equal(lines, first[index], `${row.toolName} ${row.id} slot ${index} drew new lines`);
			}
		}
	} finally {
		style.mock.restore();
	}
});

test("a running row and a receding row still change from one frame to the next", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const running = new Row(harness, "bash", "live", { command: "sleep 5" });
	at(0, () => running.start().render(100));
	const runA = at(1_000, () => running.slots().map((c) => c.render(100)).flat());
	const runB = at(1_000 + FRAME_MS, () => running.slots().map((c) => c.render(100)).flat());
	assert.notDeepEqual(runA, runB, "the running row's shimmer and breathing advance each frame");

	const receding = new Row(harness, "read", "recede", { path: "src/a.ts" });
	at(0, () => receding.start());
	at(500, () => receding.finish("x").render(100));
	const recedeA = at(1_200, () => receding.slots().map((c) => c.render(100)).flat());
	const recedeB = at(1_200 + FRAME_MS, () => receding.slots().map((c) => c.render(100)).flat());
	assert.notDeepEqual(recedeA, recedeB, "the receding row keeps receding each frame");
	running.stop();
	receding.stop();
});

/** What a brand-new row with the same inputs draws: the drawing a reused one must equal. */
function freshDrawing(build: (harness: ReturnType<typeof createHarness>) => Row, width = 100): string[] {
	return build(createHarness()).render(width);
}

test("a reused drawing follows every input it reads", () => {
	setHyperlinks(false);
	const row = new Row(createHarness(), "bash", "b1", { command: longCommand(600) }).restore("ok");
	row.render(100);
	row.slots().forEach((c) => c.render(100));

	// Width.
	assert.deepEqual(row.paint(60), freshDrawing((h) => new Row(h, "bash", "b1", { command: longCommand(600) }).restore("ok"), 60));

	// Expanded state and outcome reach the row through pi's update, as on a click or a new result.
	row.expand().render(100);
	assert.deepEqual(row.paint(100), freshDrawing((h) => new Row(h, "bash", "b1", { command: longCommand(600) }).restore("ok").expand()));
	row.restore("x\n\nCommand exited with code 2", { isError: true }).render(100);
	assert.deepEqual(
		row.paint(100),
		freshDrawing((h) => new Row(h, "bash", "b1", { command: longCommand(600) }).restore("x\n\nCommand exited with code 2", { isError: true }).expand()),
	);

	// Hyperlink support, which targets read from pi-tui rather than from the head.
	const linked = new Row(createHarness(), "read", "r1", { path: "src/a.ts" }).restore("a");
	linked.render(100);
	try {
		setHyperlinks(true);
		const fresh = new Row(createHarness(), "read", "r1", { path: "src/a.ts" }).restore("a").render(100);
		assert.ok(fresh.join("").includes("\x1b]8;"), "the fresh drawing links its target");
		assert.deepEqual(linked.paint(100), fresh, "a reused drawing picks up hyperlink support");
	} finally {
		setHyperlinks(false);
	}

	// A theme switch: pi invalidates every component, then draws with the new colors.
	const original = TOKENS.muted;
	try {
		TOKENS.muted = "#a0a0a0";
		for (const component of row.slots()) component.invalidate?.();
		assert.deepEqual(row.paint(100), freshDrawing((h) => new Row(h, "bash", "b1", { command: longCommand(600) }).restore("x\n\nCommand exited with code 2", { isError: true }).expand()));
	} finally {
		TOKENS.muted = original!;
	}
});

test("a reused run drawing opens when clicked, and a receding row keeps the drawing it settles into", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["r1", "read"], ["g1", "grep"]) });
	const r1 = new Row(harness, "read", "r1", { path: "src/a.ts" }).restore("a");
	const g1 = new Row(harness, "grep", "g1", { pattern: "n", path: "src" }).restore("a.ts:1");
	for (let i = 0; i < 2; i++) for (const row of [r1, g1]) row.render(100);
	const call = r1.slots()[0]!;
	const folded = call.render(100);
	assert.equal(folded.length, 1, "the run folds into one line");
	assert.equal(call.render(100), folded, "the folded run is reused while nothing changes");
	r1.click();
	assert.notDeepEqual(call.render(100), folded, "a click opens the run on the next frame, with no update in between");

	const receding = new Row(harness, "bash", "recede", { command: "ls" });
	at(0, () => receding.start());
	at(100, () => receding.finish("x").render(100));
	const slot = receding.slots()[0]!;
	at(1_000, () => slot.render(100));
	const settled = at(10_000, () => slot.render(100));
	assert.equal(at(20_000, () => slot.render(100)), settled, "the settled drawing is reused");
	slot.invalidate?.();
	assert.deepEqual(at(20_000, () => slot.render(100)), settled, "and equals a fresh paint");
	receding.stop();
});

/**
 * Each slot drawn at `now`, then drawn again a minute later — reused, if the drawing was kept — and
 * compared with a forced fresh paint at that later instant. A drawing kept too early, while it still
 * moved, differs from the fresh one.
 */
function reusedAndFresh(row: Row, now: number, width = 100): { reused: string[][]; fresh: string[][] } {
	const slots = row.slots();
	at(now, () => slots.forEach((slot) => slot.render(width)));
	return at(now + 60_000, () => {
		const reused = slots.map((slot) => [...slot.render(width)]);
		slots.forEach((slot) => slot.invalidate?.());
		return { reused, fresh: slots.map((slot) => slot.render(width)) };
	});
}

test("every tool, in every state, reuses exactly the drawing a fresh paint makes", () => {
	for (const links of [false, true]) {
		setHyperlinks(links);
		for (const c of CASES) {
			const details = "details" in c ? c.details : undefined;
			const states: Array<[string, (row: Row) => Row, number]> = [
				["restored", (row) => row.restore(c.output, { details }), 50_000],
				["restored expanded", (row) => row.restore(c.output, { details }).expand(), 50_000],
				["failed", (row) => row.restore("bad\n\nCommand exited with code 3", { isError: true }), 50_000],
				["running", (row) => at(0, () => row.start()), 1_000],
				["landing", (row) => at(0, () => row.start()) && at(1_000, () => row.finish(c.output, { details })), 1_100],
				// Drawn at points through the recede, which ends 1.9 s after landing.
				...[1_200, 1_600, 1_850, 1_899].map((since): [string, (row: Row) => Row, number] => [
					`receding +${since}ms`,
					(row) => at(0, () => row.start()) && at(1_000, () => row.finish(c.output, { details })),
					1_000 + since,
				]),
				["settled", (row) => at(0, () => row.start()) && at(1_000, () => row.finish(c.output, { details })), 9_000],
			];
			for (const [state, arrange, now] of states) {
				const row = arrange(new Row(createHarness(), c.tool, `${c.tool}-${state}`, { ...c.args }));
				at(now, () => row.render(100));
				const { reused, fresh } = reusedAndFresh(row, now);
				assert.deepEqual(reused, fresh, `${c.tool} ${state} (hyperlinks ${links})`);
				row.stop();
			}
		}
	}
	setHyperlinks(false);
});

test("packed, folded and opened runs reuse exactly the drawing a fresh paint makes", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["r1", "read"], ["g1", "grep"], ["l1", "ls"]) });
	const rows = [
		new Row(harness, "read", "r1", { path: "src/a.ts" }).restore("a"),
		new Row(harness, "grep", "g1", { pattern: "n", path: "src" }).restore("Command failed", { isError: true }),
		new Row(harness, "ls", "l1", { path: "src" }).restore("a\nb"),
	];
	for (let i = 0; i < 2; i++) for (const row of rows) row.render(100);
	const packed = reusedAndFresh(rows[0]!, 50_000);
	assert.ok(packed.fresh[0]!.length >= 3, "a run with a failure packs its members");
	assert.deepEqual(packed.reused, packed.fresh, "packed");

	rows[1]!.restore("a.ts:1");
	for (const row of rows) row.render(100);
	const folded = reusedAndFresh(rows[0]!, 50_000);
	assert.equal(folded.fresh[0]!.length, 1, "an all-success run folds");
	assert.deepEqual(folded.reused, folded.fresh, "folded");

	rows[0]!.click();
	const opened = reusedAndFresh(rows[0]!, 50_000);
	assert.deepEqual(opened.reused, opened.fresh, "opened");
});

test("a row is still from the moment its recede ends, and never while it runs", () => {
	const landed = { outcome: "success" as const, startedAt: 0, endedAt: 1_000 };
	assert.equal(isStill(landed, 1_000 + 1_899), false, "still receding");
	assert.equal(isStill(landed, 1_000 + 1_900), true, "the recede is over");
	assert.equal(isStill({ outcome: "error", startedAt: 0, endedAt: 1_000 }, 1_000), true, "a failure lands without a recede");
	assert.equal(isStill({ outcome: "running", startedAt: 0, endedAt: undefined }, 60_000), false, "a running row never is");
	assert.equal(isStill({ outcome: "pending", startedAt: 0, endedAt: undefined }, 60_000), false, "nor is one whose duration still ticks");
	assert.equal(isStill({ outcome: "pending", startedAt: undefined, endedAt: undefined }, 60_000), true, "a call not yet started draws no time");
});

/** A packed run whose leader has settled, with a second member made to move by `arrange`. */
function runWithMember(arrange: (member: Row) => void): { leader: Row; member: Row; harness: ReturnType<typeof createHarness> } {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["r1", "read"], ["g1", "grep"]) });
	const leader = new Row(harness, "read", "r1", { path: "src/a.ts" }).restore("a");
	const member = new Row(harness, "grep", "g1", { pattern: "n", path: "src" });
	arrange(member);
	for (let i = 0; i < 2; i++) for (const row of [leader, member]) at(1_000, () => row.render(100));
	return { leader, member, harness };
}

test("a run keeps moving while any member moves, not only its leader", () => {
	const running = runWithMember((member) => at(0, () => member.start()));
	const call = running.leader.slots()[0]!;
	const early = at(1_000, () => call.render(100));
	assert.ok(early.length >= 2, "the leader draws the running member inside its run");
	assert.notDeepEqual(at(3_000, () => call.render(100)), early, "the running member's time moves on");
	running.member.stop();

	const receding = runWithMember((member) => at(0, () => member.start()) && at(1_000, () => member.finish("a.ts:1")));
	const drawn = reusedAndFresh(receding.leader, 2_200);
	assert.deepEqual(drawn.reused, drawn.fresh, "a run drawn mid-recede is not kept");
	receding.member.stop();
});

test("a call joining a reused run is drawn in it on the next frame", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["r1", "read"], ["g1", "grep"]) });
	const leader = new Row(harness, "read", "r1", { path: "src/a.ts" }).restore("a");
	const failed = new Row(harness, "grep", "g1", { pattern: "n", path: "src" }).restore("Command failed", { isError: true });
	for (let i = 0; i < 2; i++) for (const row of [leader, failed]) row.render(100);
	const call = leader.slots()[0]!;
	const before = call.render(100);
	assert.equal(call.render(100), before, "the packed run is reused");

	// The message streams a third exploratory call; pi renders its row before it starts.
	harness.emit("message_update", { message: message(["r1", "read"], ["g1", "grep"], ["l1", "ls"]), assistantMessageEvent: { type: "toolcall_end" } });
	new Row(harness, "ls", "l1", { path: "src" }).render(100);
	const after = call.render(100);
	assert.equal(after.length, before.length + 1, "the new member joins the run's drawing");
	call.invalidate?.();
	assert.deepEqual(after, call.render(100), "and equals a fresh paint");
});

test("a row's head drawn by its result slot is reused, and follows a new outcome", () => {
	setHyperlinks(false);
	const style = mock.method(theme, "style");
	try {
		const row = new Row(createHarness(), "read", "x", { path: "src/a.ts" }).restore("a");
		row.update();
		// Before the call slot has drawn two frames, the result slot draws the settled head.
		const result = () => row.slots()[1]!.render(100);
		const first = result();
		assert.ok(first.length >= 1, "the result slot draws the head");
		style.mock.resetCalls();
		assert.deepEqual(result(), first);
		assert.equal(style.mock.callCount(), 0, "the head is not painted again");
		row.restore("bad\n\nCommand exited with code 3", { isError: true }).update();
		const fresh = new Row(createHarness(), "read", "x", { path: "src/a.ts" }).restore("bad\n\nCommand exited with code 3", { isError: true });
		fresh.update();
		assert.deepEqual(result(), fresh.slots()[1]!.render(100), "a new outcome is drawn, not the reused head");
	} finally {
		style.mock.restore();
	}
});

test("a diff keeps one drawing per width and draws a new width afresh", () => {
	setHyperlinks(false);
	const diff = { diff: "- 3 const a = 1;\n+ 3 const a = 2;\n  4 return a;" };
	const row = new Row(createHarness(), "edit", "e1", { path: "src/c.ts" }).restore("ok", { details: diff }).expand();
	const fresh = (width: number) => new Row(createHarness(), "edit", "e1", { path: "src/c.ts" }).restore("ok", { details: diff }).expand().render(width);
	row.render(100);
	const wide = row.paint(100);
	assert.equal(row.slots().at(-1)!.render(100), row.slots().at(-1)!.render(100), "the diff hands back the same lines");
	assert.deepEqual(row.paint(24), fresh(24), "a narrower width draws again");
	assert.deepEqual(row.paint(100), wide, "and the wide drawing comes back unchanged");
});

/** A terminal that swallows output, sized like a wide fullscreen pi. */
function nullTerminal(columns: number, rows: number): Terminal {
	return {
		start() {},
		stop() {},
		drainInput: async () => {},
		write() {},
		columns,
		rows,
		kittyProtocolActive: false,
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
}

/** pi's fullscreen TUI with frame drawing exposed, so a test can time one frame. */
class FrameProbe extends TuiAltScreen {
	frame(): void {
		this.doRender();
	}
}

/**
 * The budget: on a long session's transcript — 300 settled bash rows, some carrying multi-KB heredocs —
 * a frame through pi's real fullscreen renderer takes no more than this, median of many frames.
 * pi itself draws thousands of cached lines in about a millisecond.
 */
const FRAME_BUDGET_MS = 2;

test("a long session's frame stays within the frame budget", (t) => {
	setHyperlinks(false);
	const harness = createHarness();
	const rows: Row[] = [];
	for (let i = 0; i < 300; i++) {
		const command = i % 25 === 0 ? longCommand(2_000 + (i % 4) * 2_000) : `npm run test --workspace pkg-${i} -- --grep "case ${i}"`;
		rows.push(new Row(harness, "bash", `b${i}`, { command }).restore(`line\n`.repeat(i % 5)));
	}
	for (const row of rows) row.render(200);

	const tui = new FrameProbe(nullTerminal(200, 60), false);
	for (const row of rows) tui.addChild({ render: (width: number) => row.paint(width), invalidate() {} });
	tui.start();
	try {
		for (let i = 0; i < 5; i++) tui.frame();
		const times: number[] = [];
		for (let i = 0; i < 60; i++) {
			const started = performance.now();
			tui.frame();
			times.push(performance.now() - started);
		}
		times.sort((a, b) => a - b);
		const median = times[times.length >> 1] ?? Number.POSITIVE_INFINITY;
		t.diagnostic(`median frame ${median.toFixed(2)} ms (budget ${FRAME_BUDGET_MS} ms)`);
		assert.ok(median <= FRAME_BUDGET_MS, `median frame ${median.toFixed(2)} ms exceeds the ${FRAME_BUDGET_MS} ms budget`);
	} finally {
		tui.stop();
	}
});
