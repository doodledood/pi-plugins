import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { blend, breathe, easeOut, formatDuration, paint, shimmer, type ThemeLike, tones } from "./palette.ts";

export type ToolKind = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

type Outcome = "pending" | "running" | "success" | "error";

export interface TargetPart {
	text: string;
	/** primary: what the eye should land on; secondary: context such as a directory or scope; invalid: a bad argument. */
	role: "primary" | "secondary" | "invalid";
	/** Absolute file URL to hyperlink the part to, when the terminal supports OSC 8. */
	href?: string;
	/** A directory that may lose its leading segments (`…/tail/`) when the row is too narrow. */
	elidable?: boolean;
}

export interface MetaPart {
	text: string;
	role: "result" | "added" | "removed" | "success" | "warning" | "error";
}

/** Everything a tool row needs to draw its head line and the few detail lines under it. */
export interface RowHead {
	kind: ToolKind;
	outcome: Outcome;
	target: TargetPart[];
	meta: MetaPart[];
	/** Set only for executions this process watched; rows restored from history carry no timings. */
	startedAt?: number;
	endedAt?: number;
	/** Short lines shown under the head: an error message, or the tail of a running command. */
	detail: string[];
	detailTone: "error" | "output";
	expanded: boolean;
}

const VERBS: Record<ToolKind, readonly [present: string, past: string]> = {
	read: ["Reading", "Read"],
	grep: ["Searching", "Searched"],
	find: ["Finding", "Found"],
	ls: ["Listing", "Listed"],
	bash: ["Running", "Ran"],
	edit: ["Editing", "Edited"],
	write: ["Writing", "Wrote"],
};

/** Every built-in tool this renderer draws, in one place: the verb table is the source of truth. */
export const TOOL_KINDS = Object.keys(VERBS) as ToolKind[];

export function isToolKind(name: string): name is ToolKind {
	return Object.hasOwn(VERBS, name);
}

export function presentVerb(kind: ToolKind): string {
	return VERBS[kind][0];
}

const VERB_COLUMN = 10;
/** How long a finished row stays at full brightness before it starts to recede, and how long the recede takes. */
const RECEDE_DELAY_MS = 400;
const RECEDE_MS = 1500;
/** The glyph flashes bright for this long when a row lands. */
const LAND_FLASH_MS = 240;

export function isLive(outcome: Outcome): boolean {
	return outcome === "pending" || outcome === "running";
}

/** True while a finished row is still fading and needs redraws. */
export function isFading(head: Pick<RowHead, "outcome" | "endedAt">, now: number): boolean {
	return head.outcome === "success" && head.endedAt !== undefined && now < head.endedAt + RECEDE_DELAY_MS + RECEDE_MS;
}

/**
 * How far a row has receded, 0 (just happened) to 1 (history). Failures never recede: they stay as
 * loud as when they happened. Rows restored from history start fully receded.
 */
function recession(head: Pick<RowHead, "outcome" | "endedAt">, now: number): number {
	if (head.outcome !== "success") return 0;
	if (head.endedAt === undefined) return 1;
	return easeOut((now - head.endedAt - RECEDE_DELAY_MS) / RECEDE_MS);
}

/** Finished work quicker than this shows no duration: "0.0s" is noise, not information. */
const MIN_SHOWN_DURATION_MS = 100;

function duration(head: Pick<RowHead, "startedAt" | "endedAt">, now: number): string | undefined {
	if (head.startedAt === undefined) return undefined;
	const elapsed = (head.endedAt ?? now) - head.startedAt;
	if (head.endedAt !== undefined && elapsed < MIN_SHOWN_DURATION_MS) return undefined;
	return formatDuration(elapsed);
}

function glyph(head: Pick<RowHead, "outcome" | "endedAt">, theme: ThemeLike, now: number, k: number): string {
	const t = tones(theme);
	switch (head.outcome) {
		case "pending":
			return paint(theme, "●", t.faint);
		case "running":
			return paint(theme, "●", breathe(t.dim, t.accent, now));
		case "error":
			return paint(theme, "✕", t.error);
		case "success": {
			const landing = head.endedAt !== undefined && now - head.endedAt < LAND_FLASH_MS;
			return paint(theme, "●", landing ? t.text : blend(t.success, blend(t.success, t.dim, 0.6), k));
		}
	}
}

