// The owner's surface: one line above the editor, and a panel on a key.
// Holds docs/adr/20261104-show-slack-activity-in-a-dock-line.md — Slack activity lives here,
// never as rows in main's transcript. Graphite: brightness carries hierarchy, color only state.
import { type Component, Key, matchesKey, truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { Approval, EngineState, WatchState } from "./engine.ts";
import { firstLine } from "./messages.ts";

export interface Paint {
  fg(color: "accent" | "dim" | "muted" | "warning" | "error" | "success" | "text", text: string): string;
  bold(text: string): string;
}

export const WIDGET_KEY = "slack-companion";

export interface SurfaceState {
  enabled: boolean;
  /** A problem with the whole package (no adapter, bad config), shown instead of watches. */
  problem?: string;
  engine: EngineState;
  panelKey: string;
}

function liveWatches(state: EngineState): WatchState[] {
  return state.watches.filter((w) => w.status === "active" || w.status === "paused");
}

function waitingFor(state: EngineState, watchKey?: string): Approval[] {
  return state.approvals.filter((a) => a.status === "pending" && (!watchKey || a.watchKey === watchKey));
}

function recentError(state: EngineState): WatchState | undefined {
  return [...state.watches].reverse().find((w) => w.status === "error");
}

/** The single line, or nothing when there is nothing to show. */
export function renderLine(surface: SurfaceState, paint: Paint, width: number): string[] {
  const { engine } = surface;
  if (surface.problem) return [truncateToWidth(`${paint.fg("error", "●")} ${paint.fg("muted", "slack")} ${paint.fg("text", surface.problem)}`, width, "…")];
  if (!surface.enabled) return [];
  const live = liveWatches(engine);
  const error = recentError(engine);
  const waiting = waitingFor(engine);
  if (!live.length && !error) return [];
  const parts: string[] = [];
  const dot = waiting.length ? paint.fg("warning", "●") : live.some((w) => w.status === "paused") ? paint.fg("warning", "○") : paint.fg("success", "●");
  parts.push(`${dot} ${paint.fg("muted", "slack")}`);
  const shown = live.slice(-2);
  for (const watch of shown) {
    const state = watch.status === "paused" ? paint.fg("warning", `paused (${watch.reason ?? "paused"})`) : paint.fg("dim", watch.lastNote ?? "watching");
    parts.push(`${paint.fg("text", watch.label)} ${state}`);
  }
  if (live.length > shown.length) parts.push(paint.fg("dim", `+${live.length - shown.length} more`));
  if (waiting.length) parts.push(paint.fg("warning", `${waiting.length} waiting for you`));
  if (error && !live.length) parts.push(paint.fg("error", `stopped: ${error.label} — ${error.reason ?? "error"}`));
  parts.push(paint.fg("dim", surface.panelKey));
  return [truncateToWidth(parts.join(paint.fg("dim", " · ")), width, "…")];
}

export type PanelItem =
  | { kind: "approval"; approval: Approval; watch?: WatchState }
  | { kind: "watch"; watch: WatchState };

/** Approvals first (they are why the owner opened it), then watches, newest first. */
export function panelItems(state: EngineState): PanelItem[] {
  const byKey = new Map(state.watches.map((w) => [w.key, w]));
  const approvals: PanelItem[] = waitingFor(state).map((approval) => {
    const watch = byKey.get(approval.watchKey);
    return watch ? { kind: "approval", approval, watch } : { kind: "approval", approval };
  });
  const watches: PanelItem[] = [...state.watches].reverse().map((watch) => ({ kind: "watch", watch }));
  return [...approvals, ...watches];
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    out.push(line);
  }
  return out;
}

