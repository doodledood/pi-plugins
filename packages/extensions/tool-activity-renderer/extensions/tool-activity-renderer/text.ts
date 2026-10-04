// Escape sequences: CSI; OSC (BEL- or ST-terminated); DCS/SOS/PM/APC strings; then every other
// ESC form (intermediates plus a final byte, e.g. `ESC ( B`, `ESC =`, `ESC 7`).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]*\x1b\\|\x1b[\x20-\x2f]*[\x30-\x7e]/g;
// Control characters other than tab; all single code units, so surrogate pairs survive.
const CONTROL = /[\x00-\x08\x0A-\x1F\x7F]/g;

/**
 * One line as fixed-width terminal cells, the single rule for anything this renderer prints:
 * escape sequences go; a `\r`-redrawn progress line keeps what a terminal would finally show;
 * tabs become three cells the way pi does (a terminal advances to the next multiple of 8 while
 * pi-tui counts a tab as 3, so a raw tab would push a full-width row past the edge); other
 * control characters go.
 */
export function cellText(line: string): string {
	const visible = line.replace(ANSI, "").replace(/\r+$/, "");
	return visible
		.slice(visible.lastIndexOf("\r") + 1)
		.replace(/\t/g, "   ")
		.replace(CONTROL, "");
}

/** Multi-line output as cell text, line by line. */
export function cellLines(text: string): string {
	return text.split("\n").map(cellText).join("\n");
}
