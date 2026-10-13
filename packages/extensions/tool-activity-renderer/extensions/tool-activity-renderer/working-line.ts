import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { blend, breathe, clock, formatDuration, onFrame, paint, shimmer, type ThemeLike, tones } from "./palette.ts";
import { isToolKind, presentVerb } from "./row.ts";

type UI = Pick<ExtensionUIContext, "setWorkingIndicator" | "setWorkingMessage"> & { readonly theme: ThemeLike };

/** The activity a tool stands for in the working line; tools this renderer doesn't know read as plain work. */
function toolActivity(toolName: string): string {
	return isToolKind(toolName) ? presentVerb(toolName) : "Working";
}

/**
 * The line above the editor while pi works: a breathing dot, then what pi is doing right now —
 * Thinking, Reading, Running, Writing — with a highlight sweeping across it and the run's elapsed time.
 *
 * While only built-in tools run and `rowsShowTools()` says their compact rows are on screen, each row
 * already breathes, shimmers its verb and times itself right above. The line then gives way: the dot
 * holds still and only the run's elapsed time stays, so one live thing on screen says what is running.
 */
/** How long the dot takes to settle to rest when the line gives way, or to rise back into its breath. */
const SETTLE_MS = 240;

export function registerWorkingLine(pi: ExtensionAPI, rowsShowTools: () => boolean = () => false): void {
	let ui: UI | undefined;
	let stopFrames: (() => void) | undefined;
	let startedAt = 0;
	let phase = "Working";
	/** How much of its breath the dot shows: 1 while the line names an activity, easing to 0 while it gives way. */
	let swell = 1;
	let drawnAt = 0;
	/** Running tools by call id, by name. */
	const liveTools = new Map<string, string>();

	/** What the line names, or nothing when the running tools' own rows already say it. */
	const label = (): string | undefined => {
		const tools = [...liveTools.values()];
		if (tools.length === 0) return phase;
		if (rowsShowTools() && tools.every(isToolKind)) return undefined;
		return toolActivity(tools.at(-1) ?? "");
	};

	const draw = () => {
		if (!ui) return;
		const t = tones(ui.theme);
		const now = clock.now();
		const activity = label();
		const elapsed = paint(ui.theme, formatDuration(now - startedAt), t.dim);
		// One frame per tick, from the shared clock: pi animates an indicator with several frames on a
		// timer of its own, which would breathe out of step with the label's highlight.
		const step = (now - drawnAt) / SETTLE_MS;
		drawnAt = now;
		swell = activity === undefined ? Math.max(0, swell - step) : Math.min(1, swell + step);
		const dot = blend(t.dim, breathe(t.dim, t.accent, now - startedAt), swell);
		ui.setWorkingIndicator({ frames: [paint(ui.theme, "●", dot)] });
		ui.setWorkingMessage(activity === undefined ? elapsed : `${shimmer(ui.theme, activity, t.muted, t.text, now)}  ${elapsed}`);
	};

	const stop = () => {
		stopFrames?.();
		stopFrames = undefined;
		liveTools.clear();
		if (!ui) return;
		ui.setWorkingIndicator();
		ui.setWorkingMessage();
		ui = undefined;
	};

	pi.on("agent_start", (_event, ctx) => {
		stop();
		if (!ctx.hasUI) return;
		ui = ctx.ui;
		startedAt = clock.now();
		drawnAt = startedAt;
		swell = 1;
		phase = "Working";
		draw();
		stopFrames = onFrame(draw);
	});

	pi.on("message_update", (event) => {
		const type = event.assistantMessageEvent.type;
		if (type.startsWith("thinking")) phase = "Thinking";
		else if (type.startsWith("text")) phase = "Writing";
		else if (type.startsWith("toolcall")) phase = "Working";
	});

	// Between turns of one run (steering, follow-ups) pi waits on the next response: plain work again.
	pi.on("message_end", (event) => {
		if ((event.message as { role?: unknown }).role === "assistant") phase = "Working";
	});

	pi.on("tool_execution_start", (event) => {
		liveTools.set(event.toolCallId, event.toolName);
	});

	pi.on("tool_execution_end", (event) => {
		liveTools.delete(event.toolCallId);
	});

	pi.on("agent_end", stop);
	pi.on("session_shutdown", stop);
}
