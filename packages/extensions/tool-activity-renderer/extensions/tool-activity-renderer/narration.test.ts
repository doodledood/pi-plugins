import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createHarness, setHyperlinks } from "./test-harness.ts";
import { muteNarration, Narration } from "./narration.ts";
import { thinkingTone } from "./quiet.ts";
import { flattenThinkingCode } from "./thinking.ts";

/** A thinking tone no theme token produces, so the tests can tell it from every other color. */
const TONE_FG = "\x1b[38;2;9;8;7m";
const toneTheme = { fg: (_color: "thinkingText", text: string) => `${TONE_FG}${text}\x1b[39m`, italic: (text: string) => `\x1b[3m${text}\x1b[23m` };
const TONE = thinkingTone(toneTheme);

/** What pi draws for assistant Markdown at `width`, with its real theme. */
function draw(markdown: string, width = 80): string[] {
	return new Markdown(markdown, 0, 0, getMarkdownTheme()).render(width);
}

/** The visible characters drawn outside the thinking tone, as words, in order. */
function untoned(lines: readonly string[]): string[] {
	const words: string[] = [];
	for (const line of lines) {
		let toned = false;
		let word = "";
		const flush = () => {
			if (word.trim()) words.push(word.trim());
			word = "";
		};
		for (const [token] of line.matchAll(/\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[^\x1b]/g)) {
			if (token.startsWith("\x1b[")) {
				const params = token.slice(2, -1).split(";");
				if (token.includes(TONE_FG.slice(2, -1))) toned = true;
				else if (params.includes("39") || params.includes("0") || params[0] === "38" || token === "\x1b[m") toned = false;
				if (toned) flush();
				continue;
			}
			if (token.startsWith("\x1b]")) continue;
			if (toned || token === " ") flush();
			else word += token;
		}
		flush();
	}
	return words;
}

