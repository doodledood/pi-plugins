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
