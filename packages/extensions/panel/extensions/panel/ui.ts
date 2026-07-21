import { matchesKey, type KeyId } from "@earendil-works/pi-tui";
import { THINKING_LEVELS, type PanelistSpec, type PanelistState, type ThinkingLevel } from "./types.ts";

// ---------------------------------------------------------------------------
// Picker state (pure, unit-tested; the component below is a thin shell)
// ---------------------------------------------------------------------------

export interface PickerRow {
  spec: PanelistSpec;
  selected: boolean;
}

export class PickerState {
  readonly rows: PickerRow[];
  cursor = 0;

  constructor(lineup: PanelistSpec[], preselected: number[]) {
    const chosen = new Set(preselected);
    this.rows = lineup.map((spec, i) => ({ spec: { ...spec }, selected: chosen.has(i) }));
  }

  move(delta: number): void {
    if (this.rows.length === 0) return;
    this.cursor = Math.min(this.rows.length - 1, Math.max(0, this.cursor + delta));
  }

  toggle(): void {
    const row = this.rows[this.cursor];
    if (row) row.selected = !row.selected;
  }

  cycleEffort(direction: 1 | -1): void {
    const row = this.rows[this.cursor];
    if (!row) return;
    const index = THINKING_LEVELS.indexOf(row.spec.thinking);
    const next = (index + direction + THINKING_LEVELS.length) % THINKING_LEVELS.length;
    row.spec.thinking = THINKING_LEVELS[next] as ThinkingLevel;
  }

  /** Selected specs in lineup order; empty when nothing is selected. */
  selection(): PanelistSpec[] {
    return this.rows.filter((row) => row.selected).map((row) => ({ ...row.spec }));
  }
}

// ---------------------------------------------------------------------------
// Widget line formatting (pure)
// ---------------------------------------------------------------------------

const STATUS_GLYPHS: Record<PanelistState["status"], string> = {
  pending: "○",
  running: "◐",
  done: "●",
  error: "✗",
  cancelled: "◌",
};

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tok`;
  return `${tokens} tok`;
}

export function formatCost(cost: number | undefined): string | undefined {
  if (cost === undefined) return undefined;
  return `$${cost.toFixed(2)}`;
}

/**
 * The compact status lines shown while a panel runs: a header with run state +
 * cancel/inspect hints, one line per panelist (glyph, model+effort, current
 * activity, per-panelist elapsed, tokens, best-effort cost).
 */
export function formatWidgetLines(
  states: readonly PanelistState[],
  now: number,
  inspectKeyText: string,
): string[] {
  const running = states.filter((s) => s.status === "running" || s.status === "pending").length;
  const startedAt = Math.min(...states.map((s) => s.startedAt));
  const header =
    running > 0
      ? `▣ panel · ${running} running · ${formatDuration(now - startedAt)} · esc cancel · ${inspectKeyText} inspect`
      : `▣ panel · finishing`;
  const lines = [header];
  for (const state of states) {
    const glyph = STATUS_GLYPHS[state.status];
    const label = `${state.spec.model} ${state.spec.thinking}`;
    const elapsed = formatDuration((state.endedAt ?? now) - state.startedAt);
    const cost = formatCost(state.cost);
    const stats = [elapsed, formatTokens(state.tokens), ...(cost ? [cost] : [])].join(" · ");
    lines.push(`  ${glyph} ${label}  ${state.activity}  ${stats}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Result rendering (pure; index.ts wraps these into TUI components)
// ---------------------------------------------------------------------------

export interface AnswerDetailsLike {
  model?: string;
  thinking?: string;
  ok?: boolean;
  cancelled?: boolean;
  elapsedMs?: number;
  tokens?: number;
  cost?: number;
}

/** Collapsed/expanded transcript lines for one panelist-answer message. */
export function formatAnswerLines(
  details: AnswerDetailsLike,
  content: string,
  expanded: boolean,
  theme: ThemeLike,
): string[] {
  const glyph = details.ok ? "◆" : details.cancelled ? "◌" : "✗";
  const stateText = details.ok ? "answered" : details.cancelled ? "cancelled" : "failed";
  const cost = formatCost(details.cost);
  const stats = [formatDuration(details.elapsedMs ?? 0), formatTokens(details.tokens ?? 0), ...(cost ? [cost] : [])].join(
    " · ",
  );
  const header = theme.fg(
    details.ok ? "accent" : "warning",
    `${glyph} panelist ${details.model ?? "?"} ${details.thinking ?? ""} · ${stats} · ${stateText}`,
  );
  if (!expanded) return [theme.fg("dim", "▸ ") + header];
  return [theme.fg("dim", "▾ ") + header, ...content.split("\n")];
}

export interface MetaDataLike {
  panelists?: Array<{ model?: string; sessionFile?: string }>;
}