const visible = (lines: readonly string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");

describe("narration tracking", () => {
	const assistant = (...content: object[]) => ({ role: "assistant", content });
	const text = (value: string) => ({ type: "text", text: value });
	const call = { type: "toolCall", id: "t1", name: "bash", arguments: {} };

	// Holds docs/adr/20261014-quiet-narration-through-checked-source-tone.md — weakening this test reverses that decision.
	it("counts the text of a message that calls a tool as narration, and only that", () => {
		const narration = new Narration();
		narration.ingest(assistant(text("  Checking the tests next. "), call), true);
		narration.ingest(assistant(text("All done.")), true);
		narration.ingest({ role: "user", content: [text("Run it.")] }, true);
		assert.ok(narration.has("Checking the tests next."), "pi passes the trimmed text");
		assert.ok(!narration.has("All done."));
		assert.ok(!narration.has("Run it."));
	});

	it("turns a streaming text into narration the moment its tool call shows up", () => {
		const narration = new Narration();
		narration.ingest(assistant(text("Reading the config.")), false);
		assert.ok(!narration.has("Reading the config."), "with no tool call yet it may still be the reply");
		narration.ingest(assistant(text("Reading the config."), call), false);
		assert.ok(narration.has("Reading the config."));
	});

	it("keeps a text that was also a reply at reply brightness", () => {
		const narration = new Narration();
		narration.ingest(assistant(text("Done."), call), true);
		narration.ingest(assistant(text("Done.")), true);
		assert.ok(!narration.has("Done."));
	});

	it("starts over from the branch pi draws", () => {
		const narration = new Narration();
		narration.ingest(assistant(text("Old narration."), call), true);
		narration.readBranch([assistant(text("Restored narration."), call), assistant(text("Restored reply."))]);
		assert.ok(!narration.has("Old narration."));
		assert.ok(narration.has("Restored narration."));
		assert.ok(!narration.has("Restored reply."));
	});
});

describe("muted narration", () => {
	const cases = [
		"Now the manifest pass: drop Deliverable 6 and the memory clauses, then renumber the ADRs.",
		"Two mutants survive:\n- **spanless-counted:** the isolated test shares cache state.\n- **partial-cached:** needs a closer look.",
		"**(note)** the start, _emphasis_ here, and ~~struck~~ text plus __strong__ words.",
		"_Leading emphasis_ then *more* and a [link](https://x.io/a) mid-line, then words.",
		"1. First step with `foo.ts`\n2. Second step\n   continued on a lazy line\n\n> quoted words here",
		"## A heading\n\nA paragraph long enough to wrap across several lines at a narrow width, which pi carries along.",
	];

	it("draws every word of the text in the thinking tone, leaving pi's markers and links in theirs", () => {
		setHyperlinks(false);
		for (const source of cases) {
			const words = untoned(draw(muteNarration(source, TONE, 40), 40));
			assert.deepEqual(
				words.filter((word) => !/^(?:-|\d+\.|│|##|link|\(https:\/\/x\.io\/a\))$/.test(word)),
				[],
				`${JSON.stringify(source)} left ${JSON.stringify(words)} in the reply color`,
			);
		}
	});

	it("shows exactly what pi showed without the tone, at the drawn width and where nothing wraps", () => {
		for (const hyperlinks of [false, true]) {
			setHyperlinks(hyperlinks);
			for (const source of cases) {
				for (const width of [24, 40, 200]) {
					const flat = flattenThinkingCode(source, width);
					assert.equal(visible(draw(muteNarration(source, TONE, width), width)), visible(draw(flat, width)), `${JSON.stringify(source)} at ${width}`);
				}
			}
		}
		setHyperlinks(false);
	});

	it("follows the thinking rule for inline code", () => {
		assert.ok(!muteNarration("Open `foo.ts` now.", TONE).includes("`"));
	});

	it("leaves code blocks and code spans in their own color", () => {
		const fenced = "Run this:\n```sh\nnpm run a b\n```\nthen check.";
		const muted = muteNarration(fenced, TONE);
		assert.ok(muted.includes("\nnpm run a b\n"), "no tone inside the fence");
		const kept = "`a b`_bar_ and more";
		assert.ok(muteNarration(kept, TONE).includes("`a b`_bar_ "), "a span that cannot flatten keeps its spaces free of the tone");
	});

	it("keeps a hard line break and a table's delimiter row as they are", () => {
		assert.ok(muteNarration("one two  \nthree", TONE).includes("two  \n"));
		const table = "| a b | c |\n| --- | --- |\n| d e | f |";
		assert.ok(muteNarration(table, TONE).includes("\n| --- | --- |\n"));
	});

	it("keeps the reply color in a block the tone would change, and tones the blocks around it", () => {
		const titled = 'See [docs](https://x.io "the title") here.';
		const source = `First block words.\n\n${titled}\n\nLast block words.`;
		const muted = muteNarration(source, TONE);
		assert.ok(muted.includes(`\n\n${titled}\n\n`), "the link title's space cannot take the tone");
		assert.ok(muted.startsWith(TONE) && muted.includes(`${TONE}Last`));
		assert.equal(visible(draw(muted)), visible(draw(source)));
	});
});

describe("narration in the transcript", () => {
	const context = (messageType: MarkdownTransformContext["messageType"]): MarkdownTransformContext => ({ messageType, isStreaming: false, availableWidth: 80 });
	const assistant = (...content: object[]) => ({ role: "assistant", content });
	const call = { type: "toolCall", id: "t1", name: "read", arguments: {} };
	const tuiContext = (entries: object[] = [], ui: { theme: typeof toneTheme } = { theme: toneTheme }) => ({
		mode: "tui",
		ui,
		sessionManager: { getBranch: () => entries, buildContextEntries: () => entries },
	});

	it("draws restored narration quiet and leaves replies, user text and thinking as before", () => {
		const { emit, transformers } = createHarness();
		const entries = [
			{ type: "message", message: assistant({ type: "text", text: "I'll check the config first." }, call) },
			{ type: "message", message: assistant({ type: "text", text: "The config is fine." }) },
		];
		emit("session_start", {}, tuiContext(entries));
		const transform = transformers[0]!;
		assert.ok(transform("I'll check the config first.", context("assistant")).startsWith(TONE));
		assert.equal(transform("The config is fine.", context("assistant")), "The config is fine.");
		assert.equal(transform("I'll check the config first.", context("user")), "I'll check the config first.");
		assert.equal(transform("a `b.c` d", context("assistant-thinking")), "a b\\.c d");
	});

	it("turns live text quiet once its tool call arrives", () => {
		const { emit, transformers } = createHarness();
		emit("session_start", {}, tuiContext());
		const transform = transformers[0]!;
		const text = { type: "text", text: "Now the tests." };
		emit("message_update", { message: assistant(text), assistantMessageEvent: { type: "text_delta" } });
		assert.equal(transform("Now the tests.", context("assistant")), "Now the tests.");
		emit("message_update", { message: assistant(text, call), assistantMessageEvent: { type: "toolcall_start" } });
		assert.ok(transform("Now the tests.", context("assistant")).startsWith(TONE));
	});

	it("follows a theme switch, and draws nothing differently outside pi's TUI", () => {
		const ui = { theme: toneTheme };
		const tui = createHarness();
		const entries = [{ type: "message", message: assistant({ type: "text", text: "Looking around." }, call) }];
		tui.emit("session_start", {}, tuiContext(entries, ui));
		const other = { ...toneTheme, fg: (_c: "thinkingText", text: string) => `\x1b[38;2;1;1;1m${text}\x1b[39m` };
		ui.theme = other;
		assert.ok(tui.transformers[0]!("Looking around.", context("assistant")).startsWith(thinkingTone(other)));

		const print = createHarness();
		print.emit("session_start", {}, { ...tuiContext(entries), mode: "print" });
		assert.equal(print.transformers[0]!("Looking around.", context("assistant")), "Looking around.");
	});
});
