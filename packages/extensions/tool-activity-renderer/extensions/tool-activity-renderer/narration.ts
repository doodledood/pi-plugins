import { blocks, codeSpans, flattenThinkingCode, probeLines } from "./thinking.ts";

/**
 * Narration: the text of an assistant message that also calls a tool, the running commentary between
 * tool calls. The reply is the text of the message that calls none. Pi draws both at reply brightness,
 * so narration that reads like reasoning sits bright among receded rows and gray thinking; this module
 * draws it in the thinking tone instead, the moment its message's tool call is known.
 */

/** The slice of a pi message this module reads. */
interface MessageLike {
	role?: unknown;
	content?: unknown;
}

interface Block {
	type?: unknown;
	text?: unknown;
}

function assistantBlocks(message: unknown): Block[] | undefined {
	const { role, content } = (message ?? {}) as MessageLike;
	return role === "assistant" && Array.isArray(content) ? (content as Block[]) : undefined;
}

/**
 * Which assistant texts are narration. Pi's Markdown transformer sees only a text, never its message,
 * so texts are told apart by content: the trimmed text, as pi passes it. A text seen both as narration
 * and as a settled reply stays a reply, so a reply is never drawn quiet.
 */
export class Narration {
	private readonly narrated = new Set<string>();
	private readonly replies = new Set<string>();

	/**
	 * Record a message's texts. `settled` is false while it streams: a streaming message with no tool
	 * call yet may still turn out to be narration, so its texts are not taken as replies until it ends.
	 */
	ingest(message: unknown, settled: boolean): void {
		const content = assistantBlocks(message);
		if (!content) return;
		const calls = content.some((block) => block.type === "toolCall");
		if (!calls && !settled) return;
		const into = calls ? this.narrated : this.replies;
		for (const block of content) {
			if (block.type !== "text" || typeof block.text !== "string") continue;
			const text = block.text.trim();
			if (text) into.add(text);
		}
	}

	/** Start over from the messages of the branch pi is about to draw. */
	readBranch(messages: readonly unknown[]): void {
		this.narrated.clear();
		this.replies.clear();
		for (const message of messages) this.ingest(message, true);
	}

	has(text: string): boolean {
		const key = text.trim();
		return this.narrated.has(key) && !this.replies.has(key);
	}
}

/** A Markdown fence opener or closer, as `blocks` in thinking.ts reads one. */
const FENCE = /^ {0,3}(`{3,}(?![^`]*`)|~{3,})/;

/** A table's delimiter row, which must keep its exact shape. */
const DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The block markers a line may open with: indentation, quote markers, list markers, a heading's hashes. */
const LINE_MARKERS = /^(?:[ \t]*(?:>[ \t]?|[-*+][ \t]+|\d{1,9}[.)][ \t]+|#{1,6}[ \t]+))*[ \t]*/;

/** Emphasis and strikethrough delimiters, whose meaning depends on the characters beside them. */
const DELIMITER = /[*_~]/;

/**
 * Where the tone goes for the word starting at `at`. It goes right at the word, never before the space:
 * pi carries a space that follows a style change onto the next line when it wraps there. The sequence
 * ends in a letter, and CommonMark decides whether a `*`, `_` or `~` run opens from the characters on
 * either side of it, so for a word that opens with such a run the tone goes just inside it, where
 * `**(x)**` and `_x_` still open. A link keeps its own color: the sequence's `[` would pair with the
 * link's `]` if it went inside the brackets.
 */
function tonePoint(content: string, at: number): number {
	let point = at;
	while (DELIMITER.test(content[point] ?? "")) point++;
	return point;
}

/**
 * `tone` before every stretch of a line's text. Pi's renderer resets the foreground after each inline
 * construct it colors (a code span, a link) and the italics after emphasis, and starts every rendered
 * line afresh, so one sequence per line would fade back to the reply color mid-line. Instead it goes at
 * the start of each line's text and at each word after a space (see `tonePoint`), so the spaces
 * around words, including the two that make a hard line break, stay as they are. Code blocks and code
 * spans keep their own color, and a table's delimiter row its shape.
 */
function toneLines(source: string, tone: string): string {
	let fence: string | undefined;
	return source
		.split("\n")
		.map((line) => {
			const marker = FENCE.exec(line)?.[1];
			if (fence) {
				if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = undefined;
				return line;
			}
			if (marker) {
				fence = marker;
				return line;
			}
			if (DELIMITER_ROW.test(line)) return line;
			const start = LINE_MARKERS.exec(line)?.[0].length ?? 0;
			const content = line.slice(start);
			if (!content.trim()) return line;
			const spans = codeSpans(content);
			const inSpan = (at: number) => spans.some((span) => at > span.start && at < span.end);
			const textEnd = content.trimEnd().length;
			const points = new Set<number>();
			for (let at = 0; at < textEnd; at++) {
				const wordStart = at === 0 || (content[at - 1] === " " && content[at] !== " ");
				if (!wordStart) continue;
				const point = tonePoint(content, at);
				if (!inSpan(point)) points.add(point);
			}
			let out = "";
			for (let at = 0; at <= content.length; at++) out += (points.has(at) ? tone : "") + (content[at] ?? "");
			return line.slice(0, start) + out;
		})
		.join("\n");
}

/**
 * What a reply's Markdown shows at `width`, line for line. Exact, spaces included: unlike thinking's
 * check (`rendered` in thinking.ts), a space the tone moves across a wrap counts as a change.
 */
function shown(source: string, width: number): string {
	return probeLines(source, width).join("\n");
}

/** Toned `source` if pi then shows exactly what it showed without the tone; otherwise undefined. */
function toneChecked(source: string, tone: string, width: number): string | undefined {
	const toned = toneLines(source, tone);
	if (toned === source) return source;
	return shown(toned, width) === shown(source, width) ? toned : undefined;
}

/**
 * Narration Markdown drawn in `sgr`, the thinking tone. Inline code follows the thinking rule first
 * (`flattenThinkingCode`), then the tone goes in front of the text (see `toneLines`). Pi's own
 * renderer checks the result the way it checks flattened code: the tone is kept only where pi then
 * shows the same characters, links and line breaks as without it, first for the whole text, then
 * block by block, where a block that would change keeps the reply color. The worst case is narration
 * drawn as before, never a reply drawn differently.
 */
export function muteNarration(source: string, sgr: string, width = 200): string {
	const flat = flattenThinkingCode(source, width);
	const key = `${width}\n${sgr}\n${flat}`;
	const known = mutedTexts.get(key);
	if (known !== undefined) {
		mutedTexts.delete(key);
		mutedTexts.set(key, known);
		return known;
	}
	const muted = settleTone(flat, sgr, width);
	if (mutedTexts.size >= MUTED_TEXTS_KEPT) mutedTexts.delete(mutedTexts.keys().next().value!);
	mutedTexts.set(key, muted);
	return muted;
}

function settleTone(flat: string, tone: string, width: number): string {
	const whole = toneChecked(flat, tone, width);
	if (whole !== undefined) return whole;
	const blockwise = blocks(flat)
		.map((block) => toneChecked(block, tone, width) ?? block)
		.join("");
	return blockwise !== flat && shown(blockwise, width) === shown(flat, width) ? blockwise : flat;
}

/**
 * Recently muted texts by width, tone and text, least recently used first. Pi rebuilds every text of
 * the streaming message on each update, and every narration on screen when it redraws the chat.
 */
const mutedTexts = new Map<string, string>();

/** A screenful of narration at a couple of widths, and then some. */
const MUTED_TEXTS_KEPT = 256;