function verb(head: RowHead, theme: ThemeLike, now: number, k: number): string {
	const t = tones(theme);
	const [present, past] = VERBS[head.kind];
	const pad = " ".repeat(Math.max(1, VERB_COLUMN - present.length));
	const padPast = " ".repeat(Math.max(1, VERB_COLUMN - past.length));
	if (head.outcome === "running") return shimmer(theme, present, t.muted, t.text, now) + pad;
	if (head.outcome === "pending") return paint(theme, present, t.muted) + pad;
	if (head.outcome === "error") return paint(theme, past, t.error) + padPast;
	return paint(theme, past, blend(t.soft, t.muted, k)) + padPast;
}

function target(parts: readonly TargetPart[], theme: ThemeLike, k: number): string {
	const t = tones(theme);
	const links = getCapabilities().hyperlinks;
	return parts
		.map((part) => {
			const color = part.role === "invalid" ? t.error : part.role === "primary" ? blend(t.text, t.soft, k) : blend(t.muted, t.dim, k);
			const styled = paint(theme, part.text, color);
			return links && part.href ? hyperlink(styled, part.href) : styled;
		})
		.join("");
}

function meta(head: RowHead, theme: ThemeLike, now: number, k: number): string {
	const t = tones(theme);
	const colorFor: Record<MetaPart["role"], ReturnType<typeof blend>> = {
		result: blend(t.muted, t.dim, k),
		added: t.added,
		removed: t.removed,
		success: t.success,
		warning: t.warning,
		error: t.error,
	};
	const parts = head.meta.map((part) => paint(theme, part.text, colorFor[part.role]));
	const time = duration(head, now);
	if (time) parts.push(paint(theme, time, isLive(head.outcome) ? t.muted : t.dim));
	return parts.join("  ");
}

/** One row: ` ● Verb      target ……… result  0.3s`, the result column right-aligned to `width`. */
function renderHeadLine(head: RowHead, theme: ThemeLike, width: number, now: number): string {
	const k = recession(head, now);
	const prefix = ` ${glyph(head, theme, now, k)} ${verb(head, theme, now, k)}`;
	const right = meta(head, theme, now, k);
	const parts = fitTarget(head.target, leftBudget(right, width) - visibleWidth(prefix));
	return alignRight(prefix + target(parts, theme, k), right, width);
}

/** The narrowest width at which a row still carries its right-hand column. */
const MIN_LEFT_WIDTH = 16;

function rightColumnWidth(right: string, width: number): number {
	return right && visibleWidth(right) <= width - MIN_LEFT_WIDTH ? visibleWidth(right) : 0;
}

function leftBudget(right: string, width: number): number {
	const rightWidth = rightColumnWidth(right, width);
	return rightWidth > 0 ? width - rightWidth - 2 : width;
}

/** `left` then `right` flush to `width`; the left side truncates first, and the right column drops on very narrow rows. */
function alignRight(left: string, right: string, width: number): string {
	const rightWidth = rightColumnWidth(right, width);
	const budget = leftBudget(right, width);
	const fitted = visibleWidth(left) > budget ? truncateToWidth(left, budget, "…") : left;
	if (rightWidth === 0) return fitted;
	return `${fitted}${" ".repeat(Math.max(2, width - visibleWidth(fitted) - rightWidth))}${right}`;
}

/**
 * Shorten elidable directories from the left so the file name and range keep their place:
 * `packages/extensions/pkg/src/` becomes `…/pkg/src/`. Whatever still overflows is cut from the end.
 */
