/** Exploratory runs: packing, folding, unpacking on click, branch re-reads. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mixColors, parseColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { RowHead } from "./row.ts";
import { ExploreRuns } from "./runs.ts";
import { TOKENS, createHarness, drawFrames, Row, at, setHyperlinks, fgAt, hex, message, runFixture } from "./test-harness.ts";

test("consecutive exploratory calls pack under their first row while running", () => {
	const { rows } = runFixture();
	at(0, () => {
		rows.r1.start();
		rows.g1.start();
	});
	const [r1, g1] = at(100, () => drawFrames([rows.r1, rows.g1]));
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
	const [r1, g1] = drawFrames([rows.r1, rows.g1]).map((lines) => lines.map((line) => line.trimEnd()));
	assert.match(r1?.[0] ?? "", /^ ● Read\s/);
	assert.deepEqual(r1?.slice(1), ["   one", "   two"]);
	assert.match(g1?.[0] ?? "", /^ ● Searched\s/);
	assert.deepEqual(g1?.slice(1), ["   a:1"]);
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
	const [folded, hidden, hiddenToo] = drawFrames([r1, r2, l1]);
	assert.deepEqual([hidden, hiddenToo], [[], []]);
	assert.equal(folded.length, 1);
	assert.match(folded[0] ?? "", /^ ● Explored\s+2 files · 1 listing/);
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
	const [r1 = [], g1 = []] = drawFrames([rows.r1, rows.g1]);
	assert.equal(r1.length, 1);
	assert.match(r1[0] ?? "", /^ ● Read\s/);
	assert.match(g1[0] ?? "", /^ ● Searched\s/);
	assert.equal([...r1, ...g1].filter((line) => line.includes("Searched")).length, 1);
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
	const [leader, follower] = drawFrames([t1, t2]);
	assert.deepEqual(follower, []);
	assert.match(leader[0] ?? "", /^ ● Explored\s+1 file · 1 listing/);
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

test("an image read keeps its run unpacked, so the image stays under its own row", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("message_end", { message: message(["i1", "read"], ["i2", "read"]) });
	const text = new Row(harness, "read", "i1", { path: "a.ts" }).restore("x");
	const image = new Row(harness, "read", "i2", { path: "shot.png" }).restore("Read image", { image: true });
	const [textLines = [], imageLines = []] = drawFrames([text, image]);
	assert.match(textLines[0] ?? "", /^ ● Read\s+a\.ts/);
	assert.equal(textLines.length, 1);
	assert.match(imageLines[0] ?? "", /^ ● Read\s+shot\.png.*image$/);
});

test("clicking a folded run opens it into rows that each expand on their own", () => {
	const { rows } = runFixture();
	rows.r1.restore("one");
	rows.g1.restore("a:1");
	rows.g1.render();
	assert.match(rows.r1.plain()[0] ?? "", /Explored/);
	assert.deepEqual(rows.r1.click(), { handled: true });
	assert.match(rows.r1.plain()[0] ?? "", /^ ● Read\s/);
	assert.equal(rows.r1.plain().length, 1, "the leader draws only itself, still collapsed");
	assert.match(rows.g1.plain()[0] ?? "", /^ ● Searched\s/, "the follower draws its own clickable row");
	assert.equal(rows.g1.click(), undefined, "a plain row leaves the click to pi, which expands it");
});

test("only a left click opens a folded run: wheel, press, move and right clicks pass through", () => {
	const { rows } = runFixture();
	rows.r1.restore("one");
	rows.g1.restore("a:1");
	rows.g1.render();
	for (const [type, button] of [["wheel", "none"], ["press", "left"], ["move", "none"], ["click", "right"]] as const) {
		assert.equal(rows.r1.click(type, button), undefined, `${type}/${button} is not handled`);
		assert.match(rows.r1.plain()[0] ?? "", /Explored/, `${type}/${button} leaves the run folded`);
	}
	assert.deepEqual(rows.r1.click(), { handled: true });
});

test("a branch re-read folds runs again even after one was clicked open", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const branch = { sessionManager: { getBranch: () => [{ type: "message", message: message(["c1", "read"], ["c2", "read"]) }] } };
	harness.emit("session_start", { reason: "resume" }, branch);
	const c1 = new Row(harness, "read", "c1", { path: "a.ts" }).restore("x");
	new Row(harness, "read", "c2", { path: "b.ts" }).restore("y").render();
	assert.match(c1.plain()[0] ?? "", /Explored/);
	c1.click();
	assert.match(c1.plain()[0] ?? "", /^ ● Read\s/);
	harness.emit("session_tree", {}, branch);
	assert.match(c1.plain()[0] ?? "", /Explored/);
});

test("a packed run lines its targets up in one column", () => {
	const { rows } = runFixture();
	at(0, () => {
		rows.r1.start();
		rows.g1.start();
	});
	at(100, () => rows.g1.render());
	const [read, search] = at(100, () => rows.r1.plain());
	assert.equal(read?.indexOf("src/a.ts"), search?.indexOf("needle"), `${read}\n${search}`);
	assert.match(search ?? "", /^ ● Searching {2}needle/, "the longest verb keeps the two-space gap");
	for (const row of Object.values(rows)) row.stop();
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
	const [leader, follower] = drawFrames([s1, s2]);
	assert.deepEqual(follower, [], "the streamed second call joins the first call's run");
	assert.match(leader[0] ?? "", /^ ● Explored\s+1 file · 1 search/);
});

test("an export pass draws each row settled, on its own, without unfolding the live run", () => {
	const { harness, rows } = runFixture();
	at(0, () => {
		rows.r1.start();
		rows.g1.start();
	});
	at(100, () => {
		rows.r1.finish("a");
		rows.g1.finish("boom", { isError: true });
	});
	at(3_000, () => [rows.r1.plain(), rows.g1.plain()]);
	const before = at(3_000, () => [...rows.r1.plain(), ...rows.g1.plain()]);

	// pi's export draws the call before the result exists, on fresh state for the same ids.
	const read = at(3_000, () => new Row(harness, "read", "r1", { path: "src/a.ts" }).restore("a").exportRender());
	assert.deepEqual(read.call, [], "the call can't know the outcome yet, so it draws nothing");
	assert.match(read.collapsed[0] ?? "", /^ ● Read {2}src\/a\.ts +1 line/, "the result draws the settled row");
	const grep = at(3_000, () => new Row(harness, "grep", "g1", { pattern: "needle", path: "src" }).restore("boom", { isError: true }).exportRender());
	assert.match(grep.collapsed[0] ?? "", /^ ✕ Searched {2}needle/, "a failed search exports as failed");
	assert.ok(grep.collapsed.some((line) => line.includes("boom")), "with its error");

	assert.deepEqual(at(3_000, () => [...rows.r1.plain(), ...rows.g1.plain()]), before, "the live rows are unchanged");
	for (const row of Object.values(rows)) row.stop();
});

test("a chat rebuilt while its tools ran takes the run over: the rebuilt rows fold once they finish", () => {
	const { harness, rows } = runFixture();
	at(0, () => {
		rows.r1.start();
		rows.g1.start();
	});
	at(100, () => [rows.r1.plain(), rows.g1.plain()]);
	// The old rows froze while running; pi rebuilt the chat and the results arrived on the new rows.
	at(200, () => {
		harness.emit("tool_execution_end", { toolCallId: "r1", toolName: "read", isError: false });
		harness.emit("tool_execution_end", { toolCallId: "g1", toolName: "grep", isError: false });
	});
	const rebuilt = { r1: new Row(harness, "read", "r1", { path: "src/a.ts" }), g1: new Row(harness, "grep", "g1", { pattern: "needle", path: "src" }) };
	rebuilt.r1.restore("a");
	rebuilt.g1.restore("x");
	const first = at(3_000, () => [...rebuilt.r1.drawFrame(), ...rebuilt.g1.drawFrame()]);
	assert.equal(first.filter((line) => line.startsWith(" ●")).length, 2, "the first frame draws each rebuilt row settled, on its own");
	assert.ok(first.every((line) => !/Reading|Searching/.test(line)));
	at(3_000, () => [rebuilt.r1.plain(), rebuilt.g1.plain()]);
	assert.match(at(3_000, () => rebuilt.r1.plain())[0] ?? "", /^ ● Explored {2}1 file · 1 search/, "then the rebuilt leader folds the run");
	assert.deepEqual(at(3_000, () => rebuilt.g1.plain()), [], "and the follower hides under it");
	for (const row of [...Object.values(rows), ...Object.values(rebuilt)]) row.stop();
});

test("an export of searches this session never drew still shows each one settled, failures included", () => {
	setHyperlinks(false);
	const harness = createHarness();
	// A run from before a compaction, or on a branch the user never opened: known, but never drawn.
	harness.emit("message_end", { message: message(["x1", "grep"], ["x2", "find"]) });
	harness.emit("message_end", { message: message(["x3", "grep"]) });
	const lone = new Row(harness, "grep", "x3", { pattern: "needle", path: "src" }).restore("boom", { isError: true }).exportRender();
	assert.deepEqual(lone.call, []);
	assert.match(lone.collapsed[0] ?? "", /^ ✕ Searched {2}needle/);
	assert.ok(lone.collapsed.some((line) => line.includes("boom")), "the error is kept");
	const leader = new Row(harness, "grep", "x1", { pattern: "a", path: "src" }).restore("src/a.ts:1: a").exportRender();
	const follower = new Row(harness, "find", "x2", { pattern: "*.ts", path: "src" }).restore("nope", { isError: true }).exportRender();
	assert.match(leader.collapsed[0] ?? "", /^ ● Searched {2}a/, "a run's leader exports as its own settled row");
	assert.match(follower.collapsed[0] ?? "", /^ ✕ Found {2}\*\.ts/, "and so does a follower, with its failure");
});

test("a restored run drawn top to bottom never drops or splits a member, and folds on its second frame", async () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("session_start", { reason: "reload" }, { sessionManager: { getBranch: () => [{ type: "message", message: message(["q1", "read"], ["q2", "read"], ["q3", "grep"]) }] } });
	const rows = [
		new Row(harness, "read", "q1", { path: "a.ts" }).restore("x"),
		new Row(harness, "read", "q2", { path: "b.ts" }).restore("y"),
		new Row(harness, "grep", "q3", { pattern: "needle" }).restore("a.ts:1: needle"),
	];
	// Each row's head without its right-aligned result column.
	const heads = (frame: string[][]) => frame.map((lines) => lines.map((line) => line.split(/ {3,}/)[0]));
	const separate = [[" ● Read  a.ts"], [" ● Read  b.ts"], [" ● Searched  needle  in ."]];
	assert.deepEqual(heads(drawFrames(rows, 1)), separate, "frame 1: each row draws itself, settled");
	await Promise.resolve();
	assert.ok(rows.every((row) => row.context.invalidations > 0), "each row asked pi for its next frame itself");
	for (let frame = 2; frame <= 3; frame++) {
		const [folded = [], ...hidden] = drawFrames(rows, 1);
		assert.equal(folded.length, 1, `frame ${frame}: ${JSON.stringify(folded)}`);
		assert.match(folded[0] ?? "", /^ ● Explored {2}2 files · 1 search/, `frame ${frame}: the run is folded, every member counted`);
		assert.deepEqual(hidden, [[], []], `frame ${frame}: no member draws apart from it`);
	}
});

test("a run with a finished member and one still running or waiting stays unfolded", () => {
	const { rows } = runFixture();
	at(0, () => {
		rows.r1.start();
		rows.g1.start();
	});
	at(100, () => rows.r1.finish("a"));
	const [parallel] = at(150, () => drawFrames([rows.r1, rows.g1]));
	assert.equal(parallel.length, 2, parallel.join("\n"));
	assert.match(parallel[0] ?? "", /^ ● Read +src\/a\.ts/);
	assert.match(parallel[1] ?? "", /^ ● Searching {2}needle/);
	for (const row of Object.values(rows)) row.stop();

	const sequential = runFixture().rows;
	at(0, () => sequential.r1.start());
	at(100, () => sequential.r1.finish("a"));
	const [leader] = at(150, () => drawFrames([sequential.r1, sequential.g1]));
	assert.equal(leader.length, 2, "a member still waiting to start keeps the run unfolded");
	assert.match(leader[1] ?? "", /^ ● Searching/);
	for (const row of Object.values(sequential)) row.stop();
});

test("the folded Explored line fits narrow widths and keeps its duration when there is room", () => {
	const harness = createHarness();
	setHyperlinks(false);
	harness.emit("message_end", { message: message(["n1", "read"], ["n2", "read"], ["n3", "read"], ["n4", "grep"]) });
	const rows = [
		new Row(harness, "read", "n1", { path: "a.ts" }),
		new Row(harness, "read", "n2", { path: "b.ts" }),
		new Row(harness, "read", "n3", { path: "c.ts" }),
		new Row(harness, "grep", "n4", { pattern: "x" }),
	];
	at(0, () => rows.forEach((row) => row.start()));
	at(300, () => rows.forEach((row) => row.finish("a")));
	for (const width of [30, 40, 60]) {
		const [folded] = at(5_000, () => drawFrames(rows, 3, width));
		assert.ok(folded[0]?.includes("Explored"), folded.join("\n"));
		assert.ok(folded.every((line) => visibleWidth(line) <= width), `${width}: ${JSON.stringify(folded)}`);
		if (width === 60) assert.match(folded[0] ?? "", /0\.3s$/);
	}
	rows.forEach((row) => row.stop());
});

test("re-reading a branch lets go of row states for tool calls no longer on it", () => {
	const runs = new ExploreRuns();
	const kept = { head: undefined };
	const dropped = { head: undefined };
	runs.claim("on", kept);
	runs.claim("off", dropped);
	runs.readBranch([message(["on", "read"])]);
	assert.ok(runs.owns("on", kept), "a tool call still on the branch keeps its row");
	assert.ok(!runs.owns("off", dropped), "one from a dropped chat is released");
	runs.readBranch([]);
	assert.ok(!runs.owns("on", kept), "a new, empty session releases everything");
});

test("a compaction lets go of the rows it dropped from the chat and keeps the rest", () => {
	const runs = new ExploreRuns();
	const dropped = { head: undefined };
	const kept = { head: undefined };
	runs.claim("old", dropped);
	runs.claim("new", kept);
	runs.retainOwners([message(["new", "read"])]);
	assert.ok(!runs.owns("old", dropped), "a row the compaction dropped is released");
	assert.ok(runs.owns("new", kept), "a row still in the kept context stays");

});

test("session_compact releases the rows it dropped, keeps the rest, and leaves clicked-open runs open", () => {
	setHyperlinks(false);
	const harness = createHarness();
	const dropped = message(["old", "read"]);
	const kept = message(["u1", "read"], ["u2", "read"]);
	harness.emit("session_start", { reason: "startup" }, { sessionManager: { getBranch: () => [dropped, kept].map((m) => ({ type: "message", message: m })) } });
	const old = new Row(harness, "read", "old", { path: "old.ts" }).restore("x");
	const u1 = new Row(harness, "read", "u1", { path: "a.ts" }).restore("a");
	const u2 = new Row(harness, "read", "u2", { path: "b.ts" }).restore("b");
	drawFrames([old, u1, u2]);
	u1.click();
	assert.deepEqual(old.resultSlot(), [], "while owned, the row's head is drawn by its call slot");
	harness.emit("session_compact", {}, { sessionManager: { buildContextEntries: () => [{ type: "compaction" }, { type: "message", message: kept }] } });
	assert.match(old.resultSlot()[0] ?? "", /^ ● Read {2}old\.ts/, "the dropped row no longer owns its call");
	assert.deepEqual(u1.resultSlot(), [], "a kept row still owns its own");
	assert.match(drawFrames([u1, u2], 1)[0]?.[0] ?? "", /^ ● Read {2}a\.ts/, "the run the user opened stays open");
});

test("each head is drawn by exactly one slot per frame: restored runs, members joining a live run", () => {
	const runs = new ExploreRuns();
	runs.readBranch([message(["l", "read"], ["f", "read"], ["g", "grep"])]);
	const state = (outcome: RowHead["outcome"]) => ({ head: { outcome, expanded: false, standalone: false } as RowHead });
	const sources = new Map([["l", state("success")], ["f", state("success")]]);
	const frame = () => {
		for (const [id, source] of sources) runs.report(id, source);
		const drawers = new Map<string, number>();
		const count = (id: string) => drawers.set(id, (drawers.get(id) ?? 0) + 1);
		for (const [id, source] of sources) {
			const call = runs.callSlot(id, source);
			if (call.kind === "row") count(id);
			if (call.kind === "run") for (const member of call.members) count([...sources].find(([, s]) => s.head === member)?.[0] ?? "?");
			if (runs.resultSlotDrawsHead(id, source)) count(id);
		}
		return Object.fromEntries(drawers);
	};
	assert.deepEqual(frame(), { l: 1, f: 1 }, "frame 1");
	assert.deepEqual(frame(), { l: 1, f: 1 }, "frame 2");
	sources.set("g", state("running"));
	for (let n = 3; n <= 5; n++) assert.deepEqual(frame(), { l: 1, f: 1, g: 1 }, `frame ${n}: the new member is drawn once from its first frame`);
});

test("a compaction also forgets which states a leader drew", () => {
	const runs = new ExploreRuns();
	runs.readBranch([message(["l", "read"], ["f", "read"])]);
	const leader = { head: { outcome: "success", expanded: false, standalone: false } as RowHead };
	const follower = { head: { outcome: "running", expanded: false, standalone: false } as RowHead };
	runs.claim("l", leader);
	runs.report("f", follower);
	runs.callSlot("l", leader);
	assert.ok(!runs.resultSlotDrawsHead("f", follower), "the leader drew the follower's state");
	runs.retainOwners([]);
	assert.ok(runs.resultSlotDrawsHead("f", follower), "after release nothing remembers drawing it");
});

test("a folded run restored from history is settled: receded tones and no duration", () => {
	setHyperlinks(false);
	const harness = createHarness();
	harness.emit("session_start", { reason: "resume" }, { sessionManager: { getBranch: () => [{ type: "message", message: message(["h1", "read"], ["h2", "read"]) }] } });
	const h1 = new Row(harness, "read", "h1", { path: "a.ts" }).restore("x");
	const h2 = new Row(harness, "read", "h2", { path: "b.ts" }).restore("y");
	drawFrames([h1, h2]);
	const line = h1.render()[0] ?? "";
	assert.match(stripTerminalSequences(line).trimEnd(), /^ ● Explored {2}2 files {3}ctrl\+o to expand$/, "no duration on a restored fold");
	assert.equal(fgAt(line, "Explored"), hex(parseColor(TOKENS.muted!)), "the label is receded");
	assert.equal(fgAt(line, "2 files"), hex(mixColors(parseColor(TOKENS.text!), parseColor(TOKENS.muted!), 0.35, "srgb")), "the counts are soft");
});

test("a member that starts while its run is on screen joins the run on its very first frame", () => {
	const { rows } = runFixture();
	at(0, () => rows.r1.start());
	at(50, () => drawFrames([rows.r1], 3));
	// The grep starts: pi creates its row and draws the transcript top to bottom.
	at(100, () => rows.g1.start());
	for (let frame = 1; frame <= 3; frame++) {
		const [leader = [], follower = []] = at(100 + frame * 16, () => drawFrames([rows.r1, rows.g1], 1));
		assert.equal(leader.length, 2, `frame ${frame}: the leader draws both members, no blank line: ${JSON.stringify(leader)}`);
		assert.match(leader[1] ?? "", /^ ● Searching +needle/, `frame ${frame}`);
		assert.deepEqual(follower, [], `frame ${frame}: the new member never draws apart`);
	}
	for (const row of Object.values(rows)) row.stop();
});

test("a finished member restored under a live leader is drawn once, by the leader", () => {
	const { harness, rows } = runFixture();
	rows.r1.restore("a");
	at(0, () => drawFrames([rows.r1], 3));
	const rebuilt = new Row(harness, "grep", "g1", { pattern: "needle", path: "src" }).restore("x");
	const [leader = [], follower = []] = at(0, () => drawFrames([rows.r1, rebuilt], 1));
	assert.equal([...leader, ...follower].filter((line) => line.includes("needle") || line.includes("search")).length, 1, JSON.stringify([leader, follower]));
	assert.deepEqual(follower, []);
});

test("candidate states are drawn into their run and released with it", () => {
	const runs = new ExploreRuns();
	const head = { expanded: false, standalone: false } as RowHead;
	runs.readBranch([message(["l", "read"], ["f", "read"])]);
	runs.claim("l", { head });
	runs.report("f", { head });
	const before = runs.role("l");
	assert.equal(before.kind === "leader" && before.members.length, 2, "the leader draws a member that has only reported");
	runs.retainOwners([message(["l", "read"])]);
	const after = runs.role("l");
	assert.equal(after.kind === "leader" && after.members.length, 1, "a released candidate is no longer drawn or held");
});
