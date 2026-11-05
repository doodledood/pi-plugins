// The owner's surface: one line above the editor, and a panel on a key.
// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md — Slack activity lives here,
// never as rows in main's transcript. Graphite: brightness carries hierarchy, color only state;
// the line stays quiet (muted) until something needs the owner.
import { type Component, Key, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Approval, DM_MARK, dmLabel, type EngineState, isLive, type WatchState, watchLabel } from "./engine.ts";
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

/** Cut a name from the middle, keeping its start and its end (where names that share a start differ). */
export function cutMiddle(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 2) return cut(text, width);
  const chars = [...text];
  let head = "";
  let tail = "";
  for (let i = 0, j = chars.length - 1; i <= j; ) {
    const next = visibleWidth(head) <= visibleWidth(tail) ? chars[i]! : chars[j]!;
    if (visibleWidth(head) + visibleWidth(tail) + visibleWidth(next) > width - 1) break;
    if (visibleWidth(head) <= visibleWidth(tail)) head += chars[i++]!;
    else tail = chars[j--]! + tail;
  }
  return `${head}…${tail}`;
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
  label: string;
  /** Any of the conversation's watches is paused (counted once per conversation). */
  paused: boolean;
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
/** Cells a channel's name may take on the line before anyone answered, so its first words still show. */
const CHANNEL_NAME_CELLS = 14;
/** Cells the panel keeps for a conversation's first words before it cuts the channel's name. */
const PANEL_OPENING_CELLS = 8;
/** The fewest cells a cut channel name keeps in the panel. */
const CHANNEL_NAME_MIN_CELLS = 7;

/**
 * A conversation as the line and the panel name it before anyone has answered: a DM by its first
 * words, a channel thread by its channel and first words. One spelling for both surfaces. `room`
 * is the cells the whole label may take (the panel's); without it, the line's budget is used.
 */
function unnamedLabel(watch: WatchState, room?: number): string {
  const dm = isDirectMessage(watch.conversation.channelId);
  const channel = watch.channelName || watch.conversation.channelId;
  // The panel names the channel whole unless its first words would get too few cells; the line
  // caps it. Either cuts from the middle, so channels that share a start still read apart.
  const channelCells = room === undefined ? CHANNEL_NAME_CELLS : Math.max(CHANNEL_NAME_MIN_CELLS, room - 4 - PANEL_OPENING_CELLS);
  const prefix = dm ? "DM" : `#${cutMiddle(channel, channelCells)}`;
  // The first words get what is left after the prefix, a space and two quotes.
  const cells = room === undefined ? LINE_OPENING_CELLS : room - visibleWidth(prefix) - 3;
  const opening = cells >= 4 ? openingWords(watch, cells) : undefined;
  if (opening) return `${prefix} "${opening}"`;
  return dm ? dmLabel(undefined) : prefix;
}

/** A conversation as the line names it: the person, and the channel when it is not a DM; before anyone answers, unnamedLabel. */
function lineLabel(watch: WatchState): string {
  const person = watch.partner?.name;
  if (!person) return unnamedLabel(watch);
  return isDirectMessage(watch.conversation.channelId) ? person : `${person} #${watch.channelName || watch.conversation.channelId}`;
}

export type ActiveState = "answering" | "catching up" | "watching";

/** What an active watch is doing, as both the line and the panel say it. */
export function activeState(watch: WatchState, answering: boolean): ActiveState {
  if (answering) return "answering";
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
    const paused = watches.some((w) => w.status === "paused");
    const states = watches.map((w) => activeState(w, surface.answering.has(w.key)));
    const answering = states.includes("answering");
    const latest = [...watches].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    const entry: LineEntry = {
      label: lineLabel(named),
      paused,
      ...(paused ? { word: { text: "paused", color: "warning" as const } } : answering ? { word: LINE_WORD.answering } : states.includes("catching up") ? { word: LINE_WORD["catching up"] } : {}),
      note: latest.find((w) => w.lastNote)?.lastNote ?? "watching",
    };
    return { entry, rank: paused ? 0 : answering ? 1 : 2, at: latest[0]!.lastActivityAt };
  });
  return ranked.sort((a, b) => a.rank - b.rank || b.at - a.at).map((r) => r.entry);
}

