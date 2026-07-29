/**
 * The ruling dialog: what the user actually looks at when they decide.
 *
 * Kept as a model and a pure renderer, the way the fleet card is, so the layout can
 * be asserted on without a terminal. The component in `tools.ts` only feeds keys in
 * and paints lines out.
 *
 * Several packets are one dialog with a tab each, because a batch of small decisions
 * is one sitting, not one dialog per decision. Nothing is applied until submit, so
 * moving between tabs costs nothing and Esc leaves everything pending.
 */

import type { Packet } from "./types.ts";

/** The slice of pi's theme this uses, declared so tests can pass a plain one. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
}

/** A theme that adds nothing, for asserting on layout rather than colour. */
export const PLAIN_THEME: ThemeLike = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

/** How many lines of model-written prose a row that is not in focus may take. */
const PRICE_LINES = 2;
/** Same, for the flip condition above the rows. */
const FLIP_LINES = 2;

export type AskRowKind = "option" | "defer" | "words" | "dive";

export interface AskDialogRow {
  kind: AskRowKind;
  /** The option this row rules for, where it rules for one. */
  optionId?: string;
  label: string;
  /** What it costs, or what choosing this row records. */
  price: string;
  recommended?: boolean;
}

export interface AskDialogTab {
  packetId: string;
  /** Short label for the tab bar. */
  label: string;
  title: string;
  question: string;
  /** Blast radius and reversibility: one short line, always shown in full. */
  stakes: string;
  /** What would change the answer. Model-written, so often a paragraph. */
  flipCondition: string;
  /** Earlier questions from this session that this packet replaced. */
  replaces: string[];
  rows: AskDialogRow[];
}

export interface AskAnswer {
  rowIndex: number;
  /** Free text, for a ruling in the user's own words or a question to check first. */
  text?: string;
}

export interface AskDialogState {
  /** Which tab is open; `tabs.length` is the submit tab. */
  tab: number;
  cursor: number;
  answers: Map<string, AskAnswer>;
  /** Set while the user is typing an answer for a row that needs words. */
  typingFor?: { packetId: string; rowIndex: number; prompt: string };
}

export function buildAskDialog(packets: readonly Packet[]): AskDialogTab[] {
  return packets.map((packet) => {
    const recommended = packet.options.find((option) => option.id === packet.recommendationId);
    const alternatives = packet.options.filter((option) => option.id !== packet.recommendationId);
    return {
      packetId: packet.id,
      label: shorten(packet.title, 18),
      title: packet.title,
      question: packet.question,
      stakes: `${packet.blastRadius} blast · ${packet.reversibility}`,
      flipCondition: packet.flipCondition,
      replaces: packet.supersedes ?? [],
      rows: [
        ...(recommended
          ? [{
            kind: "option" as const,
            optionId: recommended.id,
            label: recommended.label,
            price: recommended.price,
            recommended: true,
          }]
          : []),
        ...alternatives.map((option): AskDialogRow => ({
          kind: "option",
          optionId: option.id,
          label: option.label,
          price: option.price,
        })),
        {
          kind: "defer",
          label: "Ask first — check something for me",
          price: "Stays in the queue; a drill answers and brings it back.",
        },
        {
          kind: "words",
          label: "In my own words",
          price: "Recorded and carried to the work as written.",
        },
        {
          kind: "dive",
          label: "I had to open the session to decide",
          price: "Records what the packet was missing, then still takes your ruling.",
        },
      ],
    };
  });
}

export function initialAskState(): AskDialogState {
  return { tab: 0, cursor: 0, answers: new Map() };
}

export type AskKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "escape"
  | { digit: number }
  | { text: string };

export type AskEffect =
  | { kind: "none" }
  | { kind: "submit" }
  | { kind: "cancel" };

/**
 * One keypress. Returns the next state and whether the dialog is done, so the
 * component holds no decision logic of its own.
 */
