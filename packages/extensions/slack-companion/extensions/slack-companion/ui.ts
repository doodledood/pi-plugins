// The owner's surface: one line above the editor, and a panel on a key.
// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md — Slack activity lives here,
// never as rows in main's transcript. Graphite: brightness carries hierarchy, color only state.
import { type Component, Key, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Approval, type EngineState, isLive, type WatchState, watchLabel } from "./engine.ts";
import { isDirectMessage } from "./conversation.ts";

export type PaintColor = "accent" | "dim" | "muted" | "warning" | "error" | "success" | "text" | "border" | "borderMuted";

export interface Paint {
  fg(color: PaintColor, text: string): string;
  bold(text: string): string;
}

export const WIDGET_KEY = "slack-companion";

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
  /** When the owner last opened the panel: watches that stopped with an error after it are unseen. */
  seenAt: number;
  now: number;
}

function unseenErrors(surface: SurfaceState): number {
  return surface.engine.watches.filter((w) => w.status === "error" && (w.endedAt ?? 0) > surface.seenAt).length;
}

// ---------------------------------------------------------------------------------------------
// The line above the editor
// ---------------------------------------------------------------------------------------------

interface LineEntry {
  label: string;
  state: "paused" | "answering" | "idle";
  note: string;
  lastActivityAt: number;
}

/** A conversation as the line names it: the person, and the channel when it is not a DM. */
function lineLabel(watch: WatchState): string {
  const person = watch.partner?.name ?? "someone";
  if (isDirectMessage(watch.conversation.channelId)) return person;
  return `${person} #${watch.channelName || watch.conversation.channelId}`;
}

/** One entry per person in a direct message (its top level and its threads), one per channel thread. */
function lineEntries(surface: SurfaceState): LineEntry[] {
  const groups = new Map<string, WatchState[]>();
  for (const watch of surface.engine.watches.filter(isLive)) {
    const id = isDirectMessage(watch.conversation.channelId) ? watch.conversation.channelId : watch.key;
    groups.set(id, [...(groups.get(id) ?? []), watch]);
  }
  const entries = [...groups.values()].map((watches): LineEntry => {
    const named = watches.find((w) => w.partner) ?? watches[0]!;
    const state = watches.some((w) => w.status === "paused") ? "paused" : watches.some((w) => surface.answering.has(w.key)) ? "answering" : "idle";
    const noted = [...watches].sort((a, b) => (a.activity?.at(-1)?.at ?? 0) - (b.activity?.at(-1)?.at ?? 0)).reverse().find((w) => w.lastNote);
    return { label: lineLabel(named), state, note: noted?.lastNote ?? "watching", lastActivityAt: Math.max(...watches.map((w) => w.lastActivityAt)) };
  });
  // What needs the owner first, then the most recently active.
  const rank = { paused: 0, answering: 1, idle: 2 } as const;
  return entries.sort((a, b) => rank[a.state] - rank[b.state] || b.lastActivityAt - a.lastActivityAt);
}

/** The narrowest a watch entry may be: room for a name, its channel and a short state. */
const ENTRY_MIN = 26;

