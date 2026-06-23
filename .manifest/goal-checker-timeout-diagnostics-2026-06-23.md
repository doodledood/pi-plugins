# Manifest: Goal checker timeout diagnostics

## 1. Intent & Context

Improve `goal-controller` checker subprocess failure visibility and increase the default checker timeout. The motivating failure was a checker subprocess killed at the 120s timeout and surfaced only as `checker subprocess exited with code 143`, which hid the timeout mechanism from the operator. Final target timeout is 5 minutes.

## 2. Deliverables

### D1 — Timeout-aware checker failure messages

Change the checker runner so a killed checker subprocess reports a human-readable timeout/abort-style failure instead of an opaque Unix exit code. The message must include elapsed time and checker configuration context useful for diagnosis, and it must state that no checker verdict was returned.

Acceptance Criteria:

- [AC-1.1] Killed checker subprocesses surface a timeout/termination-oriented message rather than only `checker subprocess exited with code 143`.
  verify:
    prompt: |
      Inspect `packages/extensions/goal-controller/extensions/goal-controller/checker.ts` and its tests. PASS only if killed subprocess results are handled before generic nonzero exit handling, and a killed result produces a message that mentions timeout or termination, elapsed time, timeout configuration, and that no checker verdict was returned. FAIL if killed results can still fall through to only `checker subprocess exited with code 143`.
    phase: 1
- [AC-1.2] Non-timeout/non-killed subprocess exits still report the exit code and include useful subprocess output when available.
  verify:
    prompt: |
      Inspect `packages/extensions/goal-controller/extensions/goal-controller/checker.ts` and tests. PASS only if nonzero subprocess exits that are not killed still report the exit code and include stderr and/or stdout tail when present, without being mislabeled as timeouts. FAIL otherwise.
    phase: 1

### D2 — Five-minute default timeout everywhere users see defaults

Raise the goal-controller checker timeout default from 120000ms to 300000ms and keep documented/user-facing config examples in sync.

Acceptance Criteria:

- [AC-2.1] Source default and config examples use 300000ms.
  verify:
    prompt: |
      Inspect `packages/extensions/goal-controller/extensions/goal-controller/config.ts`, `packages/extensions/goal-controller/config/goal-controller.config.example.json`, and `packages/extensions/goal-controller/README.md`. PASS only if the default checker timeout is 300000ms/5 minutes consistently wherever the package default or example timeout appears. FAIL if any default/example uses a non-300000 timeout.
    phase: 1
- [AC-2.2] Aviram setup does not override goal-controller defaults.
  verify:
    prompt: |
      Inspect the repo and the live local Pi agent config path. PASS only if `profiles/aviram/configs/goal-controller.config.json` is absent and `/Users/aviram.kofman/.pi/agent/goal-controller.config.json` is absent, so Aviram's setup inherits package defaults. FAIL if either file exists with any goal-controller override.
    phase: 1

### D3 — Regression coverage and package verification

Add tests for the new failure-reporting paths and run the package verification suite.

Acceptance Criteria:

- [AC-3.1] Regression tests cover killed timeout-style reporting and ordinary nonzero exit reporting.
  verify:
    prompt: |
      Inspect `packages/extensions/goal-controller/extensions/goal-controller/checker.test.ts`. PASS only if tests exercise a killed subprocess result and a non-killed nonzero subprocess result, asserting the killed case is timeout/termination-oriented and the non-killed case preserves exit-code/output diagnostics. FAIL otherwise.
    phase: 1
- [AC-3.2] Goal-controller package tests and typecheck pass.
  verify:
    prompt: |
      Run `npm run test --workspace @doodledood/pi-goal-controller` and `npm run typecheck --workspace @doodledood/pi-goal-controller`. PASS only if both commands pass. Report command output. FAIL otherwise.
    phase: 2
- [AC-3.3] Repository structure verification passes.
  verify:
    prompt: |
      Run `npm run verify:structure`. PASS only if it passes. Report command output. FAIL otherwise.
    phase: 2

## 3. Global Invariants

