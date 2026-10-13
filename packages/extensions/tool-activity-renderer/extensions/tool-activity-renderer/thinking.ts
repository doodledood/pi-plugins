import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

/**
 * ASCII punctuation that pi's Markdown could read as syntax once a code span's backticks are gone.
 * `(`, `[` and `|` stay bare: pi reads `\(` and `\[` as LaTeX openers, and `\|` changes a table row's
 * cell count. Whatever this set gets wrong, `flattenThinkingCode` checks against pi's renderer.
 */
const SYNTAX = /[!"#$%&'*+,\-./:;<=>?@\\\]^_`{}~)]/g;

/** A code span in the source and the escaped plain text that would replace it. */
interface Span {
	readonly start: number;
	readonly end: number;
	readonly plain: string;
}

/** A code span's content as CommonMark reads it: one padding space goes from each side. */
function spanContent(inner: string): string {
	return /^ .*[^ ].* $/.test(inner) ? inner.slice(1, -1) : inner;
}

/**
 * Candidate code spans: CommonMark backtick runs, an opening run closed by the next run of the same
 * length on the same line. A span that wraps onto the next line stays code; keeping candidates to one
 * line stops a stray backtick from pairing with the opener of a real span below it. This scan knows
 * nothing of code blocks, links or math; a candidate that is not really a plain span is caught by the
 * render check in `flattenThinkingCode` and stays as it is.
 */
function codeSpans(source: string): Span[] {
	const spans: Span[] = [];
	let at = 0;
	while (at < source.length) {
		if (source[at] === "\\") {
			at += 2;
			continue;
		}
		if (source[at] !== "`") {
			at++;
			continue;
		}
		let open = at;
		while (source[open] === "`") open++;
		const ticks = open - at;
		const lineEnd = source.indexOf("\n", open);
		const limit = lineEnd < 0 ? source.length : lineEnd;
		let close = source.indexOf("`", open);
		while (close !== -1 && close < limit) {
			let run = close;
			while (source[run] === "`") run++;
			if (run - close === ticks) break;
			close = source.indexOf("`", run);
		}
		if (close === -1 || close >= limit) {
			at = open;
			continue;
		}
		const plain = spanContent(source.slice(open, close)).replace(SYNTAX, (char) => `\\${char}`);
		spans.push({ start: at, end: close + ticks, plain });
		at = close + ticks;
	}
	return spans;
}

function rewrite(source: string, spans: readonly Span[]): string {
	let out = "";
	let cursor = 0;
	for (const span of spans) {
		out += source.slice(cursor, span.start) + span.plain;
		cursor = span.end;
	}
	return out + source.slice(cursor);
}

/**
 * The render a flattened span must match. Text carries nearly everything: emphasis, headings, lists,
 * tables, math and code blocks all show or consume characters, so a rewrite that changes one changes the
 * text. Links are the exception (`www.x.io` is a link with the same characters), so they are tagged.
 * Every other style is a bare SGR pair that is stripped before comparing: styled text wraps the way pi
 * really wraps it, and a flattened span may take on the bold or heading around it.
 */
const PROBE = new Proxy({} as MarkdownTheme, {
	get: (_theme, key) => {
		if (key === "highlightCode" || key === "codeBlockIndent") return undefined;
		if (key === "link" || key === "linkUrl") return (text: string) => `<${key}>${text}</${key}>`;
		return (text: string) => `\x1b[7m${text}\x1b[27m`;
	},
});
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * What pi's own Markdown renderer shows for thinking `source` at `width`: its text, line breaks and links.
 * Spaces at a line's edges don't count: at a soft wrap pi carries the space after a styled span onto the
 * next line (` dd`) but drops it after plain text (`dd`), so a span ending at the wrap column would
 * otherwise never pass, and whether it receded would depend on the terminal's width.
 */
function rendered(source: string, width: number): string {
	return new Markdown(source, 0, 0, PROBE, { italic: true })
		.render(width)
		.map((line) => line.replace(SGR, "").trimEnd().replace(/^ /, ""))
		.join("\n");
}

/**
 * How much text one call may render while narrowing down spans that fail the check, about 7 ms of
 * rendering. Pi re-runs the transformer on every streamed update, so a block full of failing spans must
 * not stall the UI; past the budget the spans still undecided keep their code color.
 */
const RENDER_BUDGET = 50_000;

/**
 * The spans whose rewrite leaves pi's render of `source` unchanged. All spans are tried at once, then in
 * halves, so one awkward span costs a few extra renders and the rest still flatten.
 */
function settle(source: string, spans: readonly Span[], width: number, budget: { left: number }): Span[] {
	if (!spans.length || budget.left < 0) return [];
	const target = rendered(source, width);
	const accepted = new Set<Span>();
	const accept = (group: readonly Span[]) => {
		budget.left -= source.length;
		if (budget.left < 0) return;
		const trial = spans.filter((span) => accepted.has(span) || group.includes(span));
		if (rendered(rewrite(source, trial), width) === target) {
			for (const span of group) accepted.add(span);
			return;
		}
		if (group.length === 1) return;
		const half = Math.ceil(group.length / 2);
		accept(group.slice(0, half));
		accept(group.slice(half));
	};
	accept(spans);
	return spans.filter((span) => accepted.has(span));
}

/** `source` cut at each blank line outside a fenced code block. */
function blocks(source: string): string[] {
	const out: string[] = [];
	let start = 0;
	let fence: string | undefined;
	for (let at = 0; at < source.length; ) {
		const next = source.indexOf("\n", at);
		const end = next < 0 ? source.length : next + 1;
		const line = source.slice(at, end);
		// A backtick fence's info string has no backticks, so "```x``` is inline" opens nothing.
		const marker = /^ {0,3}(`{3,}(?![^`]*`)|~{3,})/.exec(line)?.[1];
		if (fence) {
			if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined;
		} else if (marker) fence = marker;
		else if (!line.trim()) {
			out.push(source.slice(start, end));
			start = end;
		}
		at = end;
	}
	return [...out, source.slice(start)];
}

/**
 * Settled blocks by width and text. While thinking streams, every update re-runs the transformer over
 * the whole text, but only its last block is new.
 */
const settledBlocks = new Map<string, string>();

function flattenBlock(block: string, width: number, budget: { left: number }): string {
	const key = `${width}\n${block}`;
	const known = settledBlocks.get(key);
	if (known !== undefined) return known;
	const flat = rewrite(block, settle(block, codeSpans(block), width, budget));
	if (budget.left < 0) return flat;
	if (settledBlocks.size >= 512) settledBlocks.clear();
	settledBlocks.set(key, flat);
	return flat;
}

/**
 * Thinking Markdown with its inline code spans turned into plain text, so a span takes the thinking
 * block's own color and italics instead of the bright code color it shares with replies.
 *
 * A span is rewritten only when pi's renderer then shows the text at `width` exactly as before,
 * character for character and link for link. That one check is what keeps code blocks, links, math,
 * emphasis and tables from changing, however the span sits among them. The common case, where every span
 * flattens cleanly, costs two renders. Otherwise spans are settled block by block, one render of the
 * whole confirms the result, and if a construct reaching across blocks makes it differ, the spans are
 * settled against the whole text.
 */
export function flattenThinkingCode(source: string, width = 200): string {
	const spans = codeSpans(source);
	if (!spans.length) return source;
	const target = rendered(source, width);
	const all = rewrite(source, spans);
	if (rendered(all, width) === target) return all;
	const budget = { left: RENDER_BUDGET };
	const blockwise = blocks(source)
		.map((block) => flattenBlock(block, width, budget))
		.join("");
	if (rendered(blockwise, width) === target) return blockwise;
	return budget.left < 0 ? source : rewrite(source, settle(source, spans, width, budget));
}

/**
 * Thinking stays beneath the reply: its code spans draw in the thinking tone, not the code color.
 * Pi keeps one Markdown transformer per extension and the last registration wins, so this is the
 * renderer's only call to `registerMarkdownTransformer`; any other rewrite has to compose in here.
 */
export function registerQuietThinking(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((text, context) => (context.messageType === "assistant-thinking" ? flattenThinkingCode(text, context.availableWidth) : text));
}