function fitTarget(parts: readonly TargetPart[], budget: number): readonly TargetPart[] {
	let overflow = parts.reduce((sum, part) => sum + visibleWidth(part.text), 0) - budget;
	if (overflow <= 0) return parts;
	return parts.map((part) => {
		if (!part.elidable || overflow <= 0) return part;
		const before = visibleWidth(part.text);
		const text = elideStart(part.text, before - overflow);
		overflow -= before - visibleWidth(text);
		return { ...part, text };
	});
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The tail of a directory path in at most `maxWidth` terminal cells, starting on a segment boundary
 * where one fits. With no room for even `…/`, the directory goes entirely so the file name keeps the space.
 */
function elideStart(dir: string, maxWidth: number): string {
	if (visibleWidth(dir) <= maxWidth) return dir;
	if (maxWidth < 3) return "";
	const parts = [...graphemes.segment(dir)].map((part) => part.segment);
	let tail = "";
	let used = 1; // the leading "…"
	for (let i = parts.length - 1; i >= 0; i--) {
		const cell = visibleWidth(parts[i] ?? "");
		if (used + cell > maxWidth) break;
		tail = (parts[i] ?? "") + tail;
		used += cell;
	}
	const boundary = tail.indexOf("/");
	if (boundary >= 0 && boundary < tail.length - 1) return `…/${tail.slice(boundary + 1)}`;
	return "…/";
}

/** The detail lines under a head, indented under the verb. */
function renderDetailLines(head: RowHead, theme: ThemeLike, width: number): string[] {
	const t = tones(theme);
	const color = head.detailTone === "error" ? t.error : t.dim;
	return head.detail.map((line) => truncateToWidth(`   ${paint(theme, line, color)}`, width, "…"));
}

export function renderRow(head: RowHead, theme: ThemeLike, width: number, now: number): string[] {
	return [renderHeadLine(head, theme, width, now), ...renderDetailLines(head, theme, width)];
}

/** What each exploratory kind counts as in the folded summary. This table defines which tools are exploratory. */
const FOLD_NOUNS = {
	read: { one: "file", many: "files" },
	grep: { one: "search", many: "searches" },
	find: { one: "search", many: "searches" },
	ls: { one: "listing", many: "listings" },
} as const satisfies Partial<Record<ToolKind, { one: string; many: string }>>;

type ExploreKind = keyof typeof FOLD_NOUNS;

/** Tools whose rows pack together and fold into one "Explored …" line. */
export function isExploreKind(name: string): name is ExploreKind {
	return Object.hasOwn(FOLD_NOUNS, name);
}

function foldNoun(kind: ToolKind): { one: string; many: string } {
	if (!isExploreKind(kind)) throw new Error(`tool-activity-renderer: ${kind} is not an exploratory tool`);
	return FOLD_NOUNS[kind];
}

/** `Explored 3 files · 1 search` — the line a finished exploratory run folds into. */
export function renderFoldedRun(members: readonly RowHead[], theme: ThemeLike, width: number, now: number, expandHint: string): string {
	const t = tones(theme);
	const timed = members.every((m) => m.startedAt !== undefined && m.endedAt !== undefined);
	const endedAt = timed ? Math.max(...members.map((m) => m.endedAt ?? 0)) : undefined;
	const startedAt = timed ? Math.min(...members.map((m) => m.startedAt ?? 0)) : undefined;
	const k = recession({ outcome: "success", endedAt }, now);
	// Keyed by the singular noun, so grep and find both count as searches.
	const counts = new Map<string, { many: string; count: number }>();
	for (const member of members) {
		const { one, many } = foldNoun(member.kind);
		counts.set(one, { many, count: (counts.get(one)?.count ?? 0) + 1 });
	}
	const body = [...counts]
		.map(([one, { many, count }]) => paint(theme, `${count} ${count === 1 ? one : many}`, blend(t.text, t.soft, k)))
		.join(paint(theme, " · ", t.dim));
	const label = paint(theme, "Explored", blend(t.soft, t.muted, k)) + " ".repeat(VERB_COLUMN - "Explored".length);
	const left = ` ${glyph({ outcome: "success", endedAt }, theme, now, k)} ${label}${body}${paint(theme, `   ${expandHint}`, t.faint)}`;
	const time = duration({ startedAt, endedAt }, now);
	const right = time ? paint(theme, time, t.dim) : "";
	return alignRight(left, right, width);
}
