import { isExploreKind, type RowHead } from "./row.ts";

/**
 * How one tool row should draw itself relative to the exploratory run it belongs to.
 * - solo: draw itself as an ordinary row.
 * - leader: draw the whole run — every member packed without blank lines, or one folded line.
 * - follower: draw nothing; the leader drew this row on its latest render.
 */
type RunRole = { kind: "solo" } | { kind: "leader"; ids: string[]; members: RowHead[]; complete: boolean } | { kind: "follower" };

/** What a row's call slot draws this frame: nothing, its own row, or its whole run. */
export type CallDraw = { kind: "none" } | { kind: "row" } | { kind: "run"; members: RowHead[]; complete: boolean };

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

/** What a run reads a member's head from: the member's row state. */
export interface RowSource {
	readonly head?: RowHead;
	/** Ask pi for another frame (the row's `invalidate`; a no-op in /export). */
	readonly requestFrame?: () => void;
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
	/**
	 * toolCallId → the live row state that speaks for it. Heads are read through the owner, so a leader
	 * always draws its members' latest heads, and one-shot render passes (/export) never become owners.
	 */
	private readonly owners = new Map<string, RowSource>();
	/**
	 * toolCallId → the row state that reported it most recently. A leader draws a member from its
	 * candidate until the member's own row owns it, so a member is part of its run from its first frame.
	 */
	private readonly candidates = new Map<string, RowSource>();
	/** Members their leader drew on its latest render, with the state it drew; only these hide as followers. */
	private readonly drawn = new Map<string, RowSource>();
	/** Leader ids of runs the user clicked open; they draw as ordinary rows from then on. */
	private readonly unpacked = new Set<string>();
	/** How many frames each not-yet-owning state has drawn its call slot. */
	private readonly frames = new WeakMap<RowSource, number>();

	/**
	 * The one place that decides who draws a tool call's head line each frame. It relies on pi's
	 * order: every row's renderCall (which reports) runs before a frame is drawn; the frame draws rows
	 * top to bottom, each row's call slot before its result slot, once per frame; /export draws each
	 * call slot exactly once. Under that order each head is drawn once per frame, by exactly one of:
	 * its call slot (callSlot), its result slot (resultSlotDrawsHead), or its run's leader.
	 *
	 * A state proves it is live by drawing a second frame, and then owns its tool call (from nobody,
	 * or from the state of a chat pi has since rebuilt). Until then the result slot draws the settled
	 * row, since a one-shot render draws the call before the result exists, and each frame asks for
	 * the next so a restored or rebuilt run settles without input.
	 */
	callSlot(toolCallId: string, source: RowSource): CallDraw {
		if (!this.owns(toolCallId, source)) {
			const frames = (this.frames.get(source) ?? 0) + 1;
			this.frames.set(source, frames);
			if (source.requestFrame) queueMicrotask(source.requestFrame);
			if (frames < 2) return { kind: "none" };
			this.owners.set(toolCallId, source);
		}
		const role = this.role(toolCallId);
		if (role.kind === "follower") return { kind: "none" };
		if (role.kind === "solo") return { kind: "row" };
		this.drew(toolCallId, role.ids);
		return { kind: "run", members: role.members, complete: role.complete };
	}

	/** Whether this state's result slot draws its head line this frame (see callSlot). */
	resultSlotDrawsHead(toolCallId: string, source: RowSource): boolean {
		return !this.owns(toolCallId, source) && this.drawn.get(toolCallId) !== source;
	}

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
	 * Re-read the runs from a branch's messages (session start, branch switch). Owners stay for tool
	 * calls still on the branch: on /resume and /reload pi draws the rows before it fires session_start,
	 * so they are already current. The rest belong to a chat pi has dropped and are let go.
	 */
	readBranch(messages: readonly unknown[]): void {
		this.runOf.clear();
		this.unpacked.clear();
		this.drawn.clear();
		for (const message of messages) this.ingest(message);
		this.retainOwners(messages);
	}

	/** Let go of row states for tool calls outside these messages, e.g. the rows a compaction dropped from the chat. */
	retainOwners(messages: readonly unknown[]): void {
		const kept = new Set(messages.flatMap((message) => toolCallBlocks(message).map((block) => block.id)));
		for (const map of [this.owners, this.candidates, this.drawn]) for (const id of map.keys()) if (!kept.has(id)) map.delete(id);
	}

	/** A row state started a render pass for this tool call (see candidates). */
	report(toolCallId: string, source: RowSource): void {
		this.candidates.set(toolCallId, source);
	}

	/** The leader just drew these members of its run (see role). */
	private drew(leaderId: string, ids: readonly string[]): void {
		for (const id of this.runOf.get(leaderId) ?? []) this.drawn.delete(id);
		for (const id of ids) {
			const source = this.source(id);
			if (source) this.drawn.set(id, source);
		}
	}



	/** Open the run led by `leaderId` into ordinary rows. */
	unpack(leaderId: string): void {
		this.unpacked.add(leaderId);
	}

	owns(toolCallId: string, source: RowSource): boolean {
		return this.owners.get(toolCallId) === source;
	}

	/** Hand an id to a row state directly; rows claim through callSlot. */
	claim(toolCallId: string, source: RowSource): void {
		this.owners.set(toolCallId, source);
	}

	private source(toolCallId: string): RowSource | undefined {
		return this.owners.get(toolCallId) ?? this.candidates.get(toolCallId);
	}

	private head(toolCallId: string): RowHead | undefined {
		return this.source(toolCallId)?.head;
	}

	/**
	 * A run packs only while every member is collapsed and drawn entirely by its row; one expanded
	 * member, or one carrying an image, turns the whole run back into ordinary rows.
	 */
	role(toolCallId: string): RunRole {
		const run = this.runOf.get(toolCallId);
		if (!run || !this.head(toolCallId)) return { kind: "solo" };
		const heads = run.map((id) => this.head(id));
		if (this.unpacked.has(run[0] ?? "") || heads.some((head) => head?.expanded || head?.standalone)) return { kind: "solo" };
		// A follower hides only once its leader has drawn it. The leader draws a member from its candidate
		// state before the member's own row is live, so a running member never stands apart from its run.
		if (run[0] !== toolCallId) return this.drawn.has(toolCallId) ? { kind: "follower" } : { kind: "solo" };
		const ids = run.filter((_, index) => heads[index] !== undefined);
		const members = heads.filter((head): head is RowHead => head !== undefined);
		return { kind: "leader", ids, members, complete: members.length === run.length };
	}
}