export function renderLine(surface: SurfaceState, paint: Paint, width: number): string[] {
  const sep = paint.fg("dim", " · ");
  const sepWidth = 3;
  const hint = (long: boolean) => paint.fg("dim", long ? `${surface.panelKey} opens` : surface.panelKey);
  const head = (color: PaintColor) => ` ${paint.fg(color, "●")} ${paint.fg("muted", "slack")}`;
  // Left part, then the key hint right-aligned; the left part gives way first, the hint never.
  const compose = (left: string, longHint = true): string => {
    const h = hint(longHint);
    const room = width - visibleWidth(h) - 2;
    if (room < 8) return truncateToWidth(`${left} ${h}`, width, "…");
    const cut = truncateToWidth(left, room, "…");
    return `${cut}${" ".repeat(Math.max(2, width - visibleWidth(cut) - visibleWidth(h)))}${h}`;
  };
  if (surface.problem) return [compose(`${head("error")} ${paint.fg("text", `can't watch: ${surface.problem.title}`)}`)];
  if (!surface.enabled) return [];
  const entries = lineEntries(surface);
  const waiting = surface.engine.approvals.filter((a) => a.status === "pending").length;
  const paused = entries.filter((e) => e.state === "paused").length;
  const stopped = unseenErrors(surface);
  if (!entries.length && !waiting && !stopped) return [];
  const counts = (short: boolean) => [
    waiting ? paint.fg("warning", short ? `${waiting} waiting` : `${waiting} waiting for you`) : "",
    paused ? paint.fg("warning", `${paused} paused`) : "",
    stopped ? paint.fg("error", `${stopped} stopped`) : "",
  ].filter(Boolean);
  const dot: PaintColor = stopped ? "error" : waiting || paused ? "warning" : "muted";
  for (const short of [false, true]) {
    const fixed = [head(dot), ...counts(short)].join(sep);
    const hintWidth = visibleWidth(hint(!short));
    // Room for watch entries, between the counts and the hint (with a two-cell gap before it).
    const avail = width - visibleWidth(fixed) - hintWidth - 2 - sepWidth;
    let shown = 0;
    let each = 0;
    for (let k = entries.length; k >= 1; k -= 1) {
      const rest = entries.length - k;
      const reserve = rest ? sepWidth + visibleWidth(`+${rest} watching`) : 0;
      const per = Math.floor((avail - reserve - (k - 1) * sepWidth) / k);
      if (per >= ENTRY_MIN) {
        shown = k;
        each = per;
        break;
      }
    }
    if (!short || shown > 0 || visibleWidth(fixed) + hintWidth + 2 <= width) {
      const parts = entries.slice(0, shown).map((e) => {
        // The state word stays whole; the label gives way to it, and a note gives way to both.
        const word = e.state === "paused" ? "paused" : e.state === "answering" ? "answering…" : "";
        const labelRoom = Math.max(6, each - (word ? visibleWidth(word) + 1 : Math.min(12, Math.floor(each / 2))));
        const label = truncateToWidth(e.label, labelRoom, "…");
        const room = each - visibleWidth(label) - 1;
        const state = word ? paint.fg(e.state === "paused" ? "warning" : "accent", word) : paint.fg("text", truncateToWidth(e.note, Math.max(0, room), "…"));
        return truncateToWidth(`${paint.fg("muted", label)} ${state}`, each, "…");
      });
      const rest = entries.length - shown;
      if (rest) parts.push(paint.fg("muted", shown ? `+${rest} watching` : `${rest} watching`));
      const left = [head(dot), ...parts, ...counts(short)].join(sep);
      if (visibleWidth(left) + hintWidth + 2 <= width) return [compose(left, !short)];
      if (short) {
        // Too narrow for any watch: the counts and the key are what the glance is for.
        const bare = [head(dot), ...counts(short)].join(sep);
        return [compose(visibleWidth(bare) + hintWidth + 2 <= width ? bare : [` ${paint.fg(dot, "●")}`, ...counts(short)].join(sep), false)];
      }
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
 * Requests first (waiting, then those resolved while the panel is open), then live watches, then
 * ended ones: every one that stopped with an error (the owner may need `w` on it), and the latest
 * few that ended quietly, newest first; the rest fold into "N more ended" unless `allEnded`.
 */
export function panelItems(state: EngineState, openedAt: number, allEnded = false): PanelItem[] {
  const approvals: PanelItem[] = state.approvals
    .filter((a) => a.status === "pending" || (a.resolvedAt !== undefined && a.resolvedAt >= openedAt))
    .map((approval) => ({ kind: "approval", approval }));
  const live: PanelItem[] = state.watches.filter(isLive).reverse().map((watch) => ({ kind: "watch", watch }));
  const byEnd = (a: WatchState, b: WatchState) => (b.endedAt ?? 0) - (a.endedAt ?? 0);
  const errors = state.watches.filter((w) => w.status === "error").sort(byEnd);
  const quiet = state.watches.filter((w) => w.status === "stopped").sort(byEnd);
  const shownQuiet = allEnded ? quiet : quiet.slice(0, ENDED_SHOWN);
  const ended: PanelItem[] = [...errors, ...shownQuiet].map((watch) => ({ kind: "watch", watch }));
  if (quiet.length > shownQuiet.length) ended.push({ kind: "ended", count: quiet.length - shownQuiet.length });
  return [...approvals, ...live, ...ended];
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
  const root = watch.context.find((m) => m.ts === conversation.threadTs);
  const text = root?.text.replace(/^\S*🤖\s*/u, "").replace(/\*\*[^*]+\*\*[^\n]*\n+/, "").replace(/\s+/g, " ").trim() ?? "";
  if (!text) return "thread";
  return `thread "${text.length > 32 ? `${text.slice(0, 32).trimEnd()}…` : text}"`;
}

function keysFor(item: PanelItem | undefined, fullySeen: boolean): string {
  if (item?.kind === "ended") return "enter show all";
  if (item?.kind === "approval") return item.approval.status !== "pending" ? "" : fullySeen ? "a approve · d deny" : "↓ read to the end to approve · d deny";
  if (item?.kind !== "watch") return "";
  if (item.watch.status === "paused") return "r resume · s stop";
  if (item.watch.status === "active") return "s stop watching";
  return "w watch again";
}

/** Rows for one item, `inner` cells wide; the caller adds the selection column in front. */
function itemRows(item: PanelItem, surface: SurfaceState, paint: Paint, inner: number, selected: boolean): string[] {
  const indent = (rows: string[]) => rows.map((r) => `   ${r}`);
  const strong = (text: string) => (selected ? paint.bold(text) : text);
  if (item.kind === "ended") return [paint.fg("muted", `${item.count} more ended`)];
  if (item.kind === "approval") {
    const { approval } = item;
    const pending = approval.status === "pending";
    const from = approval.label === `${approval.requester} (DM)` ? approval.label : `${approval.requester} · ${approval.label}`;
    const head = pending
      ? `${paint.fg("warning", strong("◐ waiting for your OK"))} ${paint.fg("muted", `· ${age(surface.now, approval.at)}`)}`
      : paint.fg("muted", approval.status === "approved" ? "✓ approved — sent to your session" : "✗ declined");
    // The whole request, wrapped, never cut: exactly what main receives if approved.
    const body = wrapTextWithAnsi(approval.text, inner - 3).map((row) => (pending ? paint.fg("text", row) : paint.fg("dim", row)));
    return [head, ...indent([paint.fg("muted", truncateToWidth(`from ${from}`, inner - 3, "…"))]), ...indent(body)];
  }
  const { watch } = item;
  const answering = surface.answering.has(watch.key);
  const status = {
    active: answering ? paint.fg("accent", "● answering…") : paint.fg("success", "● watching"),
    paused: paint.fg("warning", "○ paused"),
    stopped: paint.fg("muted", "· ended"),
    error: paint.fg("error", "× stopped"),
  }[watch.status];
  const label = isDirectMessage(watch.conversation.channelId) ? `${watchLabel(watch)} · ${kindLabel(watch)}` : watchLabel(watch);
  const rows = [`${paint.fg(isLive(watch) ? "text" : "muted", strong(truncateToWidth(label, Math.max(10, inner - 14), "…")))}  ${status}`];
  if (watch.reason && watch.status !== "active") rows.push(...indent(wrapTextWithAnsi(watch.reason, inner - 3).map((r) => paint.fg(watch.status === "error" ? "error" : "muted", r))));
  const activity = (watch.activity ?? []).slice(-3);
  for (const entry of activity) rows.push(...indent([paint.fg("dim", truncateToWidth(`${clock(entry.at)}  ${entry.text}`, inner - 3, "…"))]));
  const last = [...watch.context].reverse().find((m) => !watch.ownPosts.includes(m.ts) && !m.agentFooter);
  if (last && isLive(watch) && !answering) rows.push(...indent([paint.fg("muted", truncateToWidth(`${last.userName}: ${last.text.replace(/\s+/g, " ")}`, inner - 3, "…"))]));
  return rows;
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
    const cut = truncateToWidth(row, inner, "…");
    return `${paint.fg("border", "│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${paint.fg("border", "│")}`;
  });
  return [top, ...body, paint.fg("border", `╰${"─".repeat(width - 2)}╯`)];
}

export interface PanelView {
  /** The selected item. */
  selected: number;
  /** First row of the selected item shown, when it is taller than the panel. */
  offset: number;
  allEnded: boolean;
}

export interface PanelRender {
  lines: string[];
  /** Did the owner see the last row of the selected item? */
  selectedFullySeen: boolean;
  /** Rows of the selected item below the window. */
  selectedRowsBelow: number;
}

export function layoutPanel(surface: SurfaceState, view: PanelView, paint: Paint, width: number, openedAt: number, maxRows = 40): PanelRender {
  const inner = Math.max(20, width - 4);
  const waiting = surface.engine.approvals.filter((a) => a.status === "pending").length;
  const title = `${paint.fg("accent", paint.bold("Slack"))}${waiting ? paint.fg("muted", ` · ${waiting} waiting`) : ""}`;
  const wrapped = (text: string, color: PaintColor) => wrapTextWithAnsi(text, inner).map((r) => paint.fg(color, r));
  const message = (rows: string[]): PanelRender => ({ lines: frame([...rows, "", paint.fg("muted", "esc close")], width, title, paint), selectedFullySeen: true, selectedRowsBelow: 0 });
  if (surface.problem) return message([paint.fg("error", `Can't watch: ${surface.problem.title}`), "", ...wrapped(surface.problem.detail, "text")]);
  if (!surface.enabled) return message(wrapped("slack-companion is off. Run /slack on to turn it on. Then each Slack message your session sends starts a watch.", "muted"));
  const items = panelItems(surface.engine, openedAt, view.allEnded);
  if (!items.length) return message(wrapped("Nothing watched yet. A Slack message your session sends starts a watch. /slack <link> watches a conversation someone else started.", "muted"));
  const selected = Math.min(view.selected, items.length - 1);
  const blocks = items.map((item, index) => {
    const rows = itemRows(item, surface, paint, inner - POINTER_WIDTH, index === selected);
    rows[0] = `${index === selected ? paint.fg("accent", "›") : " "} ${rows[0]}`;
    for (let i = 1; i < rows.length; i += 1) rows[i] = `  ${rows[i]}`;
    return rows;
  });
  const budget = Math.max(3, maxRows - CHROME_ROWS);
  const content: string[] = [];
  let fullySeen = true;
  let below = 0;
  const sel = blocks[selected]!;
  if (sel.length + (selected > 0 ? 1 : 0) + (selected < blocks.length - 1 ? 1 : 0) > budget) {
    // Taller than the panel: a window into the selected item, its markers counted in the budget.
    const markers = (selected > 0 ? 1 : 0) + (selected < blocks.length - 1 ? 1 : 0);
    const windowRows = Math.max(1, budget - markers - 1);
    const offset = Math.max(0, Math.min(view.offset, sel.length - windowRows));
    below = sel.length - offset - windowRows;
    fullySeen = below <= 0;
    if (selected > 0) content.push(paint.fg("muted", `↑ ${selected} more`));
    content.push(...sel.slice(offset, offset + windowRows));
    content.push(paint.fg("muted", below > 0 ? `  ↓ ${below} more line${below === 1 ? "" : "s"} of this item` : "  (end of this item)"));
    if (selected < blocks.length - 1) content.push(paint.fg("muted", `↓ ${blocks.length - 1 - selected} more`));
  } else {
    // Whole blocks around the selection; the ↑/↓ markers count toward the budget.
    let first = selected;
    let last = selected;
    const height = (f: number, l: number) => {
      let rows = (f > 0 ? 1 : 0) + (l < blocks.length - 1 ? 1 : 0);
      for (let i = f; i <= l; i += 1) rows += blocks[i]!.length + (i > f ? 1 : 0);
      return rows;
    };
    for (;;) {
      if (last + 1 < blocks.length && height(first, last + 1) <= budget) last += 1;
      else if (first > 0 && height(first - 1, last) <= budget) first -= 1;
      else break;
    }
    if (first > 0) content.push(paint.fg("muted", `↑ ${first} more`));
    blocks.slice(first, last + 1).forEach((rows, i) => {
      if (i > 0) content.push("");
      content.push(...rows);
    });
    if (last < blocks.length - 1) content.push(paint.fg("muted", `↓ ${blocks.length - 1 - last} more`));
  }
  // The keys row: the action keys and "esc close" always; "↑↓ move" gives way when the row is short.
  let keys = [keysFor(items[selected], fullySeen), items.length > 1 || below > 0 ? "↑↓ move" : "", "esc close"].filter(Boolean).join(" · ");
  if (visibleWidth(keys) > inner) keys = [keysFor(items[selected], fullySeen), "esc close"].filter(Boolean).join(" · ");
  content.push("", paint.fg("muted", keys));
  return { lines: frame(content, width, title, paint), selectedFullySeen: fullySeen, selectedRowsBelow: Math.max(0, below) };
}

/** The panel's rows (at most `maxRows`): see layoutPanel. */
export function renderPanel(surface: SurfaceState, selected: number, paint: Paint, width: number, openedAt: number, maxRows = 40): string[] {
  return layoutPanel(surface, { selected, offset: 0, allEnded: false }, paint, width, openedAt, maxRows).lines;
}

export type PanelAction =
  | { kind: "approve"; id: string }
  | { kind: "deny"; id: string }
  | { kind: "stop"; key: string }
  | { kind: "resume"; key: string }
  | { kind: "rewatch"; key: string };

/** The panel component; actions go back through `act`, never straight to state. */
export class Panel implements Component {
  private view: PanelView = { selected: 0, offset: 0, allEnded: false };
  private readonly openedAt: number;
  /** Requests whose last line the owner has seen: only those can be approved. */
  private readonly read = new Set<string>();
  private lastWidth = 80;

  constructor(
    private readonly surface: () => SurfaceState,
    private readonly paint: Paint,
    private readonly act: (action: PanelAction) => void,
    private readonly close: () => void,
    private readonly tui?: TUI,
    private readonly rows: () => number = () => Math.floor((process.stdout.rows || 40) * 0.8),
  ) {
    this.openedAt = surface().now;
  }

  invalidate(): void {}

  private layout(width = this.lastWidth): PanelRender {
    const render = layoutPanel(this.surface(), this.view, this.paint, width, this.openedAt, this.rows());
    const item = this.items()[this.view.selected];
    if (render.selectedFullySeen && item?.kind === "approval") this.read.add(item.approval.id);
    return render;
  }

  private items(): PanelItem[] {
    return panelItems(this.surface().engine, this.openedAt, this.view.allEnded);
  }

  render(width: number): string[] {
    this.lastWidth = width;
    return this.layout(width).lines;
  }

  handleInput(data: string): void {
    const items = this.items();
    const item = items[this.view.selected];
    const { selectedRowsBelow } = this.layout();
    if (matchesKey(data, Key.escape) || data === "q") return this.close();
    const select = (index: number) => {
      if (index !== this.view.selected) this.view = { ...this.view, selected: index, offset: 0 };
    };
    if (matchesKey(data, Key.up)) {
      if (this.view.offset > 0) this.view.offset -= 1;
      else select(Math.max(0, this.view.selected - 1));
    } else if (matchesKey(data, Key.down)) {
      // Inside a tall item, ↓ scrolls it first; at its end, ↓ moves on.
      if (selectedRowsBelow > 0) this.view.offset += 1;
      else select(Math.min(Math.max(0, items.length - 1), this.view.selected + 1));
    } else if (matchesKey(data, Key.enter) && item?.kind === "ended") this.view.allEnded = true;
    else if (item?.kind === "approval" && item.approval.status === "pending" && data === "a" && this.read.has(item.approval.id)) this.act({ kind: "approve", id: item.approval.id });
    else if (item?.kind === "approval" && item.approval.status === "pending" && data === "d") this.act({ kind: "deny", id: item.approval.id });
    else if (item?.kind === "watch" && isLive(item.watch) && data === "s") this.act({ kind: "stop", key: item.watch.key });
    else if (item?.kind === "watch" && item.watch.status === "paused" && data === "r") this.act({ kind: "resume", key: item.watch.key });
    else if (item?.kind === "watch" && !isLive(item.watch) && data === "w") this.act({ kind: "rewatch", key: item.watch.key });
    this.view.selected = Math.min(this.view.selected, Math.max(0, this.items().length - 1));
    this.layout();
    this.tui?.requestRender();
  }
}
