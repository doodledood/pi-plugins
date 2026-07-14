---
name: deletion-pass
description: 'Audit a plan, design, architecture, or process for whether every requirement and mechanism earns its keep — an ordered deletion pass (question requirements, delete or absorb parts, simplify only what survives, accelerate/automate last) that reports what to cut and what to question without rewriting the artifact. Use before finalizing a design or plan, when a proposal feels over-built or accreted, or when the user asks for a deletion pass, a simplicity audit, a Musk-algorithm pass, or "what can we remove."'
---

# Deletion pass

Designs accrete: every concern tempts a new mechanism, and reviews add rather than remove. This pass runs the opposite motion — it tries to *delete* the artifact down to its irreducible core and reports what survives its own removal.

**The single question, asked of every requirement, component, mechanism, and process step:** *what breaks if this is removed?* Whatever survives its own removal is a deletion candidate.

Be **ruthless about what must be built**; stay **exhaustive about what might be true**. Deletion pressure is for machinery — requirements, parts, mechanisms, process steps. It is *not* for evidence, open questions, or genuinely viable alternatives still under consideration; pruning those is a truth-seeking failure, not simplification.

## The ordered pass

Order is load-bearing — the most common error is optimizing something that should not exist, so existence is settled before shape.

1. **Question every requirement.** Trace each to a real, named source and a real need. A requirement no one owns, or whose need can't be reconstructed, is the first thing to cut. Requirements from a smart or senior source are the most dangerous — they get questioned least.
2. **Delete or absorb the part / mechanism / step.** For each, name what actually breaks without it. If nothing the goal needs breaks, or another piece already covers it, it's a deletion candidate. Some deletions get re-added later once a real need appears — that's expected and healthy; if *nothing* in the artifact would ever be missed, the pass wasn't ruthless enough. (This is a signal, not a quota — never manufacture cuts to hit a number.)
3. **Simplify only what survives.** Flag anything already simplified, generalized, configured, or abstracted that step 2 should have deleted outright — effort spent perfecting a thing that shouldn't exist.
4. **Accelerate / automate last.** Flag speed, tooling, caching, or automation added around a mechanism that hasn't yet earned its own existence.

## Altitude and evidence

- **Whole artifact or a major component** — the big "should this exist / is this the right shape" question, never a one-line nitpick. A single unused field is a defect, not a deletion-pass finding.
- **Fire only on concrete, nameable evidence** — point at the component, the requirement with no owner, the mechanism another piece already covers, the concretely simpler shape. *"I'd have designed it differently"* is not a finding. When nothing clears that bar, say the artifact earns its keep and stop — silence is the expected result on a lean design.
- **One finding per root.** When necessity, surface, and a simpler shape all point at the same over-built piece, collapse them into one question, not three.

## Report only — never rewrite

Return findings and author-facing questions; the author decides. You may name a deletion candidate and describe a concretely simpler shape when one is nameable, but do **not** produce a rewritten or replacement artifact. The pass sharpens the author's judgment; it does not take the pen.

For each finding:

- **Target** — the requirement / component / mechanism / step, at whole-artifact altitude.
- **What breaks if removed** — the concrete evidence, or its absence (no owner, no consumer, already covered, simpler path exists).
- **Question** — the decision handed back to the author (e.g. *"nothing downstream reads this cache — remove it, or is there a consumer I'm missing?"*).

Close with the irreducible core: what survived, and — only when it adds real confidence — why each survivor is load-bearing. If everything earns its keep, say so plainly.