- [GI-1] The change is scoped to goal-controller diagnostics/default timeout/docs/tests; no unrelated package/resource surface changes.
  verify:
    prompt: |
      Inspect the git diff. PASS only if changes are limited to goal-controller checker diagnostics, timeout defaults/config/docs/tests, and this manifest. FAIL if unrelated resource/package changes are present.
    phase: 2
- [GI-2] The final branch is committed and pushed with a conventional commit.
  verify:
    prompt: |
      Run `git status --short --branch` and `git log -1 --oneline`. PASS only if the current branch is not main, working tree is clean, local HEAD matches origin/current-branch, and the latest commit message is conventional. FAIL otherwise.
    phase: 3

## 4. Approach

- Add a small diagnostic formatter around `PiSubprocessCheckerRunner` results.
- Measure elapsed wall time around `pi.exec` because `ExecResult` exposes `killed` but not whether the kill came from timeout vs abort.
- Treat killed results as timeout/termination-oriented, with wording that says the configured timeout may have fired and includes elapsed/config details.
- Preserve existing generic nonzero behavior, but enrich it with stderr/stdout tail when available.
- Update the default timeout constant and all example/default config surfaces to 300000ms.

## 5. Gate Ledger

| Gate | Phase | Status | Latest verdict | Evidence | Freshness |
|------|-------|--------|----------------|----------|-----------|
| AC-1.1 | 1 | PASS | Independent verifier `a4a21d78-7eb3-484` | Killed results handled before generic nonzero branch; message includes timeout/termination wording, elapsed/config, no-verdict, exit code/output diagnostics; targeted test passed. | Fresh after checker diagnostics implementation; no later checker diagnostic edits. |
| AC-1.2 | 1 | PASS | Independent verifier `54428ff6-d98f-471` | Non-killed nonzero exits preserve exit code plus stderr/stdout tail and are not mislabeled timeout; targeted test passed. | Fresh after checker diagnostics implementation; no later checker diagnostic edits. |
| AC-2.1 | 1 | PASS | Independent verifier `37e220f6-9b82-42a` | Source default is `300_000`; package example/README use `300000` and document 5 minutes; no old timeout values under package. | Fresh after 5-minute amendment. |
| AC-2.2 | 1 | PASS | Independent verifier `0f1652dc-4a52-449` plus local check | `profiles/aviram/configs/goal-controller.config.json` absent and `/Users/aviram.kofman/.pi/agent/goal-controller.config.json` absent. | Fresh after deleting tracked and live overrides. |
| AC-3.1 | 1 | PASS | Independent verifier `8cea0ca1-6eaa-4f8` | Tests cover killed `{ code: 143, killed: true }` and non-killed `{ code: 7, killed: false }` diagnostics. | Fresh; only timeout constant/docs changed after this, not test behavior. |
| AC-3.2 | 2 | PASS | Independent verifier `916c9042-4f86-424` | `npm run test --workspace @doodledood/pi-goal-controller` → 42 passed; `npm run typecheck --workspace @doodledood/pi-goal-controller` → passed. | Fresh after 5-minute amendment. |
| AC-3.3 | 2 | PASS | Independent verifier `ef894976-0571-46c` plus local rerun | `npm run verify:structure` → `structure ok: 9 extensions, no skills, 1 theme`. | Fresh; manifest-only edits after do not affect structure. |
| GI-1 | 2 | PASS | Independent verifier `99b19142-5ca7-4a8` | Diff limited to goal-controller diagnostics/default/docs/tests, Aviram override removal/docs, and manifest; target timeout consistent at 300000/5 minutes. | Fresh after 5-minute amendment. |
| GI-2 | 3 | PASS | Independent verifier `250c026d-cc22-4d1` | Branch `fix/goal-checker-timeout-diagnostics`; working tree clean; local HEAD matched `origin/fix/goal-checker-timeout-diagnostics`; latest commit `acf1136 fix: improve goal checker timeout diagnostics` conventional. | Fresh after initial push; amended ledger row requires final re-push/recheck. |
