/** Exploratory runs: packing, folding, unpacking on click, branch re-reads. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseColor, stripTerminalSequences } from "@earendil-works/pi-tui";
import { TOKENS, createHarness, Row, at, setHyperlinks, fgAt, hex, message, runFixture } from "./test-harness.ts";

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
	const r1 = rows.r1.plain();
	const g1 = rows.g1.plain();
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
	t1.render();
	assert.deepEqual(t2.plain(), []);
	assert.match(t1.plain()[0] ?? "", /^ ● Explored\s+1 file · 1 listing/);
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
	assert.match(text.plain()[0] ?? "", /^ ● Read\s+a\.ts/);
	assert.equal(text.plain().length, 1);
	assert.match(image.plain()[0] ?? "", /^ ● Read\s+shot\.png.*image$/);
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
	s1.render();
	assert.deepEqual(s2.plain(), [], "the streamed second call joins the first call's run");
	assert.match(s1.plain()[0] ?? "", /^ ● Explored\s+1 file · 1 search/);
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
	const first = at(3_000, () => [...rebuilt.r1.plain(), ...rebuilt.g1.plain()]);
	assert.equal(first.filter((line) => line.startsWith(" ●")).length, 2, "the first frame draws each rebuilt row settled, on its own");
	assert.ok(first.every((line) => !/Reading|Searching/.test(line)));
	at(3_000, () => [rebuilt.r1.plain(), rebuilt.g1.plain()]);
	assert.match(at(3_000, () => rebuilt.r1.plain())[0] ?? "", /^ ● Explored {2}1 file · 1 search/, "then the rebuilt leader folds the run");
	assert.deepEqual(at(3_000, () => rebuilt.g1.plain()), [], "and the follower hides under it");
	for (const row of [...Object.values(rows), ...Object.values(rebuilt)]) row.stop();
});
