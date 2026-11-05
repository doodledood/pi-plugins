// The owner's surface: one line above the editor, and a panel on a key.
// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md — Slack activity lives here,
// never as rows in main's transcript. Graphite: brightness carries hierarchy, color only state;
// the line stays quiet (muted) until something needs the owner.
import { type Component, Key, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Approval, type ContextMessage, DM_MARK, dmLabel, type EngineState, isLive, threadOf, type WatchState } from "./engine.ts";
import { isDirectMessage } from "./conversation.ts";

export type PaintColor = "accent" | "dim" | "muted" | "warning" | "error" | "success" | "text" | "border" | "borderMuted";

export interface Paint {
  fg(color: PaintColor, text: string): string;
  bold(text: string): string;
}

export const WIDGET_KEY = "slack-companion";

/**
 * Cut plain text to `width` cells with "…". Unlike pi-tui's truncateToWidth it adds no reset code,
 * so text painted after cutting keeps its color and weight to the end. Cut first, then paint.
 */
export function cut(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return width === 1 ? "…" : "";
  let out = "";
  for (const char of text) {
    if (visibleWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out.trimEnd()}…`;
}

/**
 * The panel's share of the terminal's height. The overlay is opened with exactly this share and
 * the panel lays itself out in exactly as many rows: the overlay cuts what is taller, and "the
 * request was shown to its end" relies on nothing being cut.
 */
export const PANEL_HEIGHT_PERCENT = 80;

export function panelRows(terminalRows: number): number {
  return Math.floor((terminalRows * PANEL_HEIGHT_PERCENT) / 100);
}

/** Why the package cannot watch: a short title for the line, the whole explanation for the panel. */
export interface SurfaceProblem {
  title: string;
  detail: string;
}

export interface SurfaceState {
  enabled: boolean;
  problem?: SurfaceProblem;
  engine: EngineState;
  panelKey: string;
  /** Watches whose helper is answering right now. */
  answering: ReadonlySet<string>;
  /** Error stops the owner has seen in the panel, by errorId. */
  seenErrors: ReadonlySet<string>;
  now: number;
}

/** One stop with an error: a watch can stop, be watched again, and stop again. */
export function errorId(watch: Pick<WatchState, "key" | "endedAt">): string {
  return `${watch.key}@${watch.endedAt ?? 0}`;
}

function isUnseenError(surface: SurfaceState, watch: WatchState): boolean {
  return watch.status === "error" && !surface.seenErrors.has(errorId(watch));
}

// ---------------------------------------------------------------------------------------------
// The line above the editor
// ---------------------------------------------------------------------------------------------

interface LineEntry {
  /** Ways to name it, longest first, each whole: first words give way before the entry folds. */
  labels: string[];
  /** The conversation's state: the first in LINE_ORDER any of its watches is in. */
  state: LineState;
  /** Agent posts that wait on the owner across its watches. */
  agentPosts: number;
  /** A state word shown whole, in its color; or none, and the note shows instead. */
  word?: { text: string; color: PaintColor };
  note: string;
}

/** The first words of a conversation (the thread's first message, else the first one kept), to name it before anyone answers. */
function openingWords(watch: WatchState, cells: number): string | undefined {
  const { conversation } = watch;
  const root = conversation.kind === "thread" ? watch.context.find((m) => m.ts === conversation.threadTs) : watch.context[0];
  const text = root?.text.replace(/\s+/g, " ").trim();
  return text ? cut(text, cells) : undefined; // whole characters, counted in cells
}

/** Cells the line gives a conversation's first words, so two or three fresh conversations fit. */
const LINE_OPENING_CELLS = 16;
/** What quoting first words adds after a prefix: a space and two quotes. */
const QUOTED_EXTRA = 3;

/**
 * A conversation as the line and the panel name it before anyone has answered: a DM by its first
 * words, a channel thread by its channel and first words. One spelling for both surfaces. Names
 * are never cut: the first words take what is left of `room` (the panel's), or the line's budget
 * without it, and are left out when too little is left.
 */
function unnamedLabel(watch: WatchState, room?: number): string {
  const prefix = unnamedPrefix(watch);
  const cells = room === undefined ? LINE_OPENING_CELLS : room - visibleWidth(prefix) - QUOTED_EXTRA;
  const opening = cells >= 4 ? openingWords(watch, cells) : undefined;
  if (opening) return `${prefix} "${opening}"`;
  return isDirectMessage(watch.conversation.channelId) ? dmLabel(undefined) : prefix;
}

/** What names a conversation before its first words: "DM", or its channel. */
function unnamedPrefix(watch: WatchState): string {
  return isDirectMessage(watch.conversation.channelId) ? "DM" : `#${channelOf(watch)}`;
}

/**
 * A conversation as the line names it, longest first: the person, and the channel when it is not
 * a DM; before anyone answers, unnamedLabel, then the same without its first words. Names are
 * whole: an entry none of whose labels fits is folded into a count.
 */
function lineLabels(watch: WatchState): string[] {
  const person = watch.partner?.name;
  if (person) return [isDirectMessage(watch.conversation.channelId) ? person : `${person} #${channelOf(watch)}`];
  const withWords = unnamedLabel(watch);
  const bare = unnamedLabel(watch, 0);
  return withWords === bare ? [bare] : [withWords, bare];
}

function channelOf(watch: WatchState): string {
  return watch.channelName || watch.conversation.channelId;
}

/**
 * What a live conversation needs or is doing, in the order the owner should see it: the one
 * source for the line's words, counts and order and the panel's order and status.
 */
const LINE_ORDER = ["paused", "agent posts", "answering", "catching up", "watching"] as const;
type LineState = (typeof LINE_ORDER)[number];

/** A live watch's state (a conversation takes the first of its watches' in LINE_ORDER). */
function watchState(watch: WatchState, surface: SurfaceState): LineState {
  if (watch.status === "paused") return "paused";
  if (watch.agentPostsWaiting) return "agent posts";
  if (surface.answering.has(watch.key)) return "answering";
  return watch.rejoining !== undefined ? "catching up" : "watching";
}

/** One entry per person in a direct message (its top level and its threads), one per channel thread; what needs the owner first. */
function lineEntries(surface: SurfaceState): LineEntry[] {
  const groups = new Map<string, WatchState[]>();
  for (const watch of surface.engine.watches.filter(isLive)) {
    const id = isDirectMessage(watch.conversation.channelId) ? watch.conversation.channelId : watch.key;
    groups.set(id, [...(groups.get(id) ?? []), watch]);
  }
  const ranked = [...groups.values()].map((watches) => {
    const named = watches.find((w) => w.partner) ?? watches[0]!;
    const states = watches.map((w) => watchState(w, surface));
    const state = LINE_ORDER.find((s) => states.includes(s))!;
    const agentPosts = watches.reduce((sum, w) => sum + (w.agentPostsWaiting ?? 0), 0);
    const latest = [...watches].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const word = state === "agent posts" ? { text: agentPosts === 1 ? "agent post waits" : `${agentPosts} agent posts wait`, color: "warning" as const } : LINE_WORD[state];
    const entry: LineEntry = { labels: lineLabels(named), state, agentPosts, ...(word ? { word } : {}), note: latest.find((w) => w.lastNote)?.lastNote ?? "watching" };
    return { entry, rank: LINE_RANK[state], at: latest[0]!.lastActivityAt };
  });
  return ranked.sort((a, b) => a.rank - b.rank || b.at - a.at).map((r) => r.entry);
}

/** Agent posts that wait on the owner, as the panel says it. */
function agentPostsWord(count: number): string {
  return count === 1 ? "1 agent post since you wrote" : `${count} agent posts since you wrote`;
}

/** The line's word for a state; plain watching has none, so its note shows. */
const LINE_WORD: Partial<Record<LineState, { text: string; color: PaintColor }>> = {
  paused: { text: "paused", color: "warning" },
  answering: { text: "answering…", color: "accent" },
  "catching up": { text: "catching up", color: "accent" },
};

/** What needs the owner first, on the line and in the panel: LINE_ORDER, with catching up and watching tied (newest first). */
const LINE_RANK = Object.fromEntries(LINE_ORDER.map((state, i) => [state, Math.min(i, LINE_ORDER.indexOf("catching up"))])) as Record<LineState, number>;

/**
 * The states the line counts on their own when it does not name them all, never folded into
 * "watching", and that turn its dot to warning: what waits on the owner. In LINE_ORDER. Each
 * counts in its own unit (`weight`: conversations, or agent posts), and its words take the number
 * of the unnamed ones, with "+" when some are named. (A paused conversation counts as paused: its
 * agent posts show in the panel.) `tight` is for the narrowest line, before a count is dropped.
 */
const LINE_COUNTED: Partial<Record<LineState, { weight: (e: LineEntry) => number; long: (n: number) => string; short: (n: number) => string; tight: (n: number) => string }>> = {
  paused: { weight: () => 1, long: (n) => `${n} paused`, short: (n) => `${n} paused`, tight: (n) => `${n} paused` },
  "agent posts": { weight: (e) => e.agentPosts, long: (n) => `${n} agent post${n === 1 ? "" : "s"}`, short: (n) => `${n} agent post${n === 1 ? "" : "s"}`, tight: (n) => `${n} agent` },
};
const countedStates = LINE_ORDER.filter((state) => LINE_COUNTED[state]);

/** The panel's status per live state: a mark before the word, since a row has room the line lacks. */
const PANEL_STATUS: Record<LineState, { text: string; color: PaintColor }> = {
  paused: { text: "○ paused", color: "warning" },
  "agent posts": { text: "◐ agent post", color: "warning" },
  answering: { text: "● answering…", color: "accent" },
  "catching up": { text: "◌ catching up", color: "accent" },
  watching: { text: "● watching", color: "success" },
};

/** Characters of a note an entry must show to be worth showing. */
const NOTE_MIN = 16;
const SEP = " · ";
/** Between a conversation and what happened in it, so the person never reads as the one who acted. */
const PAIR = " – ";

/** The line above the editor: never wider than `width`, which Pi requires of a widget. */
export function renderLine(surface: SurfaceState, paint: Paint, width: number): string[] {
  return composeLine(surface, paint, width).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
}

function composeLine(surface: SurfaceState, paint: Paint, width: number): string[] {
  const sep = paint.fg("dim", SEP);
  const head = (color: PaintColor) => ` ${paint.fg(color, "●")} ${paint.fg("muted", "slack")}`;
  const hint = (long: boolean) => paint.fg("dim", long ? `${surface.panelKey} opens` : surface.panelKey);
  /** The left part, then the key hint right-aligned with at least two spaces before it. */
  const compose = (left: string, longHint: boolean) => {
    const h = hint(longHint);
    return `${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(h)))}${h}`;
  };
  const fits = (left: string, longHint: boolean) => visibleWidth(left) + 2 + visibleWidth(hint(longHint)) <= width;
  if (surface.problem) {
    const room = Math.max(8, width - visibleWidth(hint(false)) - 2 - visibleWidth(` ● slack `));
    const short = `${head("error")} ${paint.fg("text", cut(`can't watch: ${surface.problem.title}`, room))}`;
    return [fits(short, false) ? compose(short, fits(short, true)) : compose(head("error"), false)];
  }
  if (!surface.enabled) return [];
  const entries = lineEntries(surface);
  const waiting = surface.engine.approvals.filter((a) => a.status === "pending").length;
  // A state's conversations, counted as the line shows them: a DM's top level and its threads are one.
  const counted = (list: readonly LineEntry[], state: LineState) => list.filter((e) => e.state === state).length;
  const stopped = surface.engine.watches.filter((w) => isUnseenError(surface, w)).length;
  if (!entries.length && !waiting && !stopped) return [];
  const dot: PaintColor = stopped ? "error" : waiting || entries.some((e) => LINE_COUNTED[e.state]) ? "warning" : "muted";
  // Counts in the order they matter: waiting first, then stops, then the counted states. A count
  // appears when the line leaves any of its kind unnamed: it counts the unnamed ones, in its unit,
  // with "+" when some of its kind are named (as "+N watching" does).
  const counts = (form: "long" | "short" | "tight", shown: readonly LineEntry[]) => [
    waiting ? paint.fg("warning", form === "long" ? `${waiting} waiting for you` : `${waiting} waiting`) : "",
    stopped ? paint.fg("error", `${stopped} stopped`) : "",
    ...countedStates.map((state) => {
      const spec = LINE_COUNTED[state]!;
      const unnamed = entries.filter((e) => e.state === state && !shown.includes(e));
      if (!unnamed.length) return "";
      const n = unnamed.reduce((sum, e) => sum + spec.weight(e), 0);
      const words = spec[form](n);
      return paint.fg("warning", counted(shown, state) ? `+${words}` : words);
    }),
  ].filter(Boolean);

  // Watch entries at their natural width, in rank order: an entry shows only if one of its whole
  // labels and its state word (or a useful part of its note) fit; one that does not is skipped,
  // so a long name never hides shorter ones after it, and folds into "+N watching" (or its count).
  // Each form (long words, short words) is built; the long one wins only if it names as many
  // conversations, since the people are what the owner glances for.
  const form = (long: boolean): { line: string; named: number } | undefined => {
    const countsWidth = (shown: readonly LineEntry[]) => counts(long ? "long" : "short", shown).reduce((w, c) => w + visibleWidth(c) + SEP.length, 0);
    const room = width - visibleWidth(head(dot)) - 2 - visibleWidth(hint(long));
    const chosen: Array<{ entry: LineEntry; label: string }> = [];
    const shown = () => chosen.map((c) => c.entry);
    const need = (e: LineEntry, label: string) => visibleWidth(label) + (e.word ? 1 + visibleWidth(e.word.text) : PAIR.length + Math.min(visibleWidth(e.note), NOTE_MIN));
    const used = () => chosen.reduce((w, c) => w + SEP.length + need(c.entry, c.label), 0);
    // Folded watches are counted as "watching", but a counted state is in its own count.
    const foldCount = (named: readonly LineEntry[]) => entries.filter((e) => !named.includes(e) && !LINE_COUNTED[e.state]).length;
    const foldWords = (named: readonly LineEntry[]) => `${named.length ? "+" : ""}${foldCount(named)} watching`;
    const fold = (named: readonly LineEntry[]) => (foldCount(named) ? SEP.length + visibleWidth(foldWords(named)) : 0);
    for (const entry of entries) {
      const next = [...shown(), entry];
      const label = entry.labels.find((l) => used() + SEP.length + need(entry, l) + fold(next) + countsWidth(next) <= room);
      if (label !== undefined) chosen.push({ entry, label });
    }
    // Space left over goes to the shown notes, in rank order.
    let spare = room - used() - fold(shown()) - countsWidth(shown());
    if (spare < 0) return undefined;
    const parts = chosen.map(({ entry: e, label }) => {
      // A state word (paused, answering…) reads as the conversation's state; a note, as an event.
      if (e.word) return `${paint.fg("muted", label)} ${paint.fg(e.word.color, e.word.text)}`;
      const base = Math.min(visibleWidth(e.note), NOTE_MIN);
      const extra = Math.max(0, Math.min(visibleWidth(e.note) - base, spare));
      spare -= extra;
      return `${paint.fg("muted", label)}${paint.fg("dim", PAIR)}${paint.fg("muted", cut(e.note, base + extra))}`;
    });
    if (foldCount(shown())) parts.push(paint.fg("muted", foldWords(shown())));
    const left = [head(dot), ...parts, ...counts(long ? "long" : "short", shown())].join(sep);
    return fits(left, long) ? { line: compose(left, long), named: chosen.length } : undefined;
  };
  const long = form(true);
  const short = form(false);
  if (long && (!short || long.named >= short.named)) return [long.line];
  if (short) return [short.line];
  // Too narrow even to name one: the counts, the live watches' first as on a wider line, but the
  // first to go. As many counts as fit; with as many, the word "slack" and then short words win:
  // each set is tried in short words with "slack", in tight words with it, then in tight words
  // without it, before the lowest count is dropped.
  const watching = entries.filter((e) => !LINE_COUNTED[e.state]).length;
  const kept = (form: "short" | "tight", k: number) => {
    const owed = counts(form, []);
    return [...(watching && k > owed.length ? [paint.fg("muted", `${watching} watching`)] : []), ...owed.slice(0, k)];
  };
  for (let k = counts("tight", []).length + (watching ? 1 : 0); k >= 1; k -= 1) {
    for (const [lead, form] of [[head(dot), "short"], [head(dot), "tight"], [` ${paint.fg(dot, "●")}`, "tight"]] as const) {
      const left = [lead, ...kept(form, k)].join(sep);
      if (fits(left, false)) return [compose(left, false)];
    }
  }
  return [compose(head(dot), false)];
}

// ---------------------------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------------------------

export type PanelItem =
  | { kind: "approval"; approval: Approval }
  | { kind: "watch"; watch: WatchState }
  | { kind: "ended"; count: number };

const ENDED_SHOWN = 3;

/**
 * What needs the owner first: requests (waiting, then those resolved while the panel is open);
 * paused watches; stops with an error he has not seen; the other live watches in LINE_RANK order
 * (agent posts waiting, answering now, the rest), most recently active first within each; then ended ones (errors already seen, and the latest few
 * quiet ends, newest first; the rest fold into "N more ended" unless `allEnded`).
 */
export function panelItems(surface: SurfaceState, openedAt: number, allEnded = false): PanelItem[] {
  const state = surface.engine;
  const approvals: PanelItem[] = state.approvals
    .filter((a) => a.status === "pending" || (a.resolvedAt !== undefined && a.resolvedAt >= openedAt))
    .map((approval) => ({ kind: "approval", approval }));
  const byActivity = (a: WatchState, b: WatchState) => b.lastActivityAt - a.lastActivityAt;
  const byEnd = (a: WatchState, b: WatchState) => (b.endedAt ?? 0) - (a.endedAt ?? 0);
  // Live watches in the line's order (LINE_RANK), newest first within a rank; unseen stops follow
  // the paused ones.
  const live = state.watches.filter(isLive).sort((a, b) => LINE_RANK[watchState(a, surface)] - LINE_RANK[watchState(b, surface)] || byActivity(a, b));
  const paused = live.filter((w) => watchState(w, surface) === "paused");
  const others = live.filter((w) => watchState(w, surface) !== "paused");
  const errors = state.watches.filter((w) => w.status === "error").sort(byEnd);
  const unseen = errors.filter((w) => isUnseenError(surface, w));
  const seen = errors.filter((w) => !isUnseenError(surface, w));
  const quiet = state.watches.filter((w) => w.status === "stopped").sort(byEnd);
  const shownQuiet = allEnded ? quiet : quiet.slice(0, ENDED_SHOWN);
  const watches: PanelItem[] = [...paused, ...unseen, ...others, ...seen, ...shownQuiet].map((watch) => ({ kind: "watch", watch }));
  if (quiet.length > shownQuiet.length) watches.push({ kind: "ended", count: quiet.length - shownQuiet.length });
  return [...approvals, ...watches];
}

function age(now: number, at: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Which conversation in a DM a watch is: its top level, or a thread named by its first words. */
function kindLabel(watch: WatchState): string {
  const { conversation } = watch;
  if (conversation.kind === "dm-top") return "top level";
  const text = openingWords(watch, 32);
  return text ? `thread "${text}"` : "thread";
}

/** Who asked, and where, without saying the person twice. */
function requestSource(approval: Approval): string {
  const ownThread = threadOf(approval.requester);
  if (approval.label === dmLabel(approval.requester)) return approval.label;
  if (approval.label.startsWith(ownThread)) return `${approval.requester} in ${approval.label.slice(ownThread.length)}`;
  return `${approval.requester} · ${approval.label}`;
}

function keysFor(item: PanelItem | undefined, approvable: boolean): string {
  if (item?.kind === "ended") return "enter show all";
  if (item?.kind === "approval") return item.approval.status !== "pending" ? "" : approvable ? "a approve · d deny" : "d deny";
  if (item?.kind !== "watch") return "";
  if (item.watch.status === "paused") return "r resume · s stop";
  if (item.watch.status === "active") return "s stop watching";
  return "w watch again";
}

/** An item's rows, `inner` cells wide; `pinned` of them stay in view while the rest scroll. */
function itemRows(item: PanelItem, surface: SurfaceState, paint: Paint, inner: number, selected: boolean): { rows: string[]; pinned: number } {
  const indent = (rows: string[]) => rows.map((r) => `   ${r}`);
  const strong = (text: string) => (selected ? paint.bold(text) : text);
  if (item.kind === "ended") return { rows: [paint.fg("muted", `${item.count} more ended`)], pinned: 1 };
  if (item.kind === "approval") {
    const { approval } = item;
    const pending = approval.status === "pending";
    // The head drops its age, then wraps, when the row is narrow.
    const state = pending ? "◐ waiting for your OK" : approval.status === "approved" ? "✓ approved — sent to your session" : "✗ declined";
    const when = pending ? ` · ${age(surface.now, approval.at)}` : "";
    const paintState = (text: string) => (pending ? paint.fg("warning", strong(text)) : paint.fg("muted", text));
    const head = visibleWidth(state + when) <= inner
      ? [`${paintState(state)}${paint.fg("muted", when)}`]
      : wrapTextWithAnsi(state, inner).map(paintState);
    // The whole request, wrapped, never cut: exactly what main receives if approved.
    const body = wrapTextWithAnsi(approval.text, inner - 3).map((row) => (pending ? paint.fg("text", row) : paint.fg("dim", row)));
    // Who asked, whole (a person's name is never cut), wrapped when long.
    const from = wrapTextWithAnsi(`from ${requestSource(approval)}`, inner - 3).map((row) => paint.fg("muted", row));
    return { rows: [...head, ...indent(from), ...indent(body)], pinned: head.length + from.length };
  }
  const { watch } = item;
  const answering = surface.answering.has(watch.key);
  const live = isLive(watch) ? PANEL_STATUS[watchState(watch, surface)] : undefined;
  const status = live ? paint.fg(live.color, live.text) : watch.status === "error" ? paint.fg("error", "× stopped") : paint.fg("muted", "· ended");
  // Names wrap, so the label takes only what the status leaves; with none, it starts a row lower.
  const labelRoom = Math.max(0, inner - visibleWidth(status) - 2);
  const [first, ...more] = panelLabel(watch, labelRoom, inner - 3);
  const labelColor = isLive(watch) ? "text" : "muted";
  const rows = [first ? `${paint.fg(labelColor, strong(first))}  ${status}` : status, ...indent(more.map((row) => paint.fg(labelColor, strong(row))))];
  // Agent posts that wait on the owner stay in view until he or his session writes there: the
  // count, then the latest such post on rows of its own (two at most), so its words show.
  const latestAgentPost = watch.agentPostsWaiting && isLive(watch) ? [...watch.context].reverse().find((m) => m.origin === "someone's agent") : undefined;
  if (watch.agentPostsWaiting && isLive(watch)) {
    const n = watch.agentPostsWaiting;
    const tail = latestAgentPost ? ", the latest:" : n === 1 ? "; check it" : "; check them";
    const countRow = visibleWidth(agentPostsWord(n) + tail) <= inner - 3 ? agentPostsWord(n) + tail : agentPostsWord(n);
    rows.push(...indent([paint.fg("warning", cut(countRow, inner - 3))]));
    if (latestAgentPost) {
      // The row above names its person, whole: their agent's post needs no second name.
      const poster = latestAgentPost.userId === watch.partner?.userId ? "their agent" : postedBy(latestAgentPost);
      rows.push(...indent(postRows(poster, agentText(latestAgentPost), inner - 3, 2).map((row) => paint.fg("warning", row))));
    }
  }
  if (watch.reason && watch.status !== "active") rows.push(...indent(wrapTextWithAnsi(watch.reason, inner - 3).map((r) => paint.fg(watch.status === "error" ? "error" : "muted", r))));
  for (const entry of (watch.activity ?? []).slice(-3)) rows.push(...indent([paint.fg("dim", cut(`${clock(entry.at)}  ${entry.text}`, inner - 3))]));
  // The latest post not this session's, so the owner sees where the conversation stands, named by
  // who the engine judged it came from.
  const last = [...watch.context].reverse().find((m) => m.origin !== "this session" && m.origin !== "helper");
  // (Not twice: an agent post that waits is already on the row above.)
  if (last && last !== latestAgentPost && isLive(watch) && !answering) {
    const text = last.origin === "someone's agent" ? agentText(last) : last.text.replace(/\s+/g, " ");
    rows.push(...indent(postRows(postedBy(last), text, inner - 3, 1).map((row) => paint.fg("muted", row))));
  }
  return { rows, pinned: 1 };
}

/**
 * A watch as its panel rows name it: the first in `room` cells (the status follows it), the rest in
 * `rest`.
 * Names (people, channels) are never cut: the first words and the kind of conversation give way,
 * a name that does not fit beside the person goes to rows of its own, and a name wider than a row
 * wraps.
 */
function panelLabel(watch: WatchState, room: number, rest: number): string[] {
  const dm = isDirectMessage(watch.conversation.channelId);
  const bareKind = watch.conversation.kind === "thread" ? "thread" : "top level";
  if (!watch.partner) {
    // Before anyone has answered: the same first words as on the line, cut to leave the kind whole;
    // where the channel leaves them too little, on a row of their own, so fresh threads read apart.
    const kind = dm ? ` · ${bareKind}` : "";
    const label = unnamedLabel(watch, room - visibleWidth(kind));
    const opening = openingWords(watch, rest - QUOTED_EXTRA + 1);
    if (label !== unnamedPrefix(watch) || !opening) return wrapFirst(`${label}${kind}`, room, rest);
    return [...wrapFirst(`${label}${kind}`, room, rest), `"${opening}"`];
  }
  const name = watch.partner.name;
  if (!dm) {
    const channel = `#${channelOf(watch)}`;
    for (const text of [`${threadOf(name)}${channel}`, `${name} ${channel}`]) if (visibleWidth(text) <= room) return [text];
    return [...wrapFirst(name, room, rest), ...wrapTextWithAnsi(channel, rest)];
  }
  // The name and "(DM)" first; the kind of conversation gets what is left: a thread's first words
  // give way to a bare "thread" when too little is left for them; with less than that, the kind
  // (a thread with its first words) goes to a row of its own.
  const who = `${name} ${DM_MARK}`;
  const left = room - visibleWidth(`${who} · `);
  if (left < visibleWidth(bareKind)) return [...wrapFirst(who, room, rest), cut(kindLabel(watch), rest)];
  const kind = kindLabel(watch);
  const fitted = visibleWidth(kind) <= left ? kind : watch.conversation.kind === "thread" && left >= 16 ? cut(kind, left) : bareKind;
  return [`${who} · ${fitted}`];
}

/**
 * `text` wrapped: its first row in `first` cells, the rest in `rest`. A first word too wide for
 * `first` that a whole row holds starts on the next row instead (the first row is then empty), so
 * a name breaks inside a word only when the word is wider than a row.
 */
function wrapFirst(text: string, first: number, rest: number): string[] {
  const word = visibleWidth(text.split(/\s/, 1)[0] ?? "");
  if (word > first && (word <= rest || first < 4)) return ["", ...wrapTextWithAnsi(text, rest)];
  const head = wrapTextWithAnsi(text, first)[0] ?? "";
  const remainder = text.slice(head.length).trimStart();
  return remainder ? [head, ...wrapTextWithAnsi(remainder, rest)] : [head];
}

/** An agent's marker (an emoji or two) in front of its post: "(agent)" or "their agent" already says it. */
const LEADING_SYMBOLS = /^(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)+/u;

/** An agent post's text without its marker (its poster's name says it), unless the marker is all it has. */
function agentText(message: ContextMessage): string {
  const unmarked = message.text.replace(LEADING_SYMBOLS, "");
  return (unmarked.trim() ? unmarked : message.text).replace(/\s+/g, " ");
}

/**
 * A post as `poster: text`: the text on `rows` rows of `width` cells, wrapped, cut on the last.
 * The poster's name is never cut: one that leaves a row too little room for words (fewer than
 * POST_WORDS_MIN cells) gets rows of its own, so no row ends a whole name with "…".
 */
function postRows(poster: string, text: string, width: number, rows: number): string[] {
  const fit = (line: string) => {
    const wrapped = wrapTextWithAnsi(line, width);
    return wrapped.length > rows ? [...wrapped.slice(0, rows - 1), cut(wrapped.slice(rows - 1).join(" "), width)] : wrapped;
  };
  return visibleWidth(`${poster}: `) + POST_WORDS_MIN > width ? [...wrapTextWithAnsi(`${poster}:`, width), ...fit(text)] : fit(`${poster}: ${text}`);
}

/** Cells a post's words need beside its poster's name to share the row. */
const POST_WORDS_MIN = 8;

/** Who posted a kept message, as the panel names them. */
function postedBy(message: ContextMessage): string {
  const name = message.userName;
  const { origin } = message;
  switch (origin) {
    case "owner's other agent":
      return "you (another agent)";
    case "owner":
      return "you";
    case "someone's agent":
      return `${name} (agent)`;
    case "person":
    case "this session":
    case "helper":
      return name;
    default: {
      const unnamed: never = origin;
      return unnamed;
    }
  }
}

/** The selection column in front of every item row ("› " or two spaces). */
const POINTER_WIDTH = 2;
/** Rows the panel adds around its content: the frame's top and bottom, a blank row and the keys. */
const CHROME_ROWS = 4;

function frame(rows: string[], width: number, title: string, paint: Paint): string[] {
  const inner = width - 4;
  const titleWidth = visibleWidth(title);
  const top = `${paint.fg("border", "╭─ ")}${title}${paint.fg("border", ` ${"─".repeat(Math.max(0, width - titleWidth - 5))}╮`)}`;
  const body = rows.map((row) => {
    // Rows are cut plain before painting; this only guards a row that still came out too wide.
    const fitted = truncateToWidth(row, inner, "…");
    return `${paint.fg("border", "│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${paint.fg("border", "│")}`;
  });
  return [top, ...body, paint.fg("border", `╰${"─".repeat(width - 2)}╯`)];
}

export interface PanelView {
  /** The selected item. */
  selected: number;
  /** How far the selected item's scrolling rows are scrolled, when it is taller than the panel. */
  offset: number;
  allEnded: boolean;
  /** Requests whose last line the owner has seen: only those can be approved. */
  read: ReadonlySet<string>;
}

export interface PanelRender {
  lines: string[];
  items: PanelItem[];
  /** The selected item, as layoutPanel clamped it. */
  selected: number;
  /** The scroll offset actually used (clamped to the item). */
  offset: number;
  /** Is the selected item's last row in view? */
  selectedEndInView: boolean;
  /** Rows of the selected item below the window. */
  selectedRowsBelow: number;
  /** Rows the window shows of a tall item (one page). */
  pageRows: number;
  /** Items whose first row is in view. */
  shown: PanelItem[];
}

export function layoutPanel(surface: SurfaceState, view: PanelView, paint: Paint, width: number, openedAt: number, maxRows = 40): PanelRender {
  const inner = Math.max(20, width - 4);
  const waiting = surface.engine.approvals.filter((a) => a.status === "pending").length;
  const title = `${paint.fg("accent", paint.bold("Slack"))}${waiting ? paint.fg("muted", ` · ${waiting} waiting`) : ""}`;
  const wrapped = (text: string, color: PaintColor) => wrapTextWithAnsi(text, inner).map((r) => paint.fg(color, r));
  const items = surface.problem || !surface.enabled ? [] : panelItems(surface, openedAt, view.allEnded);
  const message = (rows: string[]): PanelRender => ({
    // A message longer than the panel is cut with a mark; the panel never grows past its rows.
    lines: frame([...(rows.length > Math.max(1, maxRows - CHROME_ROWS) ? [...rows.slice(0, Math.max(1, maxRows - CHROME_ROWS) - 1), paint.fg("muted", "…")] : rows), "", paint.fg("muted", "esc close")], width, title, paint),
    items, selected: 0, offset: 0, selectedEndInView: true, selectedRowsBelow: 0, pageRows: 0, shown: [],
  });
  if (surface.problem) return message([paint.fg("error", `Can't watch: ${surface.problem.title}`), "", ...wrapped(surface.problem.detail, "text")]);
  if (!surface.enabled) return message(wrapped("slack-companion is off. Run /slack on to turn it on. Then each Slack message your session sends starts a watch.", "muted"));
  if (!items.length) return message(wrapped("Nothing watched yet. A Slack message your session sends starts a watch. /slack <link> watches a conversation someone else started.", "muted"));
  const selected = Math.min(view.selected, items.length - 1);
  const blocks = items.map((item, index) => {
    const { rows, pinned } = itemRows(item, surface, paint, inner - POINTER_WIDTH, index === selected);
    rows[0] = `${index === selected ? paint.fg("accent", "›") : " "} ${rows[0]}`;
    for (let i = 1; i < rows.length; i += 1) rows[i] = `  ${rows[i]}`;
    return { rows, pinned };
  });
  // The keys row wraps by whole keys in a narrow panel; its widest form sets the rows it keeps.
  const keyRows = (item: PanelItem | undefined, approvable: boolean, move: boolean) =>
    [keysFor(item, approvable), move ? "↑↓ move" : "", "esc close"].filter(Boolean).flatMap((k) => k.split(" · ")).reduce<string[]>((rows, key) => {
      const last = rows.at(-1);
      if (last !== undefined && visibleWidth(`${last} · ${key}`) <= inner) rows[rows.length - 1] = `${last} · ${key}`;
      else rows.push(key);
      return rows;
    }, []);
  const widestKeys = keyRows(items[selected], true, false).length;
  const budget = Math.max(4, maxRows - CHROME_ROWS - (widestKeys - 1));
  const content: string[] = [];
  const sel = blocks[selected]!;
  const above = selected;
  const belowItems = blocks.length - 1 - selected;
  let offset = 0;
  let below = 0;
  let pageRows = 0;
  let shown: PanelItem[] = [];
  // Where the selected item's last row landed in the content, when it is in it.
  let selectedEnd = -1;
  if (sel.rows.length + (above ? 1 : 0) + 1 > budget) {
    // Taller than the panel: its header stays pinned, the rest scrolls in a window; one marker
    // row above (items before it) and one below (lines of this item left, and items after it).
    // At most what leaves the window a row and its marker: the rest of the head scrolls with it.
    const pinned = Math.min(sel.pinned, Math.max(1, budget - (above ? 1 : 0) - 2));
    const scrolling = sel.rows.slice(pinned);
    pageRows = Math.max(1, budget - (above ? 1 : 0) - pinned - 1);
    offset = Math.max(0, Math.min(view.offset, scrolling.length - pageRows));
    below = scrolling.length - offset - pageRows;
    if (above) content.push(paint.fg("muted", `↑ ${above} more`));
    content.push(...sel.rows.slice(0, pinned), ...scrolling.slice(offset, offset + pageRows));
    if (below <= 0) selectedEnd = content.length - 1;
    const selItem = items[selected]!;
    const unread = selItem.kind === "approval" && selItem.approval.status === "pending" && !view.read.has(selItem.approval.id);
    // The marker row: what is left of this item, why to read on, and how to page. Longer forms
    // give way to shorter ones until one fits; the paging hint goes last.
    const more = belowItems ? `${belowItems} more below` : "";
    const forms: string[][] = below > 0
      ? [
          [`↓ ${below} more line${below === 1 ? "" : "s"}`, unread ? "read to the end to approve" : "", "space next page", more],
          [`↓ ${below} more line${below === 1 ? "" : "s"}`, unread ? "read to the end to approve" : "", "space next page"],
          [`↓ ${below} more`, unread ? "read all to approve" : "", "space pages"],
          [`↓ ${below} more`, unread ? "read all to approve" : "space pages"],
          [`↓ ${below} more`],
        ]
      : [["(end of this item)", more], ["(end of this item)"]];
    const room = inner - POINTER_WIDTH - 2;
    const marker = forms.map((f) => f.filter(Boolean)).find((f) => visibleWidth(f.join(" · ")) <= room) ?? forms.at(-1)!.filter(Boolean);
    content.push(paint.fg("muted", `  ${marker.join(" · ")}`));
    shown = [items[selected]!];
  } else {
    // Whole items around the selection; the ↑/↓ markers count toward the budget.
    let first = selected;
    let last = selected;
    const height = (f: number, l: number) => {
      let rows = (f > 0 ? 1 : 0) + (l < blocks.length - 1 ? 1 : 0);
      for (let i = f; i <= l; i += 1) rows += blocks[i]!.rows.length + (i > f ? 1 : 0);
      return rows;
    };
    for (;;) {
      if (last + 1 < blocks.length && height(first, last + 1) <= budget) last += 1;
      else if (first > 0 && height(first - 1, last) <= budget) first -= 1;
      else break;
    }
    if (first > 0) content.push(paint.fg("muted", `↑ ${first} more`));
    blocks.slice(first, last + 1).forEach((block, i) => {
      if (i > 0) content.push("");
      content.push(...block.rows);
      if (first + i === selected) selectedEnd = content.length - 1;
    });
    if (last < blocks.length - 1) content.push(paint.fg("muted", `↓ ${blocks.length - 1 - last} more`));
    shown = items.slice(first, last + 1);
  }
  const item = items[selected];
  // An item's end counts as seen only when its last row is within the panel's rows (after the
  // frame's top): Pi's overlay cuts what is taller, so a request is never approvable from rows
  // that never reached the screen.
  const endInView = selectedEnd >= 0 && 1 + selectedEnd < maxRows;
  const approvable = item?.kind === "approval" && (endInView || view.read.has(item.approval.id));
  // The keys row: action keys and "esc close" always; "↑↓ move" gives way when the row is short.
  let keys = keyRows(item, approvable, items.length > 1 || below > 0);
  if (keys.length > 1) keys = keyRows(item, approvable, false);
  content.push("", ...keys.map((row) => paint.fg("muted", row)));
  return { lines: frame(content, width, title, paint), items, selected, offset, selectedEndInView: endInView, selectedRowsBelow: Math.max(0, below), pageRows, shown };
}

/** The panel's rows (at most `maxRows`): see layoutPanel. */
export function renderPanel(surface: SurfaceState, selected: number, paint: Paint, width: number, openedAt: number, maxRows = 40): string[] {
  return layoutPanel(surface, { selected, offset: 0, allEnded: false, read: new Set() }, paint, width, openedAt, maxRows).lines;
}

function itemId(item: PanelItem): string {
  return item.kind === "approval" ? `a:${item.approval.id}` : item.kind === "watch" ? `w:${item.watch.key}` : "ended";
}

export type PanelAction =
  | { kind: "approve"; id: string }
  | { kind: "deny"; id: string }
  | { kind: "stop"; key: string }
  | { kind: "resume"; key: string }
  | { kind: "rewatch"; key: string };

/** The panel component; actions go back through `act`, never straight to state. */
export class Panel implements Component {
  private view: { selected: number; offset: number; allEnded: boolean } = { selected: 0, offset: 0, allEnded: false };
  private readonly openedAt: number;
  private readonly read = new Set<string>();
  /** At the end of a tall item, the first ↓ stays; the next one moves on. */
  private heldAtEnd = false;
  private lastWidth = 80;

  constructor(
    private readonly surface: () => SurfaceState,
    private readonly paint: Paint,
    private readonly act: (action: PanelAction) => void,
    private readonly close: () => void,
    private readonly tui?: TUI,
    private readonly rows: () => number = () => panelRows(process.stdout.rows || 40),
    /** Told which error stops the owner has now seen on screen. */
    private readonly markSeen: (errorIds: string[]) => void = () => {},
  ) {
    const opened = surface();
    this.openedAt = opened.now;
    this.seenAtOpen = new Set(opened.seenErrors);
  }

  /** Stops already seen when the panel opened: the order uses these, so marking rows seen never reshuffles the list under the cursor. */
  private readonly seenAtOpen: ReadonlySet<string>;

  private orderedSurface(): SurfaceState {
    return { ...this.surface(), seenErrors: this.seenAtOpen };
  }

  invalidate(): void {}

  /** The selected item's identity, so the selection follows it when items are added or reordered. */
  private selectedId: string | undefined;

  private layout(width = this.lastWidth): PanelRender {
    if (this.selectedId !== undefined) {
      const index = panelItems(this.orderedSurface(), this.openedAt, this.view.allEnded).findIndex((i) => itemId(i) === this.selectedId);
      if (index >= 0 && index !== this.view.selected) this.view = { ...this.view, selected: index };
    }
    const render = layoutPanel(this.orderedSurface(), { ...this.view, read: this.read }, this.paint, width, this.openedAt, this.rows());
    this.view.selected = render.selected;
    this.view.offset = render.offset;
    this.selectedId = render.items[render.selected] ? itemId(render.items[render.selected]!) : undefined;
    const item = render.items[render.selected];
    if (render.selectedEndInView && item?.kind === "approval") this.read.add(item.approval.id);
    // Only stops not seen before: telling the owner's surface again would ask for another frame, forever.
    const known = this.surface().seenErrors;
    const seen = render.shown.flatMap((i) => (i.kind === "watch" && i.watch.status === "error" && !known.has(errorId(i.watch)) ? [errorId(i.watch)] : []));
    if (seen.length) this.markSeen(seen);
    return render;
  }

  render(width: number): string[] {
    this.lastWidth = width;
    return this.layout(width).lines;
  }

  handleInput(data: string): void {
    const before = this.layout();
    const item = before.items[before.selected];
    const select = (index: number, atEnd = false) => {
      if (index < 0 || index >= before.items.length || index === this.view.selected) return;
      // Entering a tall item from below lands at its end, the way it was left.
      this.view = { ...this.view, selected: index, offset: atEnd ? Number.MAX_SAFE_INTEGER : 0 };
      this.selectedId = itemId(before.items[index]!);
      this.heldAtEnd = false;
    };
    const tall = before.pageRows > 0;
    if (matchesKey(data, Key.escape) || data === "q") return this.close();
    if (!before.items.length) return; // a message state (off, a problem, nothing watched) has nothing to move to
    if (matchesKey(data, Key.up)) {
      if (tall && this.view.offset > 0) this.view.offset -= 1;
      else select(Math.max(0, this.view.selected - 1), true);
      this.heldAtEnd = false;
    } else if (matchesKey(data, Key.down)) {
      if (before.selectedRowsBelow > 0) this.view.offset += 1;
      else if (tall && !this.heldAtEnd) this.heldAtEnd = true;
      else select(Math.min(before.items.length - 1, this.view.selected + 1));
    } else if (matchesKey(data, Key.pageDown) || data === " ") {
      if (before.selectedRowsBelow > 0) this.view.offset += before.pageRows;
      else select(Math.min(before.items.length - 1, this.view.selected + 1));
    } else if (matchesKey(data, Key.pageUp)) {
      if (tall && this.view.offset > 0) this.view.offset = Math.max(0, this.view.offset - before.pageRows);
      else select(Math.max(0, this.view.selected - 1), true);
    } else if (matchesKey(data, Key.enter) && item?.kind === "ended") this.view.allEnded = true;
    else if (item?.kind === "approval" && item.approval.status === "pending" && data === "a" && this.read.has(item.approval.id)) this.act({ kind: "approve", id: item.approval.id });
    else if (item?.kind === "approval" && item.approval.status === "pending" && data === "d") this.act({ kind: "deny", id: item.approval.id });
    else if (item?.kind === "watch" && isLive(item.watch) && data === "s") this.act({ kind: "stop", key: item.watch.key });
    else if (item?.kind === "watch" && item.watch.status === "paused" && data === "r") this.act({ kind: "resume", key: item.watch.key });
    else if (item?.kind === "watch" && !isLive(item.watch) && data === "w") this.act({ kind: "rewatch", key: item.watch.key });
    this.layout();
    this.tui?.requestRender();
  }
}
