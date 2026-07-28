import assert from "node:assert/strict";
import test from "node:test";
import { META_DEFAULTS } from "./doctrine.ts";
import {
  ceilingDecision,
  effectiveAuditRate,
  foldShadowOutcome,
  graduateDomain,
  graduationProposalCheck,
  markProposed,
  recordShadowOutcome,
  revokeDomain,
  shouldSampleForAudit,
} from "./graduation.ts";
import { dropRoot, makeRoot, makeStore } from "./testing.ts";
import { emptyDomainStats } from "./types.ts";

test("agreements build a streak and one disagreement resets it", () => {
  let stats = emptyDomainStats("ci-flake");
  stats = foldShadowOutcome(stats, { domain: "ci-flake", agreed: true, at: "2026-07-01T00:00:00.000Z" });
  stats = foldShadowOutcome(stats, { domain: "ci-flake", agreed: true, at: "2026-07-02T00:00:00.000Z" });
  assert.equal(stats.agreements, 2);
  assert.equal(stats.consecutiveAgreements, 2);
  assert.equal(stats.firstConsecutiveAt, "2026-07-01T00:00:00.000Z");

  stats = foldShadowOutcome(stats, { domain: "ci-flake", agreed: false, at: "2026-07-03T00:00:00.000Z" });
  assert.equal(stats.disagreements, 1);
  assert.equal(stats.consecutiveAgreements, 0);
  assert.equal(stats.firstConsecutiveAt, null);

  const ungraded = foldShadowOutcome(stats, { domain: "ci-flake", agreed: null, at: "2026-07-04T00:00:00.000Z" });
  assert.equal(ungraded.agreements, 2);
  assert.equal(ungraded.lastRulingAt, "2026-07-04T00:00:00.000Z");
});

test("a disagreement inside a graduated domain is counted as an override", () => {
  const graduated = { ...emptyDomainStats("d"), graduated: true };
  const after = foldShadowOutcome(graduated, { domain: "d", agreed: false, at: "2026-07-03T00:00:00.000Z" });
  assert.equal(after.overrides, 1);
});

test("a proposal needs both the streak and the time, and only ever proposes", () => {
  const meta = { ...META_DEFAULTS, graduationConsecutiveAgreements: 3, graduationMinDays: 14 };
  const short = {
    ...emptyDomainStats("d"),
    consecutiveAgreements: 2,
    firstConsecutiveAt: "2026-07-01T00:00:00.000Z",
  };
  assert.equal(graduationProposalCheck(short, meta, "2026-08-01T00:00:00.000Z").propose, false);

  const tooRecent = {
    ...emptyDomainStats("d"),
    consecutiveAgreements: 3,
    firstConsecutiveAt: "2026-07-28T00:00:00.000Z",
  };
  const recentCheck = graduationProposalCheck(tooRecent, meta, "2026-08-01T00:00:00.000Z");
  assert.equal(recentCheck.propose, false);
  assert.match(recentCheck.reason, /days/);

  const earned = {
    ...emptyDomainStats("d"),
    consecutiveAgreements: 3,
    firstConsecutiveAt: "2026-07-01T00:00:00.000Z",
  };
  assert.equal(graduationProposalCheck(earned, meta, "2026-08-01T00:00:00.000Z").propose, true);
  assert.equal(
    graduationProposalCheck({ ...earned, graduated: true }, meta, "2026-08-01T00:00:00.000Z").propose,
    false,
  );
  assert.equal(
    graduationProposalCheck({ ...earned, proposedAt: "2026-07-30T00:00:00.000Z" }, meta, "2026-08-01T00:00:00.000Z")
      .propose,
    false,
  );
});

