// cost-report.ts — the /cost breakdown, and the same analysis for a tree on disk.
//
// The footer carries one lifetime number; this is where that number is taken apart:
// per spawned session, per model, lifetime vs active branch, and what the total
// cannot see. It reads session files only, so it works long after the session ended.

import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { formatCost, formatTokens } from "./cache.ts";
import {
  createAccumulator,
  accumulateEntry,
  combine,
  summarize,
  readSessionHeader,
  SessionTreeScanner,
  type PriceOptions,
  type SessionCost,
  type TreeCost,
} from "./session-cost.ts";

/**
 * Spend that no session records, so no total can include it. Both are third-party
 * extensions that return no `usage` on their tool results; naming them keeps a
 * total from reading as every dollar spent.
 */
export const UNREPORTED_SPENDERS = [
  "web search / source check (pi-web-access): search-answer synthesis and paid search APIs",
  "image generation (pi-image-gen)",
];

export interface ReportOptions {
  /** Spend on the active branch only, for the lifetime-vs-branch distinction. */
  activeBranchCost?: number;
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
  if (options.activeBranchCost != null) {
    lines.push(`  active branch (this session only): ${formatCost(options.activeBranchCost)}`);
  }
  lines.push(`  this session: ${formatCost(cost.own.cost)} · spawned runs: ${formatCost(cost.totalCost - cost.own.cost)}`);
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

  lines.push("");
  lines.push("Not included (these report no usage, so their spend is unrecoverable):");
  for (const spender of UNREPORTED_SPENDERS) lines.push(`  · ${spender}`);

  return lines.join("\n");
}

/**
 * Scan a session tree from disk — no live session needed. Used by /cost for the
 * current session and available for post-hoc analysis of any session file.
 */
export function analyzeSessionTree(sessionFile: string, price: PriceOptions = {}): TreeCost {
  const scanner = new SessionTreeScanner(price);
  const rootId = readSessionHeader(sessionFile)?.id;

  // Descendants first, so the parent's own tool results can be recognized as
  // restatements of a child session's spend rather than extra spend.
  const descendants: SessionCost[] = [];
  const counted = new Set<string>();
  for (const found of scanner.discover(sessionFile, rootId)) {
    const cost = scanner.scanFile(found.path, found.kind);
    if (!cost) continue;
    descendants.push(cost);
    if (cost.id) counted.add(cost.id);
    if (cost.path) counted.add(cost.path);
  }
  descendants.sort((a, b) => b.cost - a.cost);

  const own = scanner.scanFile(sessionFile, "own", counted);
  return combine(own ?? summarize(createAccumulator(), { id: rootId, path: sessionFile, kind: "own" }), descendants);
}

/** Every session file directly in a session directory (Pi's own non-recursive view). */
export function listSessionFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(dir, name))
      .sort();
  } catch {
    return [];
  }
}

/** Re-exported so a post-hoc caller can fold extra entries without importing two modules. */
export { accumulateEntry, createAccumulator, summarize };