export function renderPanel(surface: SurfaceState, selected: number, paint: Paint, width: number): string[] {
  const inner = Math.max(20, width - 4);
  const lines: string[] = [paint.bold(paint.fg("text", "Slack")) + paint.fg("dim", " · watched conversations and requests")];
  lines.push("");
  if (surface.problem) lines.push(paint.fg("error", surface.problem), "");
  if (!surface.enabled) {
    lines.push(paint.fg("muted", "slack-companion is off. /slack on turns it on: then a Slack message your session sends starts a watch."));
    lines.push("", paint.fg("dim", "esc close"));
    return lines.map((l) => truncateToWidth(l, width, "…"));
  }
  const items = panelItems(surface.engine);
  if (!items.length) lines.push(paint.fg("muted", "Nothing watched yet. A Slack message your session sends starts a watch; /slack <link> attaches one someone else started."));
  items.forEach((item, index) => {
    const pointer = index === selected ? paint.fg("accent", "›") : " ";
    if (item.kind === "approval") {
      const { approval, watch } = item;
      lines.push(`${pointer} ${paint.fg("warning", "◐ waiting for your OK")} ${paint.fg("dim", `· ${approval.requester} · ${watch?.label ?? "ended conversation"}`)}`);
      // The full text: exactly what main receives if approved.
      for (const row of wrap(approval.text, inner)) lines.push(`    ${paint.fg("text", row)}`);
    } else {
      const { watch } = item;
      const status = {
        active: paint.fg("success", "● watching"),
        paused: paint.fg("warning", `○ paused — ${watch.reason ?? ""}`),
        stopped: paint.fg("dim", `· ended — ${watch.reason ?? ""}`),
        error: paint.fg("error", `× stopped — ${watch.reason ?? ""}`),
      }[watch.status];
      lines.push(`${pointer} ${paint.fg(watch.status === "active" || watch.status === "paused" ? "text" : "muted", watch.label)} ${status}`);
      if (watch.lastNote) lines.push(`    ${paint.fg("dim", `last: ${watch.lastNote}`)}`);
      const last = watch.context.at(-1);
      if (last && (watch.status === "active" || watch.status === "paused")) lines.push(`    ${paint.fg("muted", `${last.userName}: ${firstLine(last.text, inner - 10)}`)}`);
    }
  });
  lines.push("");
  const current = items[selected];
  const keys = current?.kind === "approval"
    ? "a approve · d deny"
    : current?.kind === "watch" && current.watch.status === "paused"
      ? "r resume · s stop"
      : current?.kind === "watch" && current.watch.status === "active"
        ? "s stop watching"
        : "";
  lines.push(paint.fg("dim", [keys, "↑↓ move", "esc close"].filter(Boolean).join(" · ")));
  return lines.map((l) => truncateToWidth(l, width, "…"));
}

export type PanelAction =
  | { kind: "approve"; id: string }
  | { kind: "deny"; id: string }
  | { kind: "stop"; key: string }
  | { kind: "resume"; key: string };

/** The panel component; actions go back through `act`, never straight to state. */
export class Panel implements Component {
  private selected = 0;
  constructor(
    private readonly surface: () => SurfaceState,
    private readonly paint: Paint,
    private readonly act: (action: PanelAction) => void,
    private readonly close: () => void,
    private readonly tui?: TUI,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    return renderPanel(this.surface(), this.selected, this.paint, width);
  }

  handleInput(data: string): void {
    const items = panelItems(this.surface().engine);
    const item = items[this.selected];
    if (matchesKey(data, Key.escape) || data === "q") return this.close();
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down)) this.selected = Math.min(Math.max(0, items.length - 1), this.selected + 1);
    else if (item?.kind === "approval" && data === "a") this.act({ kind: "approve", id: item.approval.id });
    else if (item?.kind === "approval" && data === "d") this.act({ kind: "deny", id: item.approval.id });
    else if (item?.kind === "watch" && data === "s") this.act({ kind: "stop", key: item.watch.key });
    else if (item?.kind === "watch" && data === "r") this.act({ kind: "resume", key: item.watch.key });
    this.selected = Math.min(this.selected, Math.max(0, panelItems(this.surface().engine).length - 1));
    this.tui?.requestRender();
  }
}
