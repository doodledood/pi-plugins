// cost-report.ts — the /cost breakdown, and the same analysis for a tree on disk.
//
// The footer carries one lifetime number; this is where that number is taken apart:
// per spawned session, per model, lifetime vs active branch, and what the total
// cannot see. It reads session files only, so it works long after the session ended.

import { basename } from "node:path";
import { formatCost, formatTokens } from "./cache.ts";
import {
  accumulateEntry,
  createAccumulator,
  SessionTreeScanner,
  type PriceOptions,
  type ScanStats,
  type SessionCost,
  type TreeCost,
} from "./session-cost.ts";

/**
 * The class of spend no total can include: paid work whose tool result reports no
 * usage, so nothing in the session records it. Stated as a class with examples rather
 * than a list of packages, because which of them are installed is not knowable from
 * here and the caveat holds either way.
 */
export const UNREPORTED_SPEND_NOTE = [
  "Paid work that reports no usage cannot be counted, so it sits outside this total.",
  "Tools that typically do this: web-search or source-check answer synthesis, paid search APIs, and image generation.",
];

export interface ReportOptions {
  /** Spend on the active branch only, for the lifetime-vs-branch distinction. */
  activeBranchCost?: number;
  /** Scan diagnostics from the last refresh: how much work the figure cost to produce. */
  scan?: ScanStats;
}

function shortId(id: string | undefined): string {
  if (!id) return "unknown";
  return id.length > 8 ? id.slice(0, 8) : id;
}

function tokenSummary(session: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }): string {
  const { input, output, cacheRead, cacheWrite } = session.tokens;
  return `${formatTokens(input + cacheRead + cacheWrite)} in / ${formatTokens(output)} out`;
}

function sessionLabel(session: SessionCost): string {
  if (session.kind === "own") return "this session";
  const name = session.path ? basename(session.path, ".jsonl").replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z_/, "") : shortId(session.id);
  return `${session.kind}/${shortId(name)}`;
}

/** Human-readable breakdown of a scanned tree. Safe to call with no scan yet. */
export function renderCostReport(cost: TreeCost | undefined, options: ReportOptions = {}): string {
  if (!cost) return "Cost: no session scan yet.";

  const lines: string[] = [];
  const approx = cost.approximate ? "~" : "";
  lines.push(`Session tree lifetime cost: ${approx}${formatCost(cost.totalCost)}`);
  lines.push(`  this session's own turns: ${formatCost(cost.own.cost)} · runs it spawned: ${formatCost(cost.totalCost - cost.own.cost)}`);
  if (options.activeBranchCost != null) {
    lines.push(`  of its own turns, the active branch alone: ${formatCost(options.activeBranchCost)}`);
  }
  lines.push(`  tokens: ${tokenSummary({ tokens: cost.totalTokens })}`);

  if (cost.descendants.length > 0) {
    lines.push("");
    lines.push(`Spawned sessions (${cost.descendants.length}):`);
    for (const session of cost.descendants) {
      lines.push(`  ${sessionLabel(session)} — ${formatCost(session.cost)} · ${tokenSummary(session)}`);
    }
  } else {
    lines.push("");
    lines.push("Spawned sessions: none found.");
  }

  const byModel = new Map<string, { cost: number; tokens: number }>();
  for (const session of [cost.own, ...cost.descendants]) {
    for (const model of session.models) {
      const totals = byModel.get(model.key) ?? { cost: 0, tokens: 0 };
      totals.cost += model.cost;
      totals.tokens += model.input + model.output + model.cacheRead + model.cacheWrite;
      byModel.set(model.key, totals);
    }
  }
  if (byModel.size > 0) {
    lines.push("");
    lines.push("By provider/model:");
    for (const [key, totals] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
      lines.push(`  ${key} — ${formatCost(totals.cost)} · ${formatTokens(totals.tokens)} tokens`);
    }
  }

  if (cost.approximate) {
    lines.push("");
    lines.push("Approximate, because:");
    for (const reason of cost.approximateReasons) lines.push(`  · ${reason}`);
    if (cost.uncorrectedPriorityCost > 0) {
      lines.push(`  · priority-tier turns billed above the ${formatCost(cost.uncorrectedPriorityCost)} counted here`);
    }
  }

  if (options.scan) {
    lines.push("");
    lines.push(
      `Scan: ${options.scan.filesDiscovered} spawned session file(s) found, ${options.scan.filesRead} read on the last refresh` +
        `${options.scan.filesUnreadable > 0 ? `, ${options.scan.filesUnreadable} unreadable` : ""}.`,
    );
    lines.push("  Session files are append-only, so an unchanged file is never re-read.");
  }

  lines.push("");
  lines.push("Not included:");
  for (const note of UNREPORTED_SPEND_NOTE) lines.push(`  · ${note}`);

  return lines.join("\n");
}

/**
 * Scan a session tree from disk — no live session needed. Used by /cost for the
 * current session and available for post-hoc analysis of any session file.
 */
export function analyzeSessionTree(sessionFile: string, price: PriceOptions = {}): TreeCost {
  // The same single tree walk the footer uses, with the parent read from disk instead
  // of from a live session manager. One implementation is what stops a dedupe fix from
  // landing in the footer and quietly missing /cost.
  return new SessionTreeScanner(price).scanTree({ sessionFile });
}

/**
 * Spend on one branch of a session, by the same rules as the lifetime total: all four
 * native usage sources plus cost records, rather than assistant messages alone.
 */
export function branchCost(branch: Iterable<unknown>, price: PriceOptions = {}): number {
  const acc = createAccumulator();
  for (const entry of branch) accumulateEntry(acc, entry, price);
  return acc.cost;
}

