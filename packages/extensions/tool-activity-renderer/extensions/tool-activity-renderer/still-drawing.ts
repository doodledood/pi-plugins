import { getCapabilities } from "@earendil-works/pi-tui";
import type { ThemeLike } from "./palette.ts";
import { isStill, type RowHead, renderFoldedRun, renderRow, runColumn } from "./row.ts";

/**
 * Everything a drawing is made from. A painter receives only these and the time, so an input a
 * drawing depends on is part of the key that decides when the drawing is reused.
 */
export interface DrawingInputs {
	readonly heads: readonly RowHead[];
	readonly theme: ThemeLike;
	readonly width: number;
	/** The hint a folded run shows for opening it. */
	readonly hint?: string;
}

export type Painter = (inputs: DrawingInputs, now: number) => string[];

/** Each head as its own row. */
export const paintRows: Painter = ({ heads, theme, width }, now) => heads.flatMap((head) => renderRow(head, theme, width, now));

/** An exploratory run drawn as its member rows, sharing one column. */
export const paintPackedRun: Painter = ({ heads, theme, width }, now) => {
	const column = runColumn(heads);
	return heads.flatMap((head) => renderRow(head, theme, width, now, column));
};

/** An all-success exploratory run folded into one line. */
export const paintFoldedRun: Painter = ({ heads, theme, width, hint }, now) => [renderFoldedRun(heads, theme, width, now, hint ?? "")];

interface Drawn {
	readonly paint: Painter;
	/** The inputs as drawn, each head copied: a head is drawn the same while every field is the same value. */
	readonly inputs: DrawingInputs;
	/** Targets read the terminal's hyperlink support from pi-tui rather than from the inputs. */
	readonly hyperlinks: boolean;
	readonly lines: string[];
}

/**
 * The last drawing of one or more rows, reused while it cannot have changed. pi's fullscreen TUI
 * draws the whole transcript on every frame and keeps no lines between frames, so without this
 * every finished row would be painted again on every frame, 30 times a second while anything
 * animates, for the rest of the session.
 *
 * A drawing is reused only while every head is still (see isStill), by the same painter, from
 * inputs equal field for field.
 */
export class StillDrawing {
	private drawn: Drawn | undefined;

	draw(paint: Painter, inputs: DrawingInputs, now: number): string[] {
		const drawn = this.drawn;
		const hyperlinks = getCapabilities().hyperlinks;
		const still = inputs.heads.every((head) => isStill(head, now));
		if (still && drawn && drawn.paint === paint && drawn.hyperlinks === hyperlinks && sameInputs(drawn.inputs, inputs)) {
			return drawn.lines;
		}
		const lines = paint(inputs, now);
		this.drawn = still ? { paint, inputs: { ...inputs, heads: inputs.heads.map((head) => ({ ...head })) }, hyperlinks, lines } : undefined;
		return lines;
	}

	/** Drop the reused drawing; the next draw() paints fresh. */
	clear(): void {
		this.drawn = undefined;
	}
}

function sameInputs(drawn: DrawingInputs, current: DrawingInputs): boolean {
	return sameFields(drawn, current, (key) => (key === "heads" ? sameHeads(drawn.heads, current.heads) : drawn[key] === current[key]));
}

function sameHeads(drawn: readonly RowHead[], current: readonly RowHead[]): boolean {
	return drawn.length === current.length && drawn.every((head, index) => sameFields(head, current[index], (key) => head[key] === current[index]?.[key]));
}

/** True when both records have the same keys and `same` holds for each. */
function sameFields<T extends object>(drawn: T, current: T | undefined, same: (key: keyof T) => boolean): boolean {
	if (!current) return false;
	const keys = Object.keys(drawn) as (keyof T)[];
	return keys.length === Object.keys(current).length && keys.every(same);
}
