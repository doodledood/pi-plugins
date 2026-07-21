import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, type KeyId } from "@earendil-works/pi-tui";
import { isThinkingLevel, THINKING_LEVELS, type PanelistSpec, type PanelistState, type ThinkingLevel } from "./types.ts";

export interface ThemeLike {
  bold(text: string): string;
  fg(role: string, text: string): string;
}

// ---------------------------------------------------------------------------
// Shared formatting primitives (pure)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function spinnerFrame(now: number): string {
  return SPINNER_FRAMES[Math.floor(now / 250) % SPINNER_FRAMES.length] as string;
}

const STATUS_GLYPHS: Record<PanelistState["status"], string> = {
  pending: "○",
  running: "◐",
  done: "●",
  error: "✗",
  cancelled: "◌",
};

const STATUS_ROLES: Record<PanelistState["status"], string> = {
  pending: "dim",
  running: "accent",
  done: "text",
  error: "error",
  cancelled: "dim",
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
 * Truncate to a DISPLAY width (ANSI- and wide-glyph-aware): panelist
 * transcripts are arbitrary model output — CJK text and tabs occupy more
 * columns than code units, and code-unit clipping would blow out the panes.
 */
export function clipText(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  return `${sliceByColumn(text, 0, Math.max(0, width - 1), true)}…`;
}

function padTo(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

// ---------------------------------------------------------------------------
// Cost estimation (pure; ASM-9: display-only best effort)
// ---------------------------------------------------------------------------

export interface PriceLookup {
  /** Dollars per million input tokens for a "provider/id" model ref; undefined when unknown. */
  (modelRef: string): number | undefined;
}

/**
 * Drop a trailing ":<thinkingLevel>" from a model ref (the config contract
 * allows "provider/id:level" refs) so registry lookups see the bare id.
 */
export function stripThinkingSuffix(modelRef: string): string {
  const colon = modelRef.lastIndexOf(":");
  if (colon <= 0) return modelRef;
  const suffix = modelRef.slice(colon + 1);
  return isThinkingLevel(suffix) ? modelRef.slice(0, colon) : modelRef;
}

/**
 * Rough panel cost: fork tokens × each selected model's input price. Ignores
 * output/tool-loop costs by design — it exists to make "two xhigh models over
 * a 100k fork" visibly expensive before enter is pressed, not to bill.
 */
export function estimatePanelCostUsd(
  specs: readonly PanelistSpec[],
  forkTokens: number,
  price: PriceLookup,
): number | undefined {
  let total = 0;
  let priced = 0;
  for (const spec of specs) {
    const perMillion = price(spec.model);
    if (perMillion === undefined) continue;
    total += (forkTokens / 1_000_000) * perMillion;
    priced++;
  }
  return priced > 0 ? total : undefined;
}

// ---------------------------------------------------------------------------
// Picker state (pure) + component
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

function providerOf(modelRef: string): string {
  const slash = modelRef.indexOf("/");
  return slash > 0 ? modelRef.slice(0, slash) : "";
}

function modelIdOf(modelRef: string): string {
  const slash = modelRef.indexOf("/");
  return slash > 0 ? modelRef.slice(slash + 1) : modelRef;
}

/** Bordered picker rendering: header (count + rough cost), rows with segmented effort + provider column. */
export function formatPickerLines(
  state: PickerState,
  estimate: number | undefined,
  theme: ThemeLike,
): string[] {
  const inner = 58;
  const selectedCount = state.selection().length;
  const estText = estimate !== undefined ? ` · est ~$${estimate.toFixed(2)}` : "";
  const title = ` Panel lineup · ${selectedCount} selected${estText} `;
  const top = `┌─${title}${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}┐`;
  const lines = [theme.fg("accent", top)];
  lines.push(
    `│ ${padTo(theme.fg("dim", "‹enter› run  ‹space› select  ‹←/→› effort  ‹esc› back"), inner - 1)}│`,
  );
  state.rows.forEach((row, i) => {
    const cursor = i === state.cursor ? "›" : " ";
    const mark = row.selected ? theme.fg("accent", "●") : theme.fg("dim", "○");
    const model = padTo(clipText(modelIdOf(row.spec.model), 24), 24);
    const effort = padTo(`‹ ${row.spec.thinking} ›`, 11);
    const provider = theme.fg("dim", padTo(clipText(providerOf(row.spec.model), 12), 12));
    const body = `${cursor} ${mark} ${model} ${effort} ${provider}`;
    lines.push(`│ ${padTo(i === state.cursor ? theme.bold(body) : body, inner - 1)}│`);
  });
  if (selectedCount === 0) {
    lines.push(`│ ${padTo(theme.fg("warning", "select at least one panelist"), inner - 1)}│`);
  }
  lines.push(theme.fg("accent", `└${"─".repeat(inner)}┘`));
  return lines;
}

export class PanelPickerComponent {
  readonly width = 62;
  focused = false;

  constructor(
    private readonly theme: ThemeLike,
    private readonly state: PickerState,
    private readonly estimate: (specs: readonly PanelistSpec[]) => number | undefined,
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
    return formatPickerLines(this.state, this.estimate(this.state.selection()), this.theme);
  }
}

// ---------------------------------------------------------------------------
// Ambient bar (pure formatting)
// ---------------------------------------------------------------------------

/**
 * The slim always-visible run surface: rendered by a focused non-overlay
 * component in the editor slot, so the chat transcript stays visible above it.
 */
export function formatAmbientLines(
  states: readonly PanelistState[],
  now: number,
  inspectKeyText: string,
  theme: ThemeLike,
  width = 120,
): string[] {
  const running = states.filter((s) => s.status === "running" || s.status === "pending").length;
  const startedAt = Math.min(...states.map((s) => s.startedAt));
  const spinner = running > 0 ? theme.fg("accent", spinnerFrame(now)) : theme.fg("dim", "▣");
  const header = `${spinner} ${theme.bold("panel")} · ${formatDuration(now - startedAt)} · ${theme.fg(
    "dim",
    `esc cancel · ${inspectKeyText} inspect`,
  )}`;
  const lines = [header];
  for (const state of states) {
    const glyph = theme.fg(STATUS_ROLES[state.status], STATUS_GLYPHS[state.status]);
    const label = padTo(clipText(`${modelIdOf(state.spec.model)} ${state.spec.thinking}`, 26), 26);
    const elapsed = formatDuration((state.endedAt ?? now) - state.startedAt);
    const cost = formatCost(state.cost);
    const stats = [elapsed, formatTokens(state.tokens), ...(cost ? [cost] : [])].join(" · ");
    lines.push(`  ${glyph} ${label} ${padTo(stats, 24)} ${theme.fg("dim", clipText(state.activity, 32))}`);
  }
  // Non-overlay components get no platform truncation net: every emitted line
  // must fit the viewport or the terminal hard-wraps and corrupts the frame.
  return lines.map((line) => truncateToWidth(line, width, "…"));
}

// ---------------------------------------------------------------------------
// Drill-in split view (pure)
// ---------------------------------------------------------------------------

export interface InspectState {
  focus: number;
  zoomed: boolean;
}

export const SPLIT_MAX_PANELISTS = 3;

function panelistHeaderLines(state: PanelistState, now: number, width: number, theme: ThemeLike): string[] {
  const glyph = theme.fg(STATUS_ROLES[state.status], STATUS_GLYPHS[state.status]);
  const title = `${glyph} ${theme.bold(clipText(`${modelIdOf(state.spec.model)} · ${state.spec.thinking}`, width - 3))}`;
  const cost = formatCost(state.cost);
  const stats = [
    formatTokens(state.tokens),
    ...(cost ? [cost] : []),
    formatDuration((state.endedAt ?? now) - state.startedAt),
  ].join(" · ");
  return [title, theme.fg("dim", clipText(stats, width)), theme.fg("dim", `▸ ${clipText(state.activity, width - 2)}`)];
}

function paneLines(state: PanelistState, now: number, width: number, height: number, theme: ThemeLike): string[] {
  const header = panelistHeaderLines(state, now, width, theme);
  const divider = theme.fg("dim", "─".repeat(width));
  const bodyHeight = Math.max(1, height - header.length - 1);
  const body = state.transcript.slice(-bodyHeight).map((line) => clipText(line, width));
  while (body.length < bodyHeight) body.push("");
  return [...header, divider, ...body].map((line) => padTo(line, width));
}

/**
 * The drill-in view: side-by-side panes at ≤SPLIT_MAX_PANELISTS (or zoomed to
 * one), a chip strip + single pane beyond that or when zoomed.
 */
export function renderInspectView(
  states: readonly PanelistState[],
  inspect: InspectState,
  totalWidth: number,
  now: number,
  theme: ThemeLike,
): string[] {
  const inner = Math.max(20, totalWidth - 2);
  const zoomForced = states.length > SPLIT_MAX_PANELISTS;
  const zoomed = zoomForced || inspect.zoomed;
  const height = 18;
  const focus = Math.min(Math.max(0, inspect.focus), Math.max(0, states.length - 1));

  const title = ` ▣ Panel · ${states.filter((s) => s.status === "running" || s.status === "pending").length} running `;
  const top = theme.fg("accent", `┌─${title}${"─".repeat(Math.max(0, inner - visibleWidth(title) - 1))}┐`);
  const hintText = zoomed
    ? ` esc back · tab ${zoomForced ? "—" : "split"} · 1-${states.length} focus `
    : ` esc back · tab zoom · 1-${states.length} focus `;
  const bottom = theme.fg("accent", `└─${theme.fg("dim", hintText)}${"─".repeat(Math.max(0, inner - visibleWidth(hintText) - 1))}┘`);

  const rows: string[] = [top];
  if (zoomed) {
    const chipStrip = states
      .map((s, i) => {
        const chip = `${STATUS_GLYPHS[s.status]} ${modelIdOf(s.spec.model)}`;
        return i === focus ? theme.bold(theme.fg("accent", `[${chip}]`)) : theme.fg("dim", ` ${chip} `);
      })
      .join(" ");
    rows.push(`│${padTo(truncateToWidth(` ${chipStrip}`, inner, "…"), inner)}│`);
    const pane = states[focus];
    if (pane) for (const line of paneLines(pane, now, inner - 2, height, theme)) rows.push(`│ ${line} │`);
  } else {
    const usable = inner - (states.length - 1) - 2 * states.length;
    const colWidth = Math.floor(usable / states.length);
    // The integer-division remainder goes to the last column so content rows
    // line up exactly with the top/bottom borders.
    const remainder = usable - colWidth * states.length;
    const panes = states.map((s, i) =>
      paneLines(s, now, colWidth + (i === states.length - 1 ? remainder : 0), height, theme),
    );
    const paneHeight = Math.max(...panes.map((p) => p.length));
    for (let r = 0; r < paneHeight; r++) {
      const cells = panes.map((p, i) => ` ${padTo(p[r] ?? "", colWidth + (i === states.length - 1 ? remainder : 0))} `);
      rows.push(`│${cells.join(theme.fg("dim", "│"))}│`);
    }
  }
  rows.push(bottom);
  // Belt over the per-cell clipping: no emitted row may exceed the frame.
  return rows.map((row) => (visibleWidth(row) > inner + 2 ? truncateToWidth(row, inner + 2, "…") : row));
}

// ---------------------------------------------------------------------------
// Result rendering (pure; index.ts wraps into TUI components)
// ---------------------------------------------------------------------------

export interface AnswerDetailsLike {
  model?: string;
  thinking?: string;
  ok?: boolean;
  cancelled?: boolean;
  elapsedMs?: number;
  tokens?: number;
  cost?: number;
  /** First line of the raw answer, provided at build time by results.ts. */
  preview?: string;
}

/** First non-empty line of a raw answer, quoted and clipped, for the collapsed row. */
export function answerPreview(rawAnswer: string, maxLength = 56): string {
  const firstLine = rawAnswer.split("\n").find((line) => line.trim()) ?? "";
  return firstLine ? `"${clipText(firstLine.trim(), maxLength)}"` : "";
}

/** Collapsed/expanded transcript lines for one panelist-answer message. */
export function formatAnswerLines(
  details: AnswerDetailsLike,
  content: string,
  expanded: boolean,
  theme: ThemeLike,
): string[] {
  const glyph = details.ok ? "◆" : details.cancelled ? "◌" : "✗";
  const role = details.ok ? "accent" : details.cancelled ? "dim" : "error";
  const stateText = details.ok ? "answered" : details.cancelled ? "cancelled" : "failed";
  const cost = formatCost(details.cost);
  const stats = [formatDuration(details.elapsedMs ?? 0), formatTokens(details.tokens ?? 0), ...(cost ? [cost] : [])].join(
    " · ",
  );
  const label = padTo(clipText(`${details.model ?? "?"} ${details.thinking ?? ""}`.trim(), 28), 28);
  const header = `${theme.fg(role, glyph)} ${theme.bold(`panelist ${label}`)} ${theme.fg("dim", `${stats} · ${stateText}`)}`;
  if (!expanded) {
    const preview = details.ok && details.preview ? answerPreview(details.preview) : "";
    return [`${theme.fg("dim", "▸ ")}${header}${preview ? `  ${theme.fg("dim", preview)}` : ""}`];
  }
  return [`${theme.fg("dim", "▾ ")}${header}`, ...content.split("\n")];
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
// Panel monitor component (ambient bar ⇄ drill-in split view)
// ---------------------------------------------------------------------------

/**
 * The focused component shown for the whole panel run — rendered non-overlay
 * in the editor slot so the chat transcript stays visible. It owns keyboard
 * input while panelists work, which is what makes Esc-cancel real: pi gives
 * extension command handlers no abort signal while the agent is idle.
 *
 * Views: "bar" (slim ambient status lines) and "inspect" (drill-in split
 * view). Esc in bar view cancels the panel; Esc in inspect view returns to
 * the bar. Tab toggles zoom inside inspect; digit keys focus a panelist.
 */
export class PanelMonitorComponent {
  focused = false;
  view: "bar" | "inspect" = "bar";
  readonly inspect: InspectState = { focus: 0, zoomed: false };
  private readonly ticker: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly theme: ThemeLike,
    private readonly getStates: () => readonly PanelistState[],
    private readonly inspectKey: KeyId,
    private readonly onCancel: () => void,
    requestRender?: () => void,
  ) {
    this.ticker = requestRender ? setInterval(requestRender, 250) : undefined;
  }

  invalidate(): void {}

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.view === "inspect") {
        this.view = "bar";
        return;
      }
      this.onCancel();
      return;
    }
    if (matchesKey(data, this.inspectKey) || matchesKey(data, "i")) {
      this.view = this.view === "inspect" ? "bar" : "inspect";
      return;
    }
    if (this.view === "inspect") {
      if (matchesKey(data, "tab")) {
        this.inspect.zoomed = !this.inspect.zoomed;
        return;
      }
      const digit = Number.parseInt(data, 10);
      if (Number.isInteger(digit) && digit >= 1 && digit <= this.getStates().length) {
        this.inspect.focus = digit - 1;
      }
    }
  }

  render(width: number): string[] {
    const states = this.getStates();
    const now = Date.now();
    const lines =
      this.view === "inspect"
        ? renderInspectView(states, this.inspect, Math.min(width, 110), now, this.theme)
        : formatAmbientLines(states, now, this.inspectKey, this.theme, width);
    // Final clamp: pi gives non-overlay components no truncation net, and an
    // overflowing line desynchronizes the differential renderer.
    return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
  }
}
