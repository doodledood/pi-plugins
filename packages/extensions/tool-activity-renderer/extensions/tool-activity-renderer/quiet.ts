import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { muteNarration, Narration } from "./narration.ts";
import { flattenThinkingCode } from "./thinking.ts";

/** The slice of pi's theme the quiet tone is read from. */
interface ToneTheme {
	fg(color: "thinkingText", text: string): string;
	italic(text: string): string;
}

/** The escape sequences pi opens a thinking block's text with: the `thinkingText` color, then italics. */
export function thinkingTone(theme: ToneTheme): string {
	const sentinel = "\0";
	const styled = theme.italic(theme.fg("thinkingText", sentinel));
	return styled.slice(0, styled.indexOf(sentinel));
}

function messagesOf(entries: readonly unknown[]): unknown[] {
	return entries
		.filter((entry) => typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "message")
		.map((entry) => (entry as { message?: unknown }).message);
}

/**
 * Thinking and narration stay beneath the reply. A thinking block's code spans draw in its own tone
 * (`flattenThinkingCode`), and narration, the text of an assistant message that also calls a tool,
 * draws in the thinking tone once that tool call is known (`muteNarration`), live and in restored
 * history. Only the reply, the text of the message that calls no tool, keeps reply brightness.
 *
 * Pi keeps one Markdown transformer per extension and the last registration wins, so this is the
 * renderer's only call to `registerMarkdownTransformer`; any other rewrite has to compose in here.
 */
export function registerQuietText(pi: ExtensionAPI): void {
	const narration = new Narration();
	/** Pi's UI, whose theme is read at each draw so a theme switch retones narration. */
	let ui: { readonly theme: ToneTheme } | undefined;

	// Pi hands extensions each update before it redraws the message, so the text a tool call just
	// turned into narration is already known when pi draws it.
	pi.on("message_update", (event) => narration.ingest(event.message, false));
	pi.on("message_end", (event) => narration.ingest(event.message, true));
	const readBranch = (_event: unknown, ctx: ExtensionContext) => {
		ui = ctx.mode === "tui" ? ctx.ui : undefined;
		narration.readBranch(messagesOf(ctx.sessionManager.getBranch()));
	};
	pi.on("session_start", readBranch);
	pi.on("session_tree", readBranch);

	pi.registerMarkdownTransformer((text, context) => {
		if (context.messageType === "assistant-thinking") return flattenThinkingCode(text, context.availableWidth);
		if (context.messageType === "assistant" && ui && narration.has(text)) return muteNarration(text, thinkingTone(ui.theme), context.availableWidth);
		return text;
	});
}