test("sustained agreement alone never graduates a domain", async () => {
  const root = await makeRoot("hq-grad");
  try {
    const store = makeStore(root);
    await store.ensure();
    for (let index = 0; index < 50; index += 1) {
      await recordShadowOutcome(store, {
        domain: "ci-flake",
        agreed: true,
        at: `2026-06-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      });
    }
    const state = await store.readGraduation();
    assert.equal(state.domains["ci-flake"]?.agreements, 50);
    assert.equal(
      state.domains["ci-flake"]?.graduated,
      false,
      "only an explicit user command can grant authority",
    );
    assert.equal(await store.isGraduated("ci-flake"), false);

    // Marking a proposal is also not a grant.
    await markProposed(store, "ci-flake", "2026-07-01T00:00:00.000Z");
    assert.equal(await store.isGraduated("ci-flake"), false);

    await graduateDomain(store, "ci-flake", "2026-07-02T00:00:00.000Z");
    assert.equal(await store.isGraduated("ci-flake"), true);

    await revokeDomain(store, "ci-flake");
    assert.equal(await store.isGraduated("ci-flake"), false);
    const afterRevoke = (await store.readGraduation()).domains["ci-flake"];
    assert.equal(afterRevoke?.consecutiveAgreements, 0, "a revoked domain earns its way back");
  } finally {
    await dropRoot(root);
  }
});

test("the reversibility ceiling outranks both coverage and graduation", () => {
  assert.deepEqual(
    ceilingDecision({ graduated: true, blastRadius: "low", reversibility: "reversible", covered: true }),
    {
      allowed: true,
      reason: "allowed",
      explanation: "graduated domain, covered, reversible",
    },
  );
  assert.equal(
    ceilingDecision({ graduated: true, blastRadius: "high", reversibility: "reversible", covered: true }).reason,
    "blast-reversibility-ceiling",
  );
  assert.equal(
    ceilingDecision({ graduated: true, blastRadius: "low", reversibility: "one-way", covered: true }).reason,
    "blast-reversibility-ceiling",
  );
  assert.equal(
    ceilingDecision({ graduated: false, blastRadius: "low", reversibility: "reversible", covered: true }).reason,
    "domain-not-graduated",
  );
  assert.equal(
    ceilingDecision({ graduated: true, blastRadius: "low", reversibility: "reversible", covered: false }).reason,
    "not-covered-by-doctrine",
  );
});

test("the audit rate is the configured one, decaying only with a long record", () => {
  const meta = { ...META_DEFAULTS, auditSampleRate: 0.2 };
  const fresh = { ...emptyDomainStats("d"), agreements: 0 };
  assert.equal(effectiveAuditRate(meta, fresh), 0.2);
  assert.equal(effectiveAuditRate(meta, undefined), 0.2);
  assert.equal(effectiveAuditRate(meta, { ...fresh, agreements: 250 }) < 0.2, true);
  assert.equal(effectiveAuditRate(meta, { ...fresh, agreements: 100_000 }) >= 0.05, true);
  assert.equal(effectiveAuditRate({ ...meta, auditSampleRate: 0 }, fresh), 0);

  // The sampler honours the rate rather than guessing at it.
  assert.equal(shouldSampleForAudit(meta, fresh, () => 0.1), true);
  assert.equal(shouldSampleForAudit(meta, fresh, () => 0.9), false);
  assert.equal(shouldSampleForAudit({ ...meta, auditSampleRate: 1 }, fresh, () => 0.99), true);
  assert.equal(shouldSampleForAudit({ ...meta, auditSampleRate: 0 }, fresh, () => 0), false);
});

test("audit decay keeps ageing after a domain graduates", () => {
  const meta = { ...META_DEFAULTS, auditSampleRate: 0.2 };
  // A graduated domain stops collecting rulings, so its agreements freeze. If decay
  // keyed only off those, the rate would stay at the young-domain value forever —
  // exactly when the track record it is supposed to reward starts accumulating.
  const graduated = { ...emptyDomainStats("d"), agreements: 12, graduated: true };
  const young = effectiveAuditRate(meta, graduated);
  const seasoned = effectiveAuditRate(meta, { ...graduated, autoAnswered: 300 });
  assert.ok(seasoned < young, "300 doctrine-answered stops must lower the rate");
  assert.ok(seasoned >= 0.05, "and it never reaches zero");
});
