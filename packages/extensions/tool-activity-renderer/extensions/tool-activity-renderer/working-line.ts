import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { breathe, clock, formatDuration, onFrame, paint, shimmer, type ThemeLike, tones } from "./palette.ts";
import { isToolKind, presentVerb } from "./row.ts";

type UI = Pick<ExtensionUIContext, "setWorkingIndicator" | "setWorkingMessage"> & { readonly theme: ThemeLike };

/** The activity a tool stands for in the working line; tools this renderer doesn't know read as plain work. */
function toolActivity(toolName: string): string {
	return isToolKind(toolName) ? presentVerb(toolName) : "Working";
}

/**
 * The line above the editor while pi works: a breathing dot, then what pi is doing right now —
 * Thinking, Reading, Running, Writing — with a highlight sweeping across it and the run's elapsed time.
 */
export function registerWorkingLine(pi: ExtensionAPI): void {
	let ui: UI | undefined;
	let stopFrames: (() => void) | undefined;
	let startedAt = 0;
	let phase = "Working";
	const liveTools = new Map<string, string>();

	const label = () => [...liveTools.values()].at(-1) ?? phase;

	const draw = () => {
		if (!ui) return;
		const t = tones(ui.theme);
		const now = clock.now();
		// One frame per tick, from the shared clock: pi animates an indicator with several frames on a
		// timer of its own, which would breathe out of step with the label's highlight.
		ui.setWorkingIndicator({ frames: [paint(ui.theme, "●", breathe(t.dim, t.accent, now - startedAt))] });
		ui.setWorkingMessage(`${shimmer(ui.theme, label(), t.muted, t.text, now)}  ${paint(ui.theme, formatDuration(now - startedAt), t.dim)}`);
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
		liveTools.set(event.toolCallId, toolActivity(event.toolName));
	});

	pi.on("tool_execution_end", (event) => {
		liveTools.delete(event.toolCallId);
	});

	pi.on("agent_end", stop);
	pi.on("session_shutdown", stop);
}
