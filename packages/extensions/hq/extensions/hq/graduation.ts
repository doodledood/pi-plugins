/**
 * Authority growth.
 *
 * Every packet carries a shadow ruling — what the machinery would have decided —
 * and the user's actual ruling grades it. Sustained agreement in a domain earns a
 * *proposal*, never the authority itself: only an explicit user command flips a
 * domain, and only reversible, low-blast decisions can be answered from doctrine
 * even then (INV-G8, AC-6.2).
 */

import type { MetaDoctrine } from "./doctrine.ts";
import type { HqStore } from "./store.ts";
import type { BlastRadius, DomainStats, Reversibility } from "./types.ts";

export interface ShadowOutcome {
  domain: string;
  /** null when the packet had no shadow ruling to grade. */
  agreed: boolean | null;
  at: string;
}

/**
 * Folds one ruling into a domain's tally. A disagreement resets the consecutive
 * run: the streak is meant to say "nothing has surprised us lately", and a reset
 * is the only thing that keeps that true.
 */
export function foldShadowOutcome(stats: DomainStats, outcome: ShadowOutcome): DomainStats {
  const next: DomainStats = { ...stats, lastRulingAt: outcome.at };
  if (outcome.agreed === null) return next;
  if (outcome.agreed) {
    next.agreements += 1;
    next.consecutiveAgreements += 1;
    if (next.firstConsecutiveAt === null) next.firstConsecutiveAt = outcome.at;
    return next;
  }
  next.disagreements += 1;
  next.consecutiveAgreements = 0;
  next.firstConsecutiveAt = null;
  if (stats.graduated) next.overrides += 1;
  return next;
}

export async function recordShadowOutcome(
  store: HqStore,
  outcome: ShadowOutcome,
): Promise<DomainStats> {
  return store.updateDomain(outcome.domain, (stats) => foldShadowOutcome(stats, outcome));
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return (end - start) / 86_400_000;
}

export interface ProposalCheck {
  propose: boolean;
  reason: string;
}

/**
 * Whether the domain has earned a graduation *proposal*. This function can only
 * ever recommend: nothing in HQ calls a flip on its output.
 */
export function graduationProposalCheck(
  stats: DomainStats,
  meta: MetaDoctrine,
  now: string,
): ProposalCheck {
  if (stats.graduated) return { propose: false, reason: "already graduated" };
  if (stats.proposedAt) return { propose: false, reason: "already proposed" };
  if (stats.consecutiveAgreements < meta.graduationConsecutiveAgreements) {
    return {
      propose: false,
      reason: `${stats.consecutiveAgreements}/${meta.graduationConsecutiveAgreements} consecutive agreements`,
    };
  }
  if (!stats.firstConsecutiveAt) {
    return { propose: false, reason: "no agreement streak recorded" };
  }
  const days = daysBetween(stats.firstConsecutiveAt, now);
  if (days < meta.graduationMinDays) {
    return {
      propose: false,
      reason: `streak is ${days.toFixed(1)} days, needs ${meta.graduationMinDays}`,
    };
  }
  return { propose: true, reason: `${stats.consecutiveAgreements} agreements over ${days.toFixed(1)} days` };
}

/** Flips a domain. Reachable only from the user's explicit command. */
export async function graduateDomain(
  store: HqStore,
  domain: string,
  at: string,
): Promise<DomainStats> {
  return store.updateDomain(domain, (stats) => ({
    ...stats,
    graduated: true,
    graduatedAt: at,
  }));
}

/** Revokes a domain. One command, same weight as granting it. */
export async function revokeDomain(store: HqStore, domain: string): Promise<DomainStats> {
  return store.updateDomain(domain, (stats) => ({
    ...stats,
    graduated: false,
    graduatedAt: null,
    // A revoked domain may be proposed again once a fresh streak forms.
    proposedAt: null,
    consecutiveAgreements: 0,
    firstConsecutiveAt: null,
  }));
}

export async function markProposed(
  store: HqStore,
  domain: string,
  at: string,
): Promise<DomainStats> {
  return store.updateDomain(domain, (stats) => ({ ...stats, proposedAt: at }));
}

export interface CeilingInput {
  graduated: boolean;
  blastRadius: BlastRadius;
  reversibility: Reversibility;
  /** Whether doctrine actually decides the case. */
  covered: boolean;
}

export type CeilingReason =
  | "allowed"
  | "domain-not-graduated"
  | "blast-reversibility-ceiling"
  | "not-covered-by-doctrine";

export interface CeilingDecision {
  allowed: boolean;
  reason: CeilingReason;
  explanation: string;
}

/**
 * The gate on answering a stop without the user. Coverage and graduation are
 * necessary; the reversibility ceiling overrides both, so an irreversible or
 * high-blast decision escalates inside a graduated domain and the recorded reason
 * says so.
 */
export function ceilingDecision(input: CeilingInput): CeilingDecision {
  if (input.reversibility === "one-way" || input.blastRadius === "high") {
    return {
      allowed: false,
      reason: "blast-reversibility-ceiling",
      explanation:
        "the decision is irreversible or high-blast, so it reaches the user regardless of doctrine coverage",
    };
  }
  if (!input.graduated) {
    return {
      allowed: false,
      reason: "domain-not-graduated",
      explanation: "the user has not graduated this domain, so the decision is theirs",
    };
  }
  if (!input.covered) {
    return {
      allowed: false,
      reason: "not-covered-by-doctrine",
      explanation: "no doctrine line decides this case",
    };
  }
  return { allowed: true, reason: "allowed", explanation: "graduated domain, covered, reversible" };
}

/**
 * Audit sampling rate for a domain. The configured rate applies while a domain is
 * young and decays as its record lengthens, so a long-trusted domain is sampled
 * less without ever dropping to zero.
 */
export function effectiveAuditRate(meta: MetaDoctrine, stats: DomainStats | undefined): number {
  const base = meta.auditSampleRate;
  if (base <= 0) return 0;
  const answered = stats?.agreements ?? 0;
  const decayed = base / (1 + Math.floor(answered / 100));
  return Math.max(Math.min(base, 0.05), decayed);
}

export function shouldSampleForAudit(
  meta: MetaDoctrine,
  stats: DomainStats | undefined,
  random: () => number = Math.random,
): boolean {
  const rate = effectiveAuditRate(meta, stats);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return random() < rate;
}
