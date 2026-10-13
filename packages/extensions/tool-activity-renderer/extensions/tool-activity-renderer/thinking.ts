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
 * length on the same line. A span broken across a source line stays code; keeping candidates to one
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

/** The width pi draws at, and one wide enough that the text's lines don't wrap. */
type Widths = { width: number; unwrapped: number };

/**
 * The widest the no-wrap view renders at. Pi pads every rendered line to the render width, so without a
 * cap one long line would make every line of the view that long.
 */
const UNWRAPPED_CAP = 2048;

function widths(source: string, width: number): Widths {
	// Pi keeps each source line break, so a rendered line outgrows its source line only by a list, quote
	// or table border, or by wide characters, tabs or tagged links. Where a line still wraps, past the
	// cap or for those reasons, a span next to the wrap stays code: the check only gets stricter.
	const longest = Math.max(...source.split("\n").map((line) => line.length));
	return { width, unwrapped: Math.max(width, Math.min(longest + 64, UNWRAPPED_CAP)) };
}

/**
 * What pi's own Markdown renderer shows for thinking `source`, in the two views a rewrite must leave
 * alone. At the width pi draws at, the visible characters in order: that is where structure depends on
 * width (a table too wide shows as source) and where links, math and code blocks show, but line breaks
 * there move spaces around without changing what is shown, because pi carries the space after a style
 * change across a wrap and flattening changes where styles change. Where nothing wraps, the exact text
 * with its spacing and line breaks.
 */
function rendered(source: string, at: Widths): string {
	const lines = (width: number) => new Markdown(source, 0, 0, PROBE, { italic: true }).render(width).map((line) => line.replace(SGR, ""));
	const shown = lines(at.width).join("").replace(/\s+/g, "");
	const spaced = lines(at.unwrapped).map((line) => line.trimEnd()).join("\n");
	return `${spaced}\n\0${shown}`;
}

/**
 * How much source text one call may check while narrowing down spans that fail. Pi re-runs the
 * transformer on every streamed update, so a block full of failing spans must not stall the UI; past the
 * budget the spans still undecided keep their code color. The few whole-text checks around it each cost
 * about as much as pi's own render of the text, which pi pays on every update anyway.
 */
const RENDER_BUDGET = 50_000;

/**
 * The spans whose rewrite leaves pi's render of `source` unchanged. All spans are tried at once, then in
 * halves, so one awkward span costs a few extra renders and the rest still flatten.
 */
function settle(source: string, spans: readonly Span[], at: Widths, budget: { left: number }): Span[] {
	if (!spans.length) return [];
	budget.left -= source.length;
	if (budget.left < 0) return [];
	const target = rendered(source, at);
	const accepted = new Set<Span>();
	const accept = (group: readonly Span[]) => {
		budget.left -= source.length;
		if (budget.left < 0) return;
		const trial = spans.filter((span) => accepted.has(span) || group.includes(span));
		if (rendered(rewrite(source, trial), at) === target) {
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
 * the whole text, but only its last block is new. A block the budget cut short is kept too, with its
 * undecided spans left as code, so the next update moves on to the blocks after it instead of spending
 * its budget on the same block again.
 */
const settledBlocks = new Map<string, string>();

/** Enough settled blocks for every paragraph of a long session's thinking at a couple of widths. */
const SETTLED_BLOCKS_KEPT = 4096;

/**
 * The text's last block, kept apart in a single slot. While thinking streams it grows on every update,
 * and caching each prefix would fill `settledBlocks` with entries that never hit; once thinking ends it
 * stops changing, while pi re-renders the message on every reply and tool-call delta, so it must hit.
 */
let lastBlock: { key: string; flat: string } | undefined;

/** `last` marks the text's last block, which goes to `lastBlock` instead of `settledBlocks`. */
function flattenBlock(block: string, width: number, budget: { left: number }, last: boolean): string {
	const key = `${width}\n${block}`;
	const known = last ? (lastBlock?.key === key ? lastBlock.flat : undefined) : settledBlocks.get(key);
	if (known !== undefined) return known;
	if (budget.left < 0) return block;
	const flat = rewrite(block, settle(block, codeSpans(block), widths(block, width), budget));
	if (last) {
		lastBlock = { key, flat };
		return flat;
	}
	if (settledBlocks.size >= SETTLED_BLOCKS_KEPT) settledBlocks.delete(settledBlocks.keys().next().value!);
	settledBlocks.set(key, flat);
	return flat;
}

/**
 * Thinking Markdown with its inline code spans turned into plain text, so a span takes the thinking
 * block's own color and italics instead of the bright code color it shares with replies.
 *
 * A span is rewritten only when pi's renderer then shows the text as before, character for character
 * and link for link, both at `width` and where nothing wraps (see `rendered`). That one check is what
 * keeps code blocks, links, math, emphasis and tables from changing, however the span sits among them.
 * The common case, where every span flattens cleanly, costs two checks: the original and the rewrite.
 * Otherwise spans are settled block by block, one check of the whole confirms the result, and if a
 * construct reaching across blocks makes it differ, the spans are settled against the whole text.
 */
export function flattenThinkingCode(source: string, width = 200): string {
	const spans = codeSpans(source);
	if (!spans.length) return source;
	const at = widths(source, width);
	const target = rendered(source, at);
	const all = rewrite(source, spans);
	if (rendered(all, at) === target) return all;
	const budget = { left: RENDER_BUDGET };
	const parts = blocks(source);
	const blockwise = parts.map((block, index) => flattenBlock(block, width, budget, index === parts.length - 1)).join("");
	if (blockwise !== source && rendered(blockwise, at) === target) return blockwise;
	return budget.left < 0 ? source : rewrite(source, settle(source, spans, at, budget));
}

/**
 * Thinking stays beneath the reply: its code spans draw in the thinking tone, not the code color.
 * Pi keeps one Markdown transformer per extension and the last registration wins, so this is the
 * renderer's only call to `registerMarkdownTransformer`; any other rewrite has to compose in here.
 */
export function registerQuietThinking(pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer((text, context) => (context.messageType === "assistant-thinking" ? flattenThinkingCode(text, context.availableWidth) : text));
}