/** The line's word for an active state; plain watching has none. */
const LINE_WORD = { answering: { text: "answering…", color: "accent" as const }, "catching up": { text: "catching up", color: "accent" as const } };

/** The panel's status for an active state. */
const PANEL_STATUS: Record<ActiveState, { text: string; color: "accent" | "success" }> = {
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
  // Paused conversations, counted as the line shows them: a DM's top level and its threads are one.
  const pausedCount = entries.filter((e) => e.paused).length;
  const stopped = surface.engine.watches.filter((w) => isUnseenError(surface, w)).length;
  if (!entries.length && !waiting && !stopped) return [];
  const dot: PaintColor = stopped ? "error" : waiting || pausedCount ? "warning" : "muted";
  // Counts in the order they matter: waiting first, then stops, then pauses.
  const counts = (short: boolean, shownPaused: number) => [
    waiting ? paint.fg("warning", short ? `${waiting} waiting` : `${waiting} waiting for you`) : "",
    stopped ? paint.fg("error", `${stopped} stopped`) : "",
    pausedCount > shownPaused ? paint.fg("warning", `${pausedCount} paused`) : "",
  ].filter(Boolean);

  // Watch entries at their natural width, in rank order: an entry shows only if its whole label
  // and its state word (or a useful part of its note) fit; the rest fold into "+N watching".
  // Each form (long words, short words) is built; the long one wins only if it names as many
  // conversations, since the people are what the owner glances for.
  const form = (long: boolean): { line: string; named: number } | undefined => {
    const countsWidth = (shownPaused: number) => counts(!long, shownPaused).reduce((w, c) => w + visibleWidth(c) + SEP.length, 0);
    const room = width - visibleWidth(head(dot)) - 2 - visibleWidth(hint(long));
    const chosen: LineEntry[] = [];
    const need = (e: LineEntry) => visibleWidth(e.label) + (e.word ? 1 + visibleWidth(e.word.text) : PAIR.length + Math.min(visibleWidth(e.note), NOTE_MIN));
    const used = () => chosen.reduce((w, e) => w + SEP.length + need(e), 0);
    // Folded watches are counted as "watching"; a paused one is already in the paused count.
    const foldCount = (k: number) => entries.slice(k).filter((e) => !e.paused).length;
    const fold = (k: number) => (foldCount(k) ? SEP.length + visibleWidth(`${k ? "+" : ""}${foldCount(k)} watching`) : 0);
    const shownPausedOf = (list: LineEntry[]) => list.filter((e) => e.paused).length;
    for (const entry of entries) {
      const next = [...chosen, entry];
      const total = used() + SEP.length + need(entry) + fold(next.length) + countsWidth(shownPausedOf(next));
      if (total > room) break;
      chosen.push(entry);
    }
    // Space left over goes to the shown notes, in rank order.
    let spare = room - used() - fold(chosen.length) - countsWidth(shownPausedOf(chosen));
    if (spare < 0) return undefined;
    const parts = chosen.map((e) => {
      // A state word (paused, answering…) reads as the conversation's state; a note, as an event.
      if (e.word) return `${paint.fg("muted", e.label)} ${paint.fg(e.word.color, e.word.text)}`;
      const base = Math.min(visibleWidth(e.note), NOTE_MIN);
      const extra = Math.max(0, Math.min(visibleWidth(e.note) - base, spare));
      spare -= extra;
      return `${paint.fg("muted", e.label)}${paint.fg("dim", PAIR)}${paint.fg("muted", cut(e.note, base + extra))}`;
    });
    if (foldCount(chosen.length)) parts.push(paint.fg("muted", `${chosen.length ? "+" : ""}${foldCount(chosen.length)} watching`));
    const left = [head(dot), ...parts, ...counts(!long, shownPausedOf(chosen))].join(sep);
    return fits(left, long) ? { line: compose(left, long), named: chosen.length } : undefined;
  };
  const long = form(true);
  const short = form(false);
  if (long && (!short || long.named >= short.named)) return [long.line];
  if (short) return [short.line];
  // Too narrow even for the counts in full: keep them in priority order until they fit.
  const all = counts(true, 0);
  // Keep "slack" and drop the lowest count first; only then drop the word.
  for (let k = all.length; k >= 1; k -= 1) {
    const left = [head(dot), ...all.slice(0, k)].join(sep);
    if (fits(left, false)) return [compose(left, false)];
  }
  for (let k = all.length; k >= 1; k -= 1) {
    const left = [` ${paint.fg(dot, "●")}`, ...all.slice(0, k)].join(sep);
    if (fits(left, false)) return [compose(left, false)];
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
 * paused watches; stops with an error he has not seen; watches answering now; the other live
 * watches, most recently active first; then ended ones (errors already seen, and the latest few
 * quiet ends, newest first; the rest fold into "N more ended" unless `allEnded`).
 */
export function panelItems(surface: SurfaceState, openedAt: number, allEnded = false): PanelItem[] {
  const state = surface.engine;
  const approvals: PanelItem[] = state.approvals
    .filter((a) => a.status === "pending" || (a.resolvedAt !== undefined && a.resolvedAt >= openedAt))
    .map((approval) => ({ kind: "approval", approval }));
  const byActivity = (a: WatchState, b: WatchState) => b.lastActivityAt - a.lastActivityAt;
  const byEnd = (a: WatchState, b: WatchState) => (b.endedAt ?? 0) - (a.endedAt ?? 0);
  const live = state.watches.filter(isLive);
  const paused = live.filter((w) => w.status === "paused").sort(byActivity);
  const answering = live.filter((w) => w.status === "active" && surface.answering.has(w.key)).sort(byActivity);
  const rest = live.filter((w) => w.status === "active" && !surface.answering.has(w.key)).sort(byActivity);
  const errors = state.watches.filter((w) => w.status === "error").sort(byEnd);
  const unseen = errors.filter((w) => isUnseenError(surface, w));
  const seen = errors.filter((w) => !isUnseenError(surface, w));
  const quiet = state.watches.filter((w) => w.status === "stopped").sort(byEnd);
  const shownQuiet = allEnded ? quiet : quiet.slice(0, ENDED_SHOWN);
  const watches: PanelItem[] = [...paused, ...unseen, ...answering, ...rest, ...seen, ...shownQuiet].map((watch) => ({ kind: "watch", watch }));
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
  const ownThread = `${approval.requester}'s thread in `;
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
    const head = pending
      ? `${paint.fg("warning", strong("◐ waiting for your OK"))} ${paint.fg("muted", `· ${age(surface.now, approval.at)}`)}`
      : paint.fg("muted", approval.status === "approved" ? "✓ approved — sent to your session" : "✗ declined");
    // The whole request, wrapped, never cut: exactly what main receives if approved.
    const body = wrapTextWithAnsi(approval.text, inner - 3).map((row) => (pending ? paint.fg("text", row) : paint.fg("dim", row)));
    return { rows: [head, ...indent([paint.fg("muted", cut(`from ${requestSource(approval)}`, inner - 3))]), ...indent(body)], pinned: 2 };
  }
  const { watch } = item;
  const answering = surface.answering.has(watch.key);
  const active = PANEL_STATUS[activeState(watch, answering)];
  const status = {
    active: paint.fg(active.color, active.text),
    paused: paint.fg("warning", "○ paused"),
    stopped: paint.fg("muted", "· ended"),
    error: paint.fg("error", "× stopped"),
  }[watch.status];
  const labelRoom = Math.max(10, inner - visibleWidth(status) - 2);
  const bareKind = watch.conversation.kind === "thread" ? "thread" : "top level";
  let label = watchLabel(watch);
  if (!watch.partner) {
    // Before anyone has answered: the same first words as on the line, cut to leave the kind whole.
    const kind = isDirectMessage(watch.conversation.channelId) ? ` · ${bareKind}` : "";
    label = `${unnamedLabel(watch, labelRoom - visibleWidth(kind))}${kind}`;
  } else if (isDirectMessage(watch.conversation.channelId)) {
    // The name and "(DM)" first; the kind of conversation gets what is left, and a thread's
    // snippet gives way to a bare "thread" when too little is left for it.
    const who = `${cut(watch.partner.name, Math.max(6, labelRoom - DM_MARK.length - 12))} ${DM_MARK}`;
    const room = labelRoom - visibleWidth(`${who} · `);
    const kind = kindLabel(watch);
    const fitted = visibleWidth(kind) <= room ? kind : watch.conversation.kind === "thread" && room >= 16 ? cut(kind, room) : bareKind;
    label = `${who} · ${fitted}`;
  }
  const rows = [`${paint.fg(isLive(watch) ? "text" : "muted", strong(cut(label, labelRoom)))}  ${status}`];
  if (watch.reason && watch.status !== "active") rows.push(...indent(wrapTextWithAnsi(watch.reason, inner - 3).map((r) => paint.fg(watch.status === "error" ? "error" : "muted", r))));
  for (const entry of (watch.activity ?? []).slice(-3)) rows.push(...indent([paint.fg("dim", cut(`${clock(entry.at)}  ${entry.text}`, inner - 3))]));
  // The latest post not this session's, so the owner sees where the conversation stands: an agent
  // post is marked, and one from another of the owner's own sessions says so.
  const last = [...watch.context].reverse().find((m) => !watch.ownPosts.includes(m.ts));
  if (last && isLive(watch) && !answering) {
    const who = !last.agentFooter ? last.userName : last.userId === surface.engine.owner?.userId ? "you (other session)" : `${last.userName} (agent)`;
    rows.push(...indent([paint.fg("muted", cut(`${who}: ${last.text.replace(/\s+/g, " ")}`, inner - 3))]));
  }
  return { rows, pinned: 1 };
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
  const budget = Math.max(4, maxRows - CHROME_ROWS);
  const content: string[] = [];
  const sel = blocks[selected]!;
  const above = selected;
  const belowItems = blocks.length - 1 - selected;
  let offset = 0;
  let below = 0;
  let pageRows = 0;
  let shown: PanelItem[] = [];
  if (sel.rows.length + (above ? 1 : 0) + 1 > budget) {
    // Taller than the panel: its header stays pinned, the rest scrolls in a window; one marker
    // row above (items before it) and one below (lines of this item left, and items after it).
    const scrolling = sel.rows.slice(sel.pinned);
    pageRows = Math.max(1, budget - (above ? 1 : 0) - sel.pinned - 1);
    offset = Math.max(0, Math.min(view.offset, scrolling.length - pageRows));
    below = scrolling.length - offset - pageRows;
    if (above) content.push(paint.fg("muted", `↑ ${above} more`));
    content.push(...sel.rows.slice(0, sel.pinned), ...scrolling.slice(offset, offset + pageRows));
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
    });
    if (last < blocks.length - 1) content.push(paint.fg("muted", `↓ ${blocks.length - 1 - last} more`));
    shown = items.slice(first, last + 1);
  }
  const item = items[selected];
  const endInView = below <= 0;
  const approvable = item?.kind === "approval" && (endInView || view.read.has(item.approval.id));
  // The keys row: action keys and "esc close" always; "↑↓ move" gives way when the row is short.
  let keys = [keysFor(item, approvable), items.length > 1 || below > 0 ? "↑↓ move" : "", "esc close"].filter(Boolean).join(" · ");
  if (visibleWidth(keys) > inner) keys = [keysFor(item, approvable), "esc close"].filter(Boolean).join(" · ");
  content.push("", paint.fg("muted", keys));
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
