import { isExploreKind, type RowHead } from "./row.ts";

/**
 * How one tool row should draw itself relative to the exploratory run it belongs to.
 * - solo: draw itself as an ordinary row.
 * - leader: draw the whole run — every member packed without blank lines, or one folded line.
 * - follower: draw nothing; the leader already drew this row.
 */
type RunRole = { kind: "solo" } | { kind: "leader"; members: RowHead[]; complete: boolean } | { kind: "follower" };

interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
}

function toolCallBlocks(message: unknown): ToolCallBlock[] {
	if (typeof message !== "object" || message === null) return [];
	const { role, content } = message as { role?: unknown; content?: unknown };
	if (role !== "assistant" || !Array.isArray(content)) return [];
	return content.filter(
		(block): block is ToolCallBlock =>
			typeof block === "object" && block !== null && block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string",
	);
}

/**
 * Pi draws every tool row as its own component with a blank line above it, so rows can only pack
 * together if one of them draws its siblings. An exploratory run is a maximal sequence of consecutive
 * read/grep/find/ls calls in one assistant message (pi shows a message's tool rows in content order, so
 * the run is contiguous on screen). Its first row draws the whole run; the rest render nothing.
 */
export class ExploreRuns {
	/** toolCallId → the ordered ids of its run. Only runs of two or more are recorded. */
	private readonly runOf = new Map<string, readonly string[]>();
	private readonly heads = new Map<string, RowHead>();

	/** Record the runs in an assistant message. Safe to call repeatedly as the message streams. */
	ingest(message: unknown): void {
		let run: string[] = [];
		const close = () => {
			if (run.length >= 2) for (const id of run) this.runOf.set(id, run);
			else for (const id of run) this.runOf.delete(id);
			run = [];
		};
		for (const block of toolCallBlocks(message)) {
			if (isExploreKind(block.name)) run.push(block.id);
			else close();
		}
		close();
	}

	/**
	 * Forget every recorded run before a branch is re-read. Heads stay: on /resume and /reload pi draws
	 * the rows before it fires session_start, so the heads they reported are already current.
	 */
	clearRuns(): void {
		this.runOf.clear();
	}

	/** Every row reports its latest head so the run's leader can draw it. */
	report(toolCallId: string, head: RowHead): void {
		this.heads.set(toolCallId, head);
	}

	/** A run packs only while every member is collapsed; one expanded member turns the whole run back into ordinary rows. */
	role(toolCallId: string): RunRole {
		const run = this.runOf.get(toolCallId);
		if (!run || !this.heads.has(toolCallId)) return { kind: "solo" };
		const heads = run.map((id) => this.heads.get(id));
		if (heads.some((head) => head?.expanded)) return { kind: "solo" };
		// A follower hides only once its leader exists to draw it.
		if (run[0] !== toolCallId) return heads[0] ? { kind: "follower" } : { kind: "solo" };
		const members = heads.filter((head): head is RowHead => head !== undefined);
		return { kind: "leader", members, complete: members.length === run.length };
	}
}