/** Collapsed/expanded transcript lines for the context-excluded metadata row. */
export function formatMetaLines(data: MetaDataLike, expanded: boolean, theme: ThemeLike): string[] {
  const count = data.panelists?.length ?? 0;
  if (!expanded) {
    return [theme.fg("dim", `▸ panel run · ${count} panelist${count === 1 ? "" : "s"} · sessions saved`)];
  }
  const lines = [theme.fg("dim", "▾ panel run")];
  for (const p of data.panelists ?? []) {
    lines.push(theme.fg("dim", `  ${p.model}: ${p.sessionFile ?? "(no session file)"}`));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Inspect overlay model (pure)
// ---------------------------------------------------------------------------

export class OverlayModel {
  index = 0;

  constructor(private readonly states: readonly PanelistState[]) {}

  next(): void {
    if (this.states.length === 0) return;
    this.index = (this.index + 1) % this.states.length;
  }

  current(): PanelistState | undefined {
    return this.states[this.index];
  }

  titleLine(): string {
    const state = this.current();
    if (!state) return "Panelist";
    return `Panelist ${this.index + 1}/${this.states.length}: ${state.spec.model} ${state.spec.thinking} · ${state.activity}`;
  }

  tail(maxLines: number): string[] {
    const state = this.current();
    if (!state) return [];
    return state.transcript.slice(-maxLines);
  }
}

// ---------------------------------------------------------------------------
// TUI components (thin shells over the state above)
// ---------------------------------------------------------------------------

export interface ThemeLike {
  bold(text: string): string;
  fg(role: string, text: string): string;
}

export class PanelPickerComponent {
  readonly width = 64;
  focused = false;

  constructor(
    private readonly theme: ThemeLike,
    private readonly state: PickerState,
    private readonly done: (result: PanelistSpec[] | null) => void,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) return this.done(null);
    if (matchesKey(data, "return")) {
      const selection = this.state.selection();
      if (selection.length > 0) this.done(selection);
      return;
    }
    if (matchesKey(data, "up")) this.state.move(-1);
    else if (matchesKey(data, "down")) this.state.move(1);
    else if (matchesKey(data, "left")) this.state.cycleEffort(-1);
    else if (matchesKey(data, "right")) this.state.cycleEffort(1);
    else if (data === " ") this.state.toggle();
  }

  render(_width: number): string[] {
    const th = this.theme;
    const lines = [th.bold("Panel lineup"), th.fg("dim", "space select · ←/→ effort · enter run · esc cancel")];
    this.state.rows.forEach((row, i) => {
      const cursor = i === this.state.cursor ? "›" : " ";
      const mark = row.selected ? "[x]" : "[ ]";
      const line = `${cursor} ${mark} ${row.spec.model}  ${row.spec.thinking}`;
      lines.push(i === this.state.cursor ? th.bold(line) : line);
    });
    if (this.state.selection().length === 0) {
      lines.push(th.fg("warning", "select at least one panelist"));
    }
    return lines;
  }
}

/**
 * The focused component shown for the whole panel run. It owns keyboard input
 * while panelists work — which is what makes Esc-cancel real: pi gives
 * extension command handlers no abort signal while the agent is idle, so
 * cancellation must come from a UI surface that actually receives input
 * during the run.
 *
 * Views: "status" (compact per-panelist lines) and "inspect" (one panelist's
 * streaming transcript; tab cycles). Esc in status view cancels the panel;
 * Esc in inspect view returns to status.
 */
export class PanelMonitorComponent {
  readonly width = 90;
  focused = false;
  view: "status" | "inspect" = "status";
  private readonly viewport = 30;
  private readonly ticker: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly theme: ThemeLike,
    private readonly model: OverlayModel,
    private readonly getStates: () => readonly PanelistState[],
    private readonly inspectKey: string,
    private readonly onCancel: () => void,
    requestRender?: () => void,
  ) {
    this.ticker = requestRender ? setInterval(requestRender, 1_000) : undefined;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.view === "inspect") {
        this.view = "status";
        return;
      }
      this.onCancel();
      return;
    }
    if (matchesKey(data, this.inspectKey as KeyId) || data === "i") {
      this.view = this.view === "inspect" ? "status" : "inspect";
      return;
    }
    if (this.view === "inspect" && matchesKey(data, "tab")) this.model.next();
  }

  render(_width: number): string[] {
    const th = this.theme;
    if (this.view === "inspect") {
      const lines = [th.bold(this.model.titleLine()), th.fg("dim", "tab next panelist · esc back")];
      for (const line of this.model.tail(this.viewport)) lines.push(line);
      return lines;
    }
    return formatWidgetLines(this.getStates(), Date.now(), this.inspectKey);
  }
}
