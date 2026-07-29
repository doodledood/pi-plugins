/**
 * The glance: a read-only model of the fleet, small enough to trust at a glance.
 *
 * Its one job is letting the user tell a session that is quietly working from one
 * that is silently dead — which is what makes closing the tabs safe. It carries
 * no transcript content, and it is never the path to a decision: anything needing
 * the user is in the queue.
 */

import type { MetaDoctrine } from "./doctrine.ts";
import type { Packet, SessionState } from "./types.ts";

export type RowState = "needs-ruling" | "failed" | "running" | "drilling" | "idle" | "done";

export const GLYPHS: Record<RowState, string> = {
  "needs-ruling": "▲",
  failed: "✗",
  running: "●",
  drilling: "◔",
  idle: "◐",
  done: "✓",
};

export const STALE_GLYPH = "⚠";

export interface FleetRow {
  sessionId: string;
  label: string;
  state: RowState;
  glyph: string;
  /** Milliseconds since the session last published anything. */
  ageMs: number;
  age: string;
  stale: boolean;
  note: string;
}

export interface FleetCardModel {
  header: string;
  rows: FleetRow[];
  idleCount: number;
  doneToday: number;
  pendingCount: number;
  /** True when nothing is running and nothing is waiting on the user. */
  collapsed: boolean;
  summary: string;
}

export interface FleetInput {
  fleet: readonly SessionState[];
  packets: readonly Packet[];
  doneToday: number;
  now: Date;
  meta: MetaDoctrine;
  /**
   * Domains whose record has crossed the graduation thresholds. HQ shows readiness
   * here rather than asking about it: a packet would spend a decision on something
   * that changes nothing, since only the user's command can grant authority.
   */
  readyToGraduate?: readonly string[];
  /** Rows beyond this are summarized rather than listed. */
  maxRows?: number;
  /** Sessions quiet for longer than this are not counted as idle. Default 24h. */
  idleWindowMs?: number;
}

export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function shortLabel(state: SessionState): string {
  if (state.title && state.title.trim()) return state.title.trim();
  const base = state.project.split("/").filter(Boolean).pop();
  return base ?? state.sessionId.slice(0, 8);
}

function rowStateFor(state: SessionState, hasPendingPacket: boolean): RowState {
  if (hasPendingPacket) return "needs-ruling";
  // Drilling is derived from the markers drills own, never from a state a drill
  // wrote onto the row.
  if (state.drillingPacketIds.length > 0) return "drilling";
  if (state.stopState === "aborted") return "failed";
  if (state.state === "running") return "running";
  if (state.state === "done") return "done";
  return "idle";
}

/** Rows the user should see first: waiting on them, then broken, then live. */
const ROW_PRIORITY: Record<RowState, number> = {
  "needs-ruling": 0,
  failed: 1,
  drilling: 2,
  running: 3,
  idle: 4,
  done: 5,
};

export function buildFleetCard(input: FleetInput): FleetCardModel {
  const nowMs = input.now.getTime();
  const stalenessMs = input.meta.stalenessMinutes * 60_000;
  const pending = input.packets.filter((packet) => packet.status === "pending");
  const pendingBySession = new Set(pending.map((packet) => packet.sourceSessionId));

  // The board is HQ's fleet. Sessions HQ does not manage are the user's own and are
  // not shown at all; rows left by an older version are dropped here too.
  const rows: FleetRow[] = input.fleet.filter((state) => state.role === "managed").map((state) => {
    const rowState = rowStateFor(state, pendingBySession.has(state.sessionId));
    const ageMs = nowMs - Date.parse(state.lastEventAt);
    // Staleness is only meaningful for something that claims to be working: an
    // idle session is supposed to be quiet.
    const stale = (rowState === "running" || rowState === "drilling") && ageMs > stalenessMs;
    return {
      sessionId: state.sessionId,
      label: shortLabel(state),
      state: rowState,
      glyph: stale ? STALE_GLYPH : GLYPHS[rowState],
      ageMs,
      age: formatAge(ageMs),
      stale,
      note: noteFor(rowState, state, stale),
    };
  });

  rows.sort((left, right) => {
    const priority = ROW_PRIORITY[left.state] - ROW_PRIORITY[right.state];
    if (priority !== 0) return priority;
    return right.ageMs - left.ageMs;
  });

  const maxRows = input.maxRows ?? 6;
  const listed = rows.filter((row) => row.state !== "idle" && row.state !== "done").slice(0, maxRows);
  // "N idle" is only useful while those sessions are still work in progress; every
  // session HQ has ever seen would make the number meaningless.
  const idleWindowMs = input.idleWindowMs ?? 24 * 60 * 60_000;
  const idleCount = rows.filter(
    (row) => (row.state === "idle" || row.state === "done") && row.ageMs <= idleWindowMs,
  ).length;

  const collapsed = listed.length === 0;
  const summaryParts: string[] = [];
  if (idleCount > 0) summaryParts.push(`${GLYPHS.idle} ${idleCount} idle`);

  const ready = input.readyToGraduate ?? [];
  if (ready.length > 0) summaryParts.push(`★ ${ready.join(", ")} ready to graduate`);
  return {
    // Both counts the glance promises, in the card's own vocabulary so they fit.
    header: `◆ HQ · ${GLYPHS["needs-ruling"]} ${pending.length} · ${GLYPHS.done} ${input.doneToday} today`,
    rows: listed,
    idleCount,
    doneToday: input.doneToday,
    pendingCount: pending.length,
    collapsed,
    summary: summaryParts.join(" · ") || "nothing running",
  };
}

function noteFor(rowState: RowState, state: SessionState, stale: boolean): string {
  if (stale) return "no word";
  switch (rowState) {
    case "needs-ruling":
      return "needs ruling";
    case "failed":
      return "failed";
    case "drilling":
      return "drilling";
    case "running":
      return "working";
    case "done":
      return "done";
    case "idle":
      return "idle";
  }
}

function clamp(line: string, width: number): string {
  if (width <= 1) return "";
  return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Renders the card as plain lines at the width the frame will actually give them.
 *
 * The frame spends four columns on its border and padding, so this fills
 * `width - 4`. Getting that wrong is not cosmetic: rows are right-aligned on the
 * age, so two columns of over-fill silently clipped the one number the card
 * exists to show.
 */
export function renderFleetCard(model: FleetCardModel, width: number): string[] {
  const inner = contentWidth(width);

  // Collapsed is one line. Nothing is waiting when the card collapses, so the
  // pending count is dead weight there: the badge, what is idle, and what is done.
  if (model.collapsed) {
    const done = `${GLYPHS.done} ${model.doneToday} today`;
    return [clamp(`◆ HQ · ${model.summary} · ${done}`, inner)];
  }

  const lines: string[] = [clamp(model.header, inner)];

  const longest = model.rows.reduce((width, row) => Math.max(width, row.label.length), 0);
  const labelWidth = Math.min(16, Math.max(6, longest));
  for (const row of model.rows) {
    const label = row.label.length > labelWidth
      ? `${row.label.slice(0, labelWidth - 1)}…`
      : row.label.padEnd(labelWidth);
    const left = `${row.glyph} ${label} ${row.note}`;
    const gap = Math.max(1, inner - left.length - row.age.length);
    lines.push(clamp(`${left}${" ".repeat(gap)}${row.age}`, inner));
  }
  lines.push(clamp(model.summary, inner));
  return lines;
}

/** Columns a framed card leaves for content: the border and padding take four. */
export function contentWidth(width: number): number {
  return Math.max(18, Math.min(width, 44)) - 4;
}
