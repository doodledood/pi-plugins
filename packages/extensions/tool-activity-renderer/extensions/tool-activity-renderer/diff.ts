import type { Color, Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { blend, paint, type ThemeLike, tones } from "./palette.ts";
import { cellText } from "./text.ts";

interface DiffLine {
	sign: "+" | "-" | " ";
	lineNumber: string;
	content: string;
	/** [start, end) of the span that changed against the paired line, when the line has a pair. */
	changed?: readonly [number, number];
}

/** Pi's edit diff lines look like `+ 12 text` / `- 12 text` / `  12 text`. */
function parseDiffLine(raw: string): DiffLine | undefined {
	const match = raw.match(/^([+\- ])(\s*\d*)\s(.*)$/);
	if (!match) return undefined;
	return { sign: (match[1] ?? " ") as DiffLine["sign"], lineNumber: (match[2] ?? "").trim(), content: cellText(match[3] ?? "") };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

const WORD = /[\p{L}\p{N}_]/u;
const isWord = (char: string | undefined) => char !== undefined && WORD.test(char);

/**
 * The span of `a` that differs from `b`: their common prefix and suffix trimmed, then widened to
 * whole words, so `sum` → `subtotal` marks both words rather than `m` and `btotal`. Every widening
 * test reads both strings the same way, so the two sides of a pair always agree.
 */
function changedSpan(a: string, b: string): readonly [number, number] | undefined {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	while (start > 0 && isWord(a[start - 1]) && (isWord(a[start]) || isWord(b[start]))) start--;
	while (endA < a.length && isWord(a[endA]) && (isWord(a[endA - 1]) || isWord(b[endB - 1]))) {
		endA++;
		endB++;
	}
	// Never split a surrogate pair: widen the span to whole code points.
	if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
	if (endA < a.length && isLowSurrogate(a.charCodeAt(endA))) endA++;
	// A line that changed end to end has no stable context to set the change against.
	if (start === 0 && endA === a.length) return undefined;
	return endA > start ? [start, endA] : undefined;
}

/**
 * Pair each block of removed lines with the added block right after it, line by line, and mark the
 * span that actually changed in each — so a one-word edit lights up one word, not the whole line.
 */
function pairChanges(lines: DiffLine[]): DiffLine[] {
	const out = lines.map((line) => ({ ...line }));
	let i = 0;
	while (i < out.length) {
		if (out[i]?.sign !== "-") {
			i++;
			continue;
		}
		const removedStart = i;
		while (out[i]?.sign === "-") i++;
		const addedStart = i;
		while (out[i]?.sign === "+") i++;
		const pairs = Math.min(addedStart - removedStart, i - addedStart);
		for (let p = 0; p < pairs; p++) {
			const removed = out[removedStart + p];
			const added = out[addedStart + p];
			if (!removed || !added) continue;
			removed.changed = changedSpan(removed.content, added.content);
			added.changed = changedSpan(added.content, removed.content);
		}
	}
	return out;
}

/** A diff drawn as tinted bands under its tool row, the changed span of each paired line emphasized. */
export class GraphiteDiff implements Component {
	private readonly lines: DiffLine[];

	/** Pairs changes across every line before keeping the first `shown`, so a cut never orphans a pair. */
	constructor(
		rawLines: readonly string[],
		shown: number,
		private readonly hiddenHint: string | undefined,
		private readonly theme: ThemeLike,
	) {
		const parsed = rawLines.map((raw) => parseDiffLine(raw) ?? { sign: " " as const, lineNumber: "", content: cellText(raw) });
		this.lines = pairChanges(parsed).slice(0, shown);
	}

	render(width: number): string[] {
		const t = tones(this.theme);
		const bands = {
			"+": { bg: t.addedBg, ink: t.added, text: t.text, gutter: blend(t.added, t.dim, 0.35), marker: "+" },
			"-": { bg: t.removedBg, ink: t.removed, text: t.soft, gutter: blend(t.removed, t.dim, 0.35), marker: "−" },
			" ": { bg: undefined, ink: t.faint, text: t.muted, gutter: t.faint, marker: " " },
		} as const;
		const gutterWidth = Math.max(3, ...this.lines.map((line) => line.lineNumber.length));
		const inner = Math.max(1, width - 3);
		const rows = this.lines.map((line) => {
			const band = bands[line.sign];
			const strong = band.bg ? blend(band.bg, band.ink, 0.28) : undefined;
			const cell = (text: string, fg: Color, emphasis = false) => (text ? this.theme.style(text, { fg, bg: emphasis ? strong : band.bg }) : "");
			const [from, to] = line.changed ?? [line.content.length, line.content.length];
			const body =
				cell(`${line.lineNumber.padStart(gutterWidth)} `, band.gutter) +
				cell(`${band.marker} `, band.ink) +
				cell(line.content.slice(0, from), band.text) +
				cell(line.content.slice(from, to), band.text, true) +
				cell(line.content.slice(to), band.text);
			const fitted = truncateToWidth(body, inner, "…");
			const fill = band.bg ? this.theme.style(" ".repeat(Math.max(0, inner - visibleWidth(fitted))), { bg: band.bg }) : "";
			return `   ${fitted}${fill}`;
		});
		if (this.hiddenHint) rows.push(`   ${paint(this.theme, this.hiddenHint, t.dim)}`);
		// Every row, the hint included, must fit: pi stops the TUI on a line wider than the terminal.
		return rows.map((row) => truncateToWidth(row, width, "…"));
	}

	invalidate(): void {}
}