export function askDialogKey(
  tabs: readonly AskDialogTab[],
  state: AskDialogState,
  key: AskKey,
): { state: AskDialogState; effect: AskEffect } {
  const next: AskDialogState = { ...state, answers: new Map(state.answers) };
  const stay = (effect: AskEffect = { kind: "none" }) => ({ state: next, effect });
  const submitTab = tabs.length;
  const multi = tabs.length > 1;

  if (state.typingFor) {
    if (key === "escape") {
      delete next.typingFor;
      return stay();
    }
    if (typeof key === "object" && "text" in key) {
      const { packetId, rowIndex } = state.typingFor;
      const text = key.text.trim();
      // Nothing typed is not an answer: a blank ruling would be recorded as words
      // the user never said.
      if (text === "") {
        delete next.typingFor;
        return stay();
      }
      next.answers.set(packetId, { rowIndex, text });
      delete next.typingFor;
      return advance(tabs, next, multi);
    }
    return stay();
  }

  if (key === "escape") return stay({ kind: "cancel" });

  if (multi && (key === "right" || key === "left")) {
    const step = key === "right" ? 1 : -1;
    next.tab = (state.tab + step + submitTab + 1) % (submitTab + 1);
    next.cursor = 0;
    return stay();
  }

  if (state.tab === submitTab) {
    if (key === "enter" && answeredAll(tabs, state)) return stay({ kind: "submit" });
    return stay();
  }

  const tab = tabs[state.tab];
  if (!tab) return stay();

  if (key === "up") {
    next.cursor = Math.max(0, state.cursor - 1);
    return stay();
  }
  if (key === "down") {
    next.cursor = Math.min(tab.rows.length - 1, state.cursor + 1);
    return stay();
  }

  const index = key === "enter"
    ? state.cursor
    : typeof key === "object" && "digit" in key
    ? key.digit - 1
    : -1;
  const row = tab.rows[index];
  if (!row) return stay();
  next.cursor = index;

  if (row.kind === "defer" || row.kind === "words" || row.kind === "dive") {
    next.typingFor = {
      packetId: tab.packetId,
      rowIndex: index,
      prompt: row.kind === "defer"
        ? "What should be checked before you decide?"
        : row.kind === "words"
        ? "Your ruling, in your own words:"
        : "What was missing from the packet?",
    };
    return stay();
  }

  next.answers.set(tab.packetId, { rowIndex: index });
  return advance(tabs, next, multi);
}

/**
 * After an answer: a single question is done, and a batch moves to the next
 * unanswered tab so the user is never left hunting for what is still open.
 */
function advance(
  tabs: readonly AskDialogTab[],
  state: AskDialogState,
  multi: boolean,
): { state: AskDialogState; effect: AskEffect } {
  if (!multi) return { state, effect: { kind: "submit" } };
  const nextOpen = tabs.findIndex((tab) => !state.answers.has(tab.packetId));
  return {
    state: { ...state, tab: nextOpen === -1 ? tabs.length : nextOpen, cursor: 0 },
    effect: { kind: "none" },
  };
}

export function answeredAll(tabs: readonly AskDialogTab[], state: AskDialogState): boolean {
  return tabs.every((tab) => state.answers.has(tab.packetId));
}

export interface RenderDeps {
  theme: ThemeLike;
  width: number;
  /** The lines of the editor, when the user is typing an answer. */
  editorLines?: readonly string[];
}

/**
 * The dialog as lines. Every line is wrapped to the width rather than clipped, and
 * the hierarchy is carried by colour and indentation: the decision in accent, its
 * question in text, its price and stakes muted, the keys dim.
 */
