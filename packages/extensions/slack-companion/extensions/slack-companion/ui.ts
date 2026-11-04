// The owner's surface: one line above the editor, and a panel on a key.
// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md — Slack activity lives here,
// never as rows in main's transcript. Graphite: brightness carries hierarchy, color only state.
import { type Component, Key, matchesKey, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Approval, type EngineState, isLive, type WatchState, watchLabel } from "./engine.ts";
import { isDirectMessage } from "./conversation.ts";

export type PaintColor = "accent" | "dim" | "muted" | "warning" | "error" | "success" | "text" | "borderMuted";

export interface Paint {
  fg(color: PaintColor, text: string): string;
  bold(text: string): string;
}

export const WIDGET_KEY = "slack-companion";

export interface SurfaceState {
  enabled: boolean;
  /** A problem with the whole package (no adapter, bad config, a missing tool), shown instead of watches. */
  problem?: string;
  engine: EngineState;
  panelKey: string;
  /** Watches whose helper is answering right now. */
  answering: ReadonlySet<string>;
  /** Watches that stopped with an error the owner has not opened the panel on since. */
  unseenErrors: number;
  now: number;
}

interface LineEntry {
  label: string;
  paused?: string;
  note: string;
  answering: boolean;
}

/** One entry per person in a direct message (its top level and its threads), one per channel thread. */
function lineEntries(surface: SurfaceState): LineEntry[] {
  const groups = new Map<string, WatchState[]>();
  for (const watch of surface.engine.watches.filter(isLive)) {
    const id = isDirectMessage(watch.conversation.channelId) ? watch.conversation.channelId : watch.key;
    groups.set(id, [...(groups.get(id) ?? []), watch]);
  }
  return [...groups.values()].map((watches) => {
    const named = watches.find((w) => w.partner) ?? watches[0]!;
    const paused = watches.find((w) => w.status === "paused");
    const answering = watches.some((w) => surface.answering.has(w.key));
    const noted = [...watches].reverse().find((w) => w.lastNote);
    return { label: watchLabel(named), ...(paused ? { paused: paused.reason ?? "paused" } : {}), note: answering ? "answering…" : noted?.lastNote ?? "watching", answering };
  });
}

export function renderLine(surface: SurfaceState, paint: Paint, width: number): string[] {
  if (surface.problem) return [truncateToWidth(`${paint.fg("error", "●")} ${paint.fg("muted", "slack")} ${paint.fg("text", surface.problem)}`, width, "…")];
  if (!surface.enabled) return [];
  const entries = lineEntries(surface);
  const waiting = surface.engine.approvals.filter((a) => a.status === "pending").length;
  if (!entries.length && !waiting && !surface.unseenErrors) return [];
  const sep = paint.fg("dim", "  │  ");
  const dotColor: PaintColor = surface.unseenErrors ? "error" : waiting || entries.some((e) => e.paused) ? "warning" : "muted";
  const head = `${paint.fg(dotColor, "●")} ${paint.fg("muted", "slack")}`;
  // The parts the glance exists for are laid out first; watches share what is left.
  const tail = [
    waiting ? paint.fg("warning", `${waiting} waiting for you`) : "",
    surface.unseenErrors ? paint.fg("error", `${surface.unseenErrors} stopped`) : "",
    paint.fg("muted", surface.panelKey),
  ].filter(Boolean).join(sep);
  const room = width - visibleWidth(head) - visibleWidth(tail) - 2 * visibleWidth("  │  ");
  const parts: string[] = [];
  if (entries.length && room > 12) {
    const each = Math.max(12, Math.floor((room - (entries.length - 1) * 5) / entries.length));
    const shown = entries.slice(0, Math.max(1, Math.floor((room + 5) / (each + 5))));
    for (const entry of shown) {
      const state = entry.paused ? paint.fg("warning", `paused: ${entry.paused}`) : paint.fg(entry.answering ? "accent" : "text", entry.note);
      parts.push(truncateToWidth(`${paint.fg("muted", entry.label)} ${state}`, each, "…"));
    }
    if (entries.length > shown.length) parts.push(paint.fg("muted", `+${entries.length - shown.length}`));
  }
  return [truncateToWidth([head, ...parts, tail].join(sep), width, "…")];
}

export type PanelItem =
  | { kind: "approval"; approval: Approval }
  | { kind: "watch"; watch: WatchState }
  | { kind: "ended"; count: number };

