import type { ThemeStyle, ThemeToken } from "@earendil-works/pi-coding-agent";
import { type Color, mixColors } from "@earendil-works/pi-tui";

/**
 * The slice of pi's Theme the renderer draws with. `colors` and `style` arrived in pi 0.99.0; they let
 * the renderer blend between the active theme's own tokens instead of carrying a private palette.
 */
export interface ThemeLike {
	readonly colors: Readonly<Record<ThemeToken, Color>>;
	style(text: string, options: ThemeStyle): string;
}

/** Injectable clock so fades and shimmer can be tested at fixed instants. */
export const clock = { now: (): number => Date.now() };

/**
 * Redraw cadence while anything is live or fading: 30 frames a second, so a breathing color and a
 * sweeping highlight read as continuous motion instead of visible steps. pi's TUI draws at most 60.
 */
export const FRAME_MS = 33;

const frameListeners = new Set<() => void>();
let frameTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Call `draw` on every frame until the returned function is called. All live motion shares this one
 * clock, so the working line, the dot and every live row advance together in one TUI render per frame
 * instead of each timer requesting its own, out of step with the others.
 */
export function onFrame(draw: () => void): () => void {
	frameListeners.add(draw);
	if (!frameTimer) {
		frameTimer = setInterval(() => {
			// A copy, so a listener may stop itself; the check skips one that another listener stopped this frame.
			for (const listener of [...frameListeners]) if (frameListeners.has(listener)) listener();
		}, FRAME_MS);
		// A redraw timer must never be what keeps a process alive.
		frameTimer.unref?.();
	}
	return () => {
		frameListeners.delete(draw);
		if (frameListeners.size || !frameTimer) return;
		clearInterval(frameTimer);
		frameTimer = undefined;
	};
}

/** Whether the frame clock is running. */
export function framesRunning(): boolean {
	return frameTimer !== undefined;
}

/**
 * Drop every frame listener and stop the clock. For tests: a test that fails mid-animation leaves its
 * listener behind, and with it a timer from mocked time that would never fire for the tests after it.
 */
export function resetFrames(): void {
	frameListeners.clear();
	if (frameTimer) clearInterval(frameTimer);
	frameTimer = undefined;
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export function easeOut(value: number): number {
	return 1 - (1 - clamp01(value)) ** 3;
}

/**
 * Mix two theme colors in sRGB. OKLCH (pi's default) swings hue toward a gray's faint tint, so a
 * success green mixed toward a cool gray lands blue; sRGB keeps state colors in their own family.
 */
export function blend(from: Color, to: Color, amount: number): Color {
	return mixColors(from, to, clamp01(amount), "srgb");
}

export function paint(theme: ThemeLike, text: string, fg: Color, attributes: Omit<ThemeStyle, "fg"> = {}): string {
	return text ? theme.style(text, { ...attributes, fg }) : "";
}

/** The Graphite tones, derived from whatever theme is active. */
export function tones(theme: ThemeLike) {
	const c = theme.colors;
	return {
		text: c.text,
		soft: blend(c.text, c.muted, 0.35),
		muted: c.muted,
		dim: c.dim,
		faint: c.borderMuted,
		accent: c.accent,
		success: c.success,
		error: c.error,
		warning: c.warning,
		added: c.toolDiffAdded,
		removed: c.toolDiffRemoved,
		addedBg: c.toolSuccessBg,
		removedBg: c.toolErrorBg,
	};
}

/** One full breath of a live glyph. */
const BREATH_PERIOD_MS = 1200;

/** A color oscillating between two tones — the live glyph's slow breath. */
export function breathe(from: Color, to: Color, now: number, periodMs = BREATH_PERIOD_MS): Color {
	return blend(from, to, 0.5 - 0.5 * Math.cos((2 * Math.PI * now) / periodMs));
}

/** A highlight band sweeping left to right across `text`, one style per character. */
export function shimmer(theme: ThemeLike, text: string, base: Color, highlight: Color, now: number, periodMs = 1700, band = 4): string {
	const chars = [...text];
	const span = chars.length + band * 2;
	const head = ((now % periodMs) / periodMs) * span - band;
	return chars
		.map((char, index) => {
			const k = clamp01(1 - Math.abs(index - head) / band);
			return paint(theme, char, blend(base, highlight, k * k * (3 - 2 * k)));
		})
		.join("");
}

export function formatDuration(ms: number): string {
	// Round before choosing the unit, so 59.96s reads as 1m 00s rather than 60.0s.
	const tenths = Math.round(Math.max(0, ms) / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const seconds = Math.floor(tenths / 10);
	return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