export function renderAskDialog(
  tabs: readonly AskDialogTab[],
  state: AskDialogState,
  deps: RenderDeps,
): string[] {
  const { theme } = deps;
  // Two columns in hand: the host draws this inside its own padding, and a line that
  // exactly fills the width lands over the edge and gets wrapped by the terminal.
  const width = Math.max(20, deps.width - 2);
  const lines: string[] = [];

  /**
   * Wraps the plain text, then styles each line that comes out of it. Styling first
   * and wrapping after put the colour's opening escape on the first line only, so
   * every continuation line rendered in the default colour — a muted paragraph turned
   * white halfway through — and the escape characters threw off the width the wrap
   * measured, which is what pushed long lines off the right edge.
   */
  const say = (
    text: string,
    style: (line: string) => string,
    indent = " ",
    maxLines?: number,
  ) => {
    const all = wrap(text, width - indent.length);
    const shown = maxLines === undefined ? all : all.slice(0, maxLines);
    if (maxLines !== undefined && all.length > maxLines && shown.length > 0) {
      shown[shown.length - 1] = `${shown[shown.length - 1]}…`;
    }
    for (const line of shown) lines.push(`${indent}${style(line)}`);
  };
  const muted = (line: string) => theme.fg("muted", line);
  const dim = (line: string) => theme.fg("dim", line);
  const plain = (line: string) => theme.fg("text", line);
  const rule = () => lines.push(theme.fg("accent", "─".repeat(width)));

  rule();

  if (tabs.length > 1) {
    // One short line that cannot wrap: a bar of labelled cells split across lines in a
    // narrow terminal and drew a marker with no label, reading as a decision that does
    // not exist. The titles live on the last screen, in full.
    const dots = tabs.length <= 12
      ? tabs
        .map((tab, index) =>
          index === state.tab ? "◉" : state.answers.has(tab.packetId) ? "■" : "□"
        )
        .join(" ")
      : "";
    const position = state.tab === tabs.length
      ? `all ${tabs.length} decisions`
      : `decision ${state.tab + 1} of ${tabs.length}`;
    const ruled = tabs.filter((tab) => state.answers.has(tab.packetId)).length;
    say(
      `${position}${dots === "" ? " · " : ` · ${dots} · `}${ruled}/${tabs.length} ruled`,
      (line) => theme.fg("accent", line),
      " ",
      1,
    );
    lines.push("");
  }

  if (state.tab === tabs.length) {
    say(`${tabs.length} decisions, ready to rule`, (line) => theme.fg("accent", theme.bold(line)));
    lines.push("");
    for (const [index, tab] of tabs.entries()) {
      const answer = state.answers.get(tab.packetId);
      const row = answer ? tab.rows[answer.rowIndex] : undefined;
      const said = answer?.text ? `“${answer.text}”` : row?.label ?? "";
      // Whole titles here, not the tab-sized short ones: two packets can shorten to
      // the same eighteen characters, and this is the list the user rules from.
      say(`${index + 1}. ${tab.title}`, plain, " ", 2);
      say(
        answer ? said : "not ruled yet",
        answer ? (line) => theme.fg("success", line) : (line) => theme.fg("warning", line),
        "    ",
        2,
      );
      if (index < tabs.length - 1) lines.push("");
    }
    lines.push("");
    const missing = tabs
      .map((tab, index) => ({ tab, index }))
      .filter((entry) => !state.answers.has(entry.tab.packetId))
      .map((entry) => `${entry.index + 1}`);
    if (missing.length === 0) {
      say("enter to rule all of them", (line) => theme.fg("success", line));
    } else {
      say(
        `still open: ${missing.length === 1 ? "decision" : "decisions"} ${missing.join(", ")}`,
        (line) => theme.fg("warning", line),
      );
    }
    lines.push("");
    say("←→ move · enter rule all · esc leave them pending", dim);
    rule();
    return lines;
  }

  const tab = tabs[state.tab];
  if (!tab) {
    rule();
    return lines;
  }

  say(tab.title, (line) => theme.fg("accent", theme.bold(line)));
  say(tab.question, plain);
  lines.push("");
  say(tab.stakes, muted);
  // Capped: a flip condition the model wrote as a paragraph would push the options
  // themselves off the screen, and the options are what the user is here for.
  say(`changes if: ${tab.flipCondition}`, muted, " ", FLIP_LINES);
  if (tab.replaces.length > 0) {
    say(
      `replaces ${tab.replaces.length} earlier question${
        tab.replaces.length === 1 ? "" : "s"
      } here: ${tab.replaces.join("; ")}`,
      dim,
      " ",
      2,
    );
  }
  lines.push("");

  for (const [index, row] of tab.rows.entries()) {
    const selected = index === state.cursor;
    const typing = state.typingFor?.rowIndex === index;
    const focused = selected || typing;
    say(
      `${index + 1}. ${row.label}${row.recommended ? " ← recommended" : ""}`,
      (line) => theme.fg(focused ? "accent" : "text", line),
      selected ? theme.fg("accent", "> ") : "  ",
    );
    // The row in focus shows its price in full; the rest are capped, so a long one
    // cannot bury the options below it. Moving the cursor is how you read the rest.
    say(row.price, muted, "     ", focused ? undefined : PRICE_LINES);
    // A blank line between rows: the price underneath a label needs room to read as
    // belonging to it.
    if (index < tab.rows.length - 1) lines.push("");
  }

  if (state.typingFor) {
    lines.push("");
    say(state.typingFor.prompt, plain);
    for (const line of deps.editorLines ?? [""]) lines.push(` ${line}`);
    lines.push("");
    say("enter to record · esc to go back to the options", dim);
    rule();
    return lines;
  }

  lines.push("");
  say(
    tabs.length > 1
      ? "↑↓ or 1-9 choose · ←→ next decision · enter rule · esc leave pending"
      : "↑↓ or 1-9 choose · enter rule · esc leave it pending",
    dim,
  );
  rule();
  return lines;
}

/**
 * Wraps plain, unstyled text. Callers style what comes out, never what goes in, so
 * this counts characters and no escape sequence can distort the measurement. A word
 * longer than the width is broken rather than allowed to run over the edge.
 */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part !== "")) {
      for (const piece of word.length > width ? chop(word, width) : [word]) {
        if (line !== "" && line.length + 1 + piece.length > width) {
          out.push(line);
          line = piece;
          continue;
        }
        line = line === "" ? piece : `${line} ${piece}`;
      }
    }
    out.push(line);
  }
  return out;
}

function chop(word: string, width: number): string[] {
  const pieces: string[] = [];
  for (let at = 0; at < word.length; at += width) pieces.push(word.slice(at, at + width));
  return pieces;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}