const ENDED_SHOWN = 3;

/** Requests first (waiting, then those resolved while the panel is open), then live watches, then the latest ended ones. */
export function panelItems(state: EngineState, openedAt: number): PanelItem[] {
  const approvals: PanelItem[] = state.approvals
    .filter((a) => a.status === "pending" || (a.resolvedAt !== undefined && a.resolvedAt >= openedAt))
    .map((approval) => ({ kind: "approval", approval }));
  const live: PanelItem[] = state.watches.filter(isLive).reverse().map((watch) => ({ kind: "watch", watch }));
  const ended = state.watches.filter((w) => !isLive(w)).reverse();
  const endedItems: PanelItem[] = ended.slice(0, ENDED_SHOWN).map((watch) => ({ kind: "watch", watch }));
  if (ended.length > ENDED_SHOWN) endedItems.push({ kind: "ended", count: ended.length - ENDED_SHOWN });
  return [...approvals, ...live, ...endedItems];
}

function age(now: number, at: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function keysFor(item: PanelItem | undefined): string {
  if (item?.kind === "approval") return item.approval.status === "pending" ? "a approve · d deny" : "";
  if (item?.kind !== "watch") return "";
  if (item.watch.status === "paused") return "r resume · s stop";
  if (item.watch.status === "active") return "s stop watching";
  return "w watch again";
}

/** Rows for one item, `inner` cells wide; the caller adds the selection column in front. */
function itemRows(item: PanelItem, surface: SurfaceState, paint: Paint, inner: number): string[] {
  const indent = (rows: string[]) => rows.map((r) => `   ${r}`);
  if (item.kind === "ended") return [paint.fg("muted", `${item.count} more ended`)];
  if (item.kind === "approval") {
    const { approval } = item;
    const pending = approval.status === "pending";
    const head = pending
      ? `${paint.fg("warning", "◐ waiting for your OK")} ${paint.fg("muted", `· ${approval.requester} in ${approval.label} · ${age(surface.now, approval.at)}`)}`
      : paint.fg("muted", `${approval.status === "approved" ? "✓ approved — sent to your session" : "✗ declined"} · ${approval.requester} in ${approval.label}`);
    // The whole request, wrapped, never cut: exactly what main receives if approved.
    const body = wrapTextWithAnsi(approval.text, inner - 3).map((row) => (pending ? paint.fg("text", row) : paint.fg("dim", row)));
    return [head, ...indent(body)];
  }
  const { watch } = item;
  const label = watchLabel(watch);
  const answering = surface.answering.has(watch.key);
  const status = {
    active: answering ? paint.fg("accent", "● answering…") : paint.fg("success", "● watching"),
    paused: paint.fg("warning", "○ paused"),
    stopped: paint.fg("muted", "· ended"),
    error: paint.fg("error", "× stopped"),
  }[watch.status];
  const rows = [`${paint.fg(isLive(watch) ? "text" : "muted", label)}  ${status}`];
  if (watch.reason && watch.status !== "active") rows.push(...indent(wrapTextWithAnsi(watch.reason, inner - 3).map((r) => paint.fg(watch.status === "error" ? "error" : "muted", r))));
  if (watch.lastNote) rows.push(...indent([paint.fg("text", truncateToWidth(`last: ${watch.lastNote}`, inner - 3, "…"))]));
  const last = [...watch.context].reverse().find((m) => !watch.ownPosts.includes(m.ts));
  if (last && isLive(watch)) rows.push(...indent([paint.fg("muted", truncateToWidth(`${last.userName}: ${last.text.replace(/\s+/g, " ")}`, inner - 3, "…"))]));
  return rows;
}

/** The selection column in front of every item row ("› " or two spaces). */
const POINTER_WIDTH = 2;

function frame(rows: string[], width: number, title: string, paint: Paint): string[] {
  const inner = width - 4;
  const top = `╭─ ${title} ${"─".repeat(Math.max(0, width - visibleWidth(title) - 5))}╮`;
  const body = rows.map((row) => {
    const cut = truncateToWidth(row, inner, "…");
    return `${paint.fg("borderMuted", "│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${paint.fg("borderMuted", "│")}`;
  });
  return [paint.fg("borderMuted", top), ...body, paint.fg("borderMuted", `╰${"─".repeat(width - 2)}╯`)];
}

export function renderPanel(surface: SurfaceState, selected: number, paint: Paint, width: number, openedAt: number, maxRows = 40): string[] {
  const inner = Math.max(20, width - 4);
  const wrapped = (text: string, color: PaintColor) => wrapTextWithAnsi(text, inner).map((r) => paint.fg(color, r));
  const content: string[] = [];
  if (surface.problem) {
    content.push(...wrapped(surface.problem, "error"));
    return frame([...content, "", paint.fg("muted", "esc close")], width, "Slack", paint);
  }
  if (!surface.enabled) {
    content.push(...wrapped("slack-companion is off. /slack on turns it on: then a Slack message your session sends starts a watch.", "muted"));
    return frame([...content, "", paint.fg("muted", "esc close")], width, "Slack", paint);
  }
  const items = panelItems(surface.engine, openedAt);
  if (!items.length) {
    content.push(...wrapped("Nothing watched yet. A Slack message your session sends starts a watch; /slack <link> watches a conversation someone else started.", "muted"));
    return frame([...content, "", paint.fg("muted", "esc close")], width, "Slack", paint);
  }
  const blocks = items.map((item, index) => {
    const rows = itemRows(item, surface, paint, inner - POINTER_WIDTH);
    rows[0] = `${index === selected ? paint.fg("accent", "›") : " "} ${rows[0]}`;
    for (let i = 1; i < rows.length; i += 1) rows[i] = `  ${rows[i]}`;
    return rows;
  });
  const keys = [keysFor(items[selected]), items.length > 1 ? "↑↓ move" : "", "esc close"].filter(Boolean).join(" · ");
  // Keep the selected item in view: show whole blocks around it within the height available.
  const budget = Math.max(6, maxRows - 4);
  let first = selected;
  let last = selected;
  let used = blocks[selected]!.length;
  while (true) {
    const next = last + 1 < blocks.length && used + blocks[last + 1]!.length + 1 <= budget ? last + 1 : -1;
    if (next >= 0) { last = next; used += blocks[next]!.length + 1; continue; }
    const prev = first - 1 >= 0 && used + blocks[first - 1]!.length + 1 <= budget ? first - 1 : -1;
    if (prev >= 0) { first = prev; used += blocks[prev]!.length + 1; continue; }
    break;
  }
  if (first > 0) content.push(paint.fg("muted", `↑ ${first} more`));
  blocks.slice(first, last + 1).forEach((rows, i) => {
    if (i > 0) content.push("");
    content.push(...rows);
  });
  if (last < blocks.length - 1) content.push(paint.fg("muted", `↓ ${blocks.length - 1 - last} more`));
  content.push("", paint.fg("muted", keys));
  return frame(content, width, "Slack", paint);
}

export type PanelAction =
  | { kind: "approve"; id: string }
  | { kind: "deny"; id: string }
  | { kind: "stop"; key: string }
  | { kind: "resume"; key: string }
  | { kind: "rewatch"; key: string };

/** The panel component; actions go back through `act`, never straight to state. */
export class Panel implements Component {
  private selected = 0;
  private readonly openedAt: number;

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

  render(width: number): string[] {
    return renderPanel(this.surface(), this.selected, this.paint, width, this.openedAt, this.rows());
  }

  handleInput(data: string): void {
    const items = panelItems(this.surface().engine, this.openedAt);
    const item = items[this.selected];
    if (matchesKey(data, Key.escape) || data === "q") return this.close();
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, items.length - 1), this.selected + 1);
    else if (item?.kind === "approval" && item.approval.status === "pending" && data === "a") this.act({ kind: "approve", id: item.approval.id });
    else if (item?.kind === "approval" && item.approval.status === "pending" && data === "d") this.act({ kind: "deny", id: item.approval.id });
    else if (item?.kind === "watch" && isLive(item.watch) && data === "s") this.act({ kind: "stop", key: item.watch.key });
    else if (item?.kind === "watch" && item.watch.status === "paused" && data === "r") this.act({ kind: "resume", key: item.watch.key });
    else if (item?.kind === "watch" && !isLive(item.watch) && data === "w") this.act({ kind: "rewatch", key: item.watch.key });
    this.selected = Math.min(this.selected, Math.max(0, panelItems(this.surface().engine, this.openedAt).length - 1));
    this.tui?.requestRender();
  }
}
