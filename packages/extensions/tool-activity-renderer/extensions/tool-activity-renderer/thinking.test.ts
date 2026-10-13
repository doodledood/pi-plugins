import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, MarkdownTransformContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { createHarness, setHyperlinks } from "./test-harness.ts";
import { flattenThinkingCode, registerQuietThinking } from "./thinking.ts";

function registeredTransformer(): MarkdownTransformer {
	let transformer: MarkdownTransformer | undefined;
	registerQuietThinking({ registerMarkdownTransformer: (t: MarkdownTransformer) => (transformer = t) } as unknown as ExtensionAPI);
	assert.ok(transformer, "a Markdown transformer should be registered");
	return transformer;
}

const context = (messageType: MarkdownTransformContext["messageType"]): MarkdownTransformContext => ({ messageType, isStreaming: false, availableWidth: 80 });

describe("quiet thinking", () => {
	it("rewrites only thinking; answers and user messages pass through byte-identical", () => {
		const transform = registeredTransformer();
		const markdown = "Check `foo.ts` and `a*b*`.";
		assert.equal(transform(markdown, context("assistant")), markdown);
		assert.equal(transform(markdown, context("user")), markdown);
		assert.equal(transform(markdown, context("assistant-thinking")), "Check foo\\.ts and a\\*b\\*.");
	});

	it("is registered by the renderer, whichever /tool-render mode is on", () => {
		const { transformers } = createHarness();
		assert.equal(transformers.length, 1);
		assert.equal(transformers[0]?.("a `b.c` d", context("assistant-thinking")), "a b\\.c d");
	});

	it("escapes every character pi could read as syntax, including $ for its inline math", () => {
		assert.equal(flattenThinkingCode("see `$HOME/x` end"), "see \\$HOME\\/x end");
		assert.equal(flattenThinkingCode("`$a+$b$`"), "\\$a\\+\\$b\\$");
		assert.equal(flattenThinkingCode("`# x`"), "\\# x");
		assert.equal(flattenThinkingCode("`- x`"), "\\- x");
		assert.equal(flattenThinkingCode("`+ x`"), "\\+ x");
		assert.equal(flattenThinkingCode("`&amp;`"), "\\&amp\\;");
		assert.equal(flattenThinkingCode("`~~s~~`"), "\\~\\~s\\~\\~");
	});

	it("turns a code span into escaped plain text", () => {
		assert.equal(flattenThinkingCode("see `a_b*c` end"), "see a\\_b\\*c end");
		assert.equal(flattenThinkingCode("see `<div>` end"), "see \\<div\\> end");
		assert.equal(flattenThinkingCode("see `https://x.io/a` end"), "see https\\:\\/\\/x\\.io\\/a end");
	});

	it("leaves ( and [ bare so the result never opens LaTeX, escaping ) ] ! to stop links and images", () => {
		assert.equal(flattenThinkingCode("`![i](u)`"), "\\![i\\](u\\)");
		assert.equal(flattenThinkingCode("x `\\(y\\)` z"), "x \\\\(y\\\\\\) z");
	});

	it("matches backtick runs of equal length and drops one padding space from each side", () => {
		assert.equal(flattenThinkingCode("a `` b`c `` d"), "a b\\`c d");
		assert.equal(flattenThinkingCode("a ``` x `` y ``` b"), "a x \\`\\` y b");
	});

	it("keeps unmatched backticks and escaped backticks literal", () => {
		assert.equal(flattenThinkingCode("a `b"), "a `b");
		assert.equal(flattenThinkingCode("a \\`b` c"), "a \\`b` c");
	});

	it("flattens spans within one line and never pairs backticks across lines or blocks", () => {
		assert.equal(flattenThinkingCode("a `b\nc` d"), "a `b\nc` d");
		assert.equal(flattenThinkingCode("a `b\n\nc` d"), "a `b\n\nc` d");
		assert.equal(flattenThinkingCode("Escape the ` char.\n- then `foo.ts` changes\n- and `bar`"), "Escape the ` char.\n- then foo\\.ts changes\n- and bar");
		// A bare pipe from a span must not turn a paragraph into a table by changing a row's cell count.
		assert.equal(flattenThinkingCode("| a | `b|c` |\n|---|---|"), "| a | b|c |\n|---|---|");
	});

	it("leaves code blocks untouched wherever pi finds them, including inside lists and quotes", () => {
		const fenced = "before `x`\n```ts\nconst a = `t`;\n```\nafter `y`";
		assert.equal(flattenThinkingCode(fenced), "before x\n```ts\nconst a = `t`;\n```\nafter y");
		const tilde = "~~~\n`k`\n~~~";
		assert.equal(flattenThinkingCode(tilde), tilde);
		const nested = "- a\n  - b:\n    ```ts\n    const s = `x_${y}`;\n    ```";
		assert.equal(flattenThinkingCode(nested), nested);
		const quoted = "> ```\n> const a = `t_x`;\n> ```";
		assert.equal(flattenThinkingCode(quoted), quoted);
		assert.equal(flattenThinkingCode("```x``` is inline.\n```\nlet s = `a_b`;\n```\nafter `y`"), "x is inline.\n```\nlet s = `a_b`;\n```\nafter y");
	});

	it("keeps a span as code where plain text would break the line it starts", () => {
		assert.equal(flattenThinkingCode("`    four` spaces"), "`    four` spaces");
		assert.equal(flattenThinkingCode("- `    four` x"), "- `    four` x");
		assert.equal(flattenThinkingCode("> `    four` x"), "> `    four` x");
		assert.equal(flattenThinkingCode("`\\[m\\]` math"), "`\\[m\\]` math");
		assert.equal(flattenThinkingCode("x `    four`"), "x     four");
	});

	it("keeps a span as code where its brackets would join a link outside it", () => {
		assert.equal(flattenThinkingCode("`[` foo](http://x.io)"), "`[` foo](http://x.io)");
		assert.equal(flattenThinkingCode("[a]`(b`)"), "[a]`(b`)");
		assert.equal(flattenThinkingCode("index `f(x)[0]` here"), "index f(x\\)[0\\] here");
	});

	it("leaves a span as code wherever plain text would change what pi shows around it", () => {
		const kept = [
			"Check $HOME/.config and run `ls -la` ", // a lone $ opens pending math that pi prints raw
			"$a `b` c$ d",
			"\\(x `y_z` \\)",
			"`foo`_bar_",
			"**`foo`**bar",
			"`www`.example.com",
			"`user`@example.com",
			"`|a|`\n|-|",
			"[foo `[` bar](http://u)",
			"*`[`* foo](http://u)",
			"![`a_b`](u)",
			"- item\n`  two` x", // the list continuation's indent would shrink
		];
		// Links must be caught by the check itself, not by the URL a hyperlink-capable terminal adds.
		for (const hyperlinks of [false, true]) {
			setHyperlinks(hyperlinks);
			for (const markdown of kept) assert.equal(flattenThinkingCode(markdown), markdown, `${JSON.stringify(markdown)} hyperlinks=${hyperlinks}`);
		}
		setHyperlinks(false);
	});

	it("checks at the width pi draws at, where a table too wide for it shows as source", () => {
		const cells = (cell: string) => `|${Array.from({ length: 10 }, () => ` ${cell} `).join("|")}|`;
		const table = `${cells("h")}\n|${"---|".repeat(10)}\n${cells("`a_b`")}`;
		assert.equal(flattenThinkingCode(table, 40), table);
		assert.equal(registeredTransformer()(table, { ...context("assistant-thinking"), availableWidth: 40 }), table);
		assert.equal(flattenThinkingCode(table, 200), table.replaceAll("`a_b`", "a\\_b"));
	});

	it("flattens a span that ends at the wrap column, whatever word follows it", () => {
		// pi carries the space after styled text onto the next line, but not after plain text.
		assert.equal(flattenThinkingCode("aaaa bbbb `cccc` d", 14), "aaaa bbbb cccc d");
		assert.equal(flattenThinkingCode("aaaa bbbb `cccc` dd", 14), "aaaa bbbb cccc dd");
		assert.equal(flattenThinkingCode("aaaa bbbb `cccc`", 14), "aaaa bbbb cccc");
		// The carried space takes room, so the rest of the paragraph wraps differently; that is still the same text.
		const reflowed = "The file `foo.ts` and then `bar.ts` mention something long enough to wrap a few times across `baz.ts` lines here.";
		assert.equal(flattenThinkingCode(reflowed, 15), reflowed.replaceAll("`", "").replaceAll(".ts", "\\.ts"));
	});

	/** How many characters pi's renderer draws while `run` runs. */
	function drawnBy(run: () => void): number {
		const render = Markdown.prototype.render;
		let drawn = 0;
		Markdown.prototype.render = function (this: Markdown, width: number) {
			const lines = render.call(this, width);
			for (const line of lines) drawn += line.length;
			return lines;
		};
		try {
			run();
		} finally {
			Markdown.prototype.render = render;
		}
		return drawn;
	}
	const flattened = (text: string) => text.replaceAll("`", "").replaceAll(".ts", "\\.ts");

	it("renders in proportion to the text, even for long thinking with no blank lines", () => {
		// pi pads every rendered line to the render width, so the check's width where nothing wraps must
		// follow the longest line, not the whole run of lines between blank lines.
		const text = Array.from({ length: 1000 }, (_, i) => `Step ${i}: look at \`file${i}.ts\` again.`).join("\n");
		const drawn = drawnBy(() => assert.equal(flattenThinkingCode(text, 100), flattened(text)));
		assert.ok(drawn < 20 * text.length, `rendered ${drawn} characters for ${text.length} of thinking`);
	});

	it("costs about the same whether one line among many is long or very long", () => {
		const steps = Array.from({ length: 300 }, (_, i) => `Step ${i}: look at \`file${i}.ts\` again.`).join("\n");
		const drawnWith = (first: string) => {
			const text = `${first}\n${steps}`;
			return drawnBy(() => assert.equal(flattenThinkingCode(text, 100), flattened(text)));
		};
		const long = drawnWith("word ".repeat(600));
		const veryLong = drawnWith("word ".repeat(40_000));
		assert.ok(veryLong < 3 * long, `rendered ${veryLong} characters with a 200,000-character line, ${long} with a 3,000-character one`);
	});

	it("spends none of its budget on paragraphs without code", () => {
		// A fence keeps the all-at-once rewrite from passing, so blocks settle one by one.
		const prose = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${"plain words ".repeat(80)}`).join("\n\n");
		const text = `${prose}\n\nSee \`late.ts\` here.\n\n\`\`\`\nconst s = \`x\${y}\`;\n\`\`\``;
		assert.ok(prose.length > 50_000);
		assert.ok(flattenThinkingCode(text, 100).includes("See late\\.ts here."));
	});

	it("moves past a block the budget cut short on the next update", () => {
		const stuck = Array.from({ length: 200 }, (_, i) => `- item ${i} uses $HOME/x and \`a_${i}\``).join("\n");
		const text = `${stuck}\n\nThen open \`b.ts\`.`;
		assert.ok(flattenThinkingCode(text, 100).endsWith("Then open `b.ts`."), "the first update spends its budget on the stuck block");
		assert.ok(flattenThinkingCode(text, 100).endsWith("Then open b\\.ts."));
	});

	it("settles a finished last block once, however often pi re-renders the message after it", () => {
		// One block (no blank line) whose spans fail the all-at-once check: `$HOME` opens math beside them.
		const steps = Array.from({ length: 12 }, (_, i) => `- step ${i} reads $HOME and calls \`fn_${i}()\``).join("\n");
		const text = `Plan:\n\n${steps}`;
		flattenThinkingCode(text, 100);
		const again = drawnBy(() => {
			for (let i = 0; i < 5; i++) flattenThinkingCode(text, 100);
		});
		const first = drawnBy(() => flattenThinkingCode(`${text} `, 100));
		assert.ok(first > 0);
		assert.equal(again, 0, "an unchanged text is not checked again");
	});

	it("a finished text whose last block runs out of budget is not checked again", () => {
		const stuck = Array.from({ length: 200 }, (_, i) => `- item ${i} uses $HOME/x and \`a_${i}\``).join("\n");
		// A heading no other test uses, so no earlier test has settled it already.
		const text = `Plan for the stuck tail:\n\n${stuck}`;
		const first = flattenThinkingCode(text, 100);
		const again = drawnBy(() => {
			for (let i = 0; i < 5; i++) assert.equal(flattenThinkingCode(text, 100), first);
		});
		assert.equal(again, 0, "the first call settled no block for a later one to move past, so later calls cost nothing");
	});

	it("keeps moving past blocks the budget cut short, even when a call's output does not change", () => {
		const stuck = (tag: string) => Array.from({ length: 200 }, (_, i) => `- ${tag} ${i} uses $HOME/x and \`${tag}_${i}\``).join("\n");
		// Pi calls again with the same text on every reply delta, e.g. after a resize left no block cached.
		const text = `${stuck("p")}\n\n${stuck("q")}\n\nThen open \`b.ts\`.`;
		const outputs = [1, 2, 3, 4].map(() => flattenThinkingCode(text, 100));
		assert.equal(outputs[0], outputs[1], "the second call settles the second stuck block, which changes nothing it shows");
		assert.ok(outputs[3]!.endsWith("Then open b\\.ts."), "a later call still reaches the span after both");
	});

	it("settles afresh a block the budget ran out on partway, once the blocks before it are cached", () => {
		// The hard block leaves some budget, less than the easy block's first check costs.
		const hard = Array.from({ length: 12 }, (_, i) => `- item ${i} uses $HOME/x and \`starved_${i}\``).join("\n");
		const easy = Array.from({ length: 400 }, (_, i) => `Then read \`file_${i}.ts\` and \`other_${i}.ts\` carefully.`).join(" ");
		const text = `${hard}\n\n${easy}\n\nDone \`x.ts\`.`;
		const stillCode = () => (flattenThinkingCode(text, 100).match(/`file_\d+\.ts`/g) ?? []).length;
		assert.ok(stillCode() > 0, "the first call spends most of its budget on the hard block");
		assert.equal(stillCode(), 0, "the next call gives the easy block the whole budget");
	});

	it("re-renders every finished thinking run of a message for free, not only the last one", () => {
		const stuck = (tag: string) => `Plan ${tag}:\n\n${Array.from({ length: 200 }, (_, i) => `- ${tag} ${i} uses $HOME/x and \`${tag}_${i}\``).join("\n")}`;
		const runs = [stuck("first"), stuck("second")];
		for (let i = 0; i < 2; i++) for (const run of runs) flattenThinkingCode(run, 100);
		const again = drawnBy(() => {
			for (let i = 0; i < 3; i++) for (const run of runs) flattenThinkingCode(run, 100);
		});
		assert.equal(again, 0, "each reply delta re-renders both runs");
	});

	it("counts a text's result as final after a few calls, however many blocks are left to settle", () => {
		const stuck = (tag: string) => Array.from({ length: 200 }, (_, i) => `- ${tag} ${i} uses $HOME/x and \`${tag}_${i}\``).join("\n");
		const text = `${Array.from({ length: 12 }, (_, i) => stuck(`s${i}`)).join("\n\n")}\n\nThen open \`b.ts\`.`;
		const drawn = Array.from({ length: 10 }, () => drawnBy(() => flattenThinkingCode(text, 100)));
		assert.ok(drawn.slice(0, 8).every((n) => n > 0), "each of the first calls settles one more stuck block");
		assert.deepEqual(drawn.slice(8), [0, 0]);
	});

	it("while thinking streams, only the growing last block is settled again", () => {
		// Earlier blocks whose spans fail the all-at-once check: `$HOME` opens math beside them.
		const hard = (n: number) => Array.from({ length: 6 }, (_, i) => `- ${n}.${i} reads $HOME and calls \`fn_${n}_${i}()\``).join("\n");
		const earlier = `${hard(1)}\n\n${hard(2)}\n\n${hard(3)}\n\nThen \`tail.ts\``;
		flattenThinkingCode(earlier, 100);
		const update = drawnBy(() => flattenThinkingCode(`${earlier} grows`, 100));
		const fresh = drawnBy(() => flattenThinkingCode(`${hard(4)}\n\n${hard(5)}\n\n${hard(6)}\n\nThen \`tail.ts\` grows`, 100));
		assert.ok(update < fresh / 2, `an update drew ${update} characters, a fresh text ${fresh}`);
	});

	it("bounds the work for a block full of spans that cannot flatten", () => {
		// Each item's lone $ opens pending math that pi prints raw, so every span in this one block fails.
		const list = Array.from({ length: 200 }, (_, i) => `- item ${i} uses $HOME/x and \`a_${i}\``).join("\n");
		const started = performance.now();
		assert.equal(flattenThinkingCode(list, 100), list);
		assert.ok(performance.now() - started < 250, "one call stays well under a frame budget's worth of stalls");
	});

	it("never rewrites code-block text, even where the block sits inside a list, a quote or CRLF text", () => {
		assert.equal(flattenThinkingCode("- a\n  ```\n  `x_y`\n  ```\n- `x_y` b"), "- a\n  ```\n  `x_y`\n  ```\n- x\\_y b");
		assert.equal(flattenThinkingCode("> a\n> ```\n> `x_y`\n> ```\n> `x_y` b"), "> a\n> ```\n> `x_y`\n> ```\n> x\\_y b");
		assert.equal(flattenThinkingCode("a\r\n```\r\n`x_y`\r\n```\r\n`x_y` z\r\n"), "a\r\n```\r\n`x_y`\r\n```\r\nx\\_y z\r\n");
		const table = "| h |\n|---|\n| `a\\|b` |\n\n```\n`a\\|b`\n```";
		assert.equal(flattenThinkingCode(table), table);
	});

	it("checks the whole text when a construct reaches across blank lines", () => {
		assert.equal(flattenThinkingCode("$$\n\n`a_b`\n\n$$\n\nand `c.d`"), "$$\n\n`a_b`\n\n$$\n\nand c\\.d");
		assert.equal(flattenThinkingCode("- a\n\n      ```\n      `x_y`\n\n      ```\n- `x_y` b"), "- a\n\n      ```\n      `x_y`\n\n      ```\n- x\\_y b");
	});

	it("takes on the emphasis or heading around a flattened span", () => {
		assert.equal(flattenThinkingCode("**see `x.y`** and `z`"), "**see x\\.y** and z");
		assert.equal(flattenThinkingCode("Fix `a\n# Heading `b`"), "Fix `a\n# Heading b");
	});

	it("renders through pi's Markdown as the span's exact characters, never as code", () => {
		const marked = (tag: string) => (text: string) => `<${tag}>${text}</${tag}>`;
		const theme = new Proxy({} as MarkdownTheme, { get: (_t, key) => (key === "highlightCode" || key === "codeBlockIndent" ? undefined : marked(String(key))) });
		const visible = (markdown: string) =>
			new Markdown(markdown, 0, 0, theme)
				.render(200)
				.join("\n")
				.replace(/\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07/g, "")
				.trim();
		const spans = ["$HOME/x", "$a+$b$", "a_b*c*", "<div>", "https://x.io/a", "![i](u)", "\\(y\\)", "f(x)[0]", "~~s~~", "&amp;", "#1", "1. x", "a|b", "x `y` z", "**b**", "\\[m\\]"];
		for (const span of spans) {
			const fence = span.includes("`") ? "``" : "`";
			const out = visible(flattenThinkingCode(`see ${fence} ${span} ${fence} end`));
			assert.equal(out, `see ${span} end`, `span ${JSON.stringify(span)}`);
		}
		assert.equal(visible(flattenThinkingCode("`# x` and `- y`")), "# x and - y");
	});
});
