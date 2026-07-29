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
  /** Blast radius, reversibility and what would change the answer. */
  stakes: string;
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
      stakes: `${packet.blastRadius} blast · ${packet.reversibility} · changes if: ${packet.flipCondition}`,
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
  const width = Math.max(20, deps.width);
  const lines: string[] = [];
  const rule = () => lines.push(theme.fg("accent", "─".repeat(width)));
  const wrapped = (text: string, indent = " ") => {
    for (const line of wrap(text, width - indent.length)) lines.push(`${indent}${line}`);
  };

  rule();

  if (tabs.length > 1) {
    const cells = tabs.map((tab, index) => {
      const answered = state.answers.has(tab.packetId);
      const cell = ` ${answered ? "■" : "□"} ${tab.label} `;
      return index === state.tab
        ? theme.bg("selectedBg", theme.fg("text", cell))
        : theme.fg(answered ? "success" : "muted", cell);
    });
    const ready = answeredAll(tabs, state);
    const submit = " ✓ rule all ";
    cells.push(
      state.tab === tabs.length
        ? theme.bg("selectedBg", theme.fg("text", submit))
        : theme.fg(ready ? "success" : "dim", submit),
    );
    wrapped(cells.join(" "));
    lines.push("");
  }

  if (state.tab === tabs.length) {
    wrapped(theme.fg("accent", theme.bold(`${tabs.length} decisions, ready to rule`)));
    lines.push("");
    for (const tab of tabs) {
      const answer = state.answers.get(tab.packetId);
      const row = answer ? tab.rows[answer.rowIndex] : undefined;
      const said = answer?.text ? `“${answer.text}”` : row?.label ?? "";
      wrapped(`${theme.fg("muted", `${tab.label}: `)}${theme.fg("text", said)}`);
    }
    lines.push("");
    const missing = tabs.filter((tab) => !state.answers.has(tab.packetId)).map((tab) => tab.label);
    wrapped(
      missing.length === 0
        ? theme.fg("success", "enter to rule all of them")
        : theme.fg("warning", `still open: ${missing.join(", ")}`),
    );
    lines.push("");
    wrapped(theme.fg("dim", "←→ move · enter rule all · esc leave them pending"));
    rule();
    return lines;
  }

  const tab = tabs[state.tab];
  if (!tab) {
    rule();
    return lines;
  }

  wrapped(theme.fg("accent", theme.bold(tab.title)));
  wrapped(theme.fg("text", tab.question));
  lines.push("");
  wrapped(theme.fg("muted", tab.stakes));
  if (tab.replaces.length > 0) {
    wrapped(
      theme.fg("dim", `replaces ${tab.replaces.length} earlier question${
        tab.replaces.length === 1 ? "" : "s"
      } here: ${tab.replaces.join("; ")}`),
    );
  }
  lines.push("");

  for (const [index, row] of tab.rows.entries()) {
    const selected = index === state.cursor;
    const typing = state.typingFor?.rowIndex === index;
    const label = `${index + 1}. ${row.label}${row.recommended ? "  ← recommended" : ""}`;
    wrapped(
      theme.fg(selected || typing ? "accent" : "text", label),
      selected ? theme.fg("accent", "> ") : "  ",
    );
    wrapped(theme.fg("muted", row.price), "     ");
    // A blank line between rows: the crowding was the complaint, and the price
    // underneath each label needs room to read as belonging to it.
    if (index < tab.rows.length - 1) lines.push("");
  }

  if (state.typingFor) {
    lines.push("");
    wrapped(theme.fg("text", state.typingFor.prompt));
    for (const line of deps.editorLines ?? [""]) lines.push(` ${line}`);
    lines.push("");
    wrapped(theme.fg("dim", "enter to record · esc to go back to the options"));
    rule();
    return lines;
  }

  lines.push("");
  wrapped(
    theme.fg(
      "dim",
      tabs.length > 1
        ? "↑↓ or 1-9 choose · ←→ next decision · enter rule · esc leave pending"
        : "↑↓ or 1-9 choose · enter rule · esc leave it pending",
    ),
  );
  rule();
  return lines;
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter((part) => part !== "")) {
      // Measured on the styled string, so a colour code never counts as width.
      if (line !== "" && visible(`${line} ${word}`) > width) {
        out.push(line);
        line = word;
        continue;
      }
      line = line === "" ? word : `${line} ${word}`;
    }
    out.push(line);
  }
  return out;
}

/** Printable width: ANSI escapes take no columns. */
function visible(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, "").length;
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}
