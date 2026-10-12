# Coding Conventions

## Solution design

In any domain — code, process, tooling, docs, prompts — prefer the design that prevents a class of problems over the quick one that merely works today. And treat every problem you touch as one you should not meet again: leave the system so that class of problem cannot return, or costs less when it does. At any size of change, also make the next change — by anyone, human or agent — easier to get right, in proportion to how often that area changes; sound existing structure needs no redesign. This is an investment, not polish: time spent up front making code harder to get wrong is repaid as speed on every later change.

- The cheapest class of bugs to prevent is the code never written — before designing, ask whether the requirement itself is needed, and say so when it isn't. That includes what you propose yourself: an extra mode, rival path, or option earns a place in the build only when the next decision needs it; otherwise name it as a later addition.
- Design so a class of bugs cannot occur, whether or not one has occurred yet: illegal states unrepresentable, the invariant enforced where it cannot be bypassed, one source of truth instead of two that can disagree. This is the default for new code as much as for a fix — the design that closes the class beats the patch that handles the instance in front of you.
- Among designs that close the class, take the one with the fewest moving parts and the least hidden coupling. Reshaping a widely used type earns its churn when ordinary callers could otherwise get the next change wrong — which is usually why the bug happened; when every caller already passes through one owning operation, enforcing the invariant there is enough. Machinery heavier than the burden it removes is over-engineering, not design — unless the user asks to optimize for a different priority.
- Fail loud. No fallback, catch-and-continue, or default value that masks a failure unless degraded operation is explicitly wanted — silent wrong behavior costs more than a crash.
- A bug fix closes its class across the whole codebase by default, not only where the bug surfaced: if a loose string should have been a strict type, the type changes everywhere that value flows, and every sibling instance gets the same structural fix rather than its own patch. The wider diff is the point, not scope creep. Once the class is closed, delete what it made redundant — defensive checks and tests that only guarded the now-impossible state — but validation of untyped input (API payloads, database rows, user input) moves to the boundary where that input enters rather than disappearing. When the fix is urgent or the sweep is large, land the instance fix first and close the class in the change right after — sequenced, not dropped.
- When closing the class is genuinely out of reach, fix the instance and name the design that would close it — don't ship the patch as if it settled the matter.
- A rule that lives as a sentence someone must remember is a check waiting to be written — when a convention can be enforced by a type, lint, test, or CI gate, propose the enforcement. Price it like any machinery: worth building where failure is expensive or the surface is shared, not on a solo surface already verified locally.
- A new dependency is a recurring cost, not a one-time one — prefer the standard library or what the repo already uses, and justify any addition.
- Favor locality: keep what changes together in one place, so a change, a fix, or a check is made once rather than at every site. Work that has to be repeated across many sites points to a missing seam — close it when the work already passes through those sites or a bug class runs through it, and propose it separately otherwise. Clean the touched area enough for a durable fix either way.
- Unused is off. When a change removes or narrows something, delete what it leaves unused — code, config, flags, tests, docs, and mentions of the removed concept — rather than keeping or explaining it; keep an unused part only when the user explicitly asks for it. Leftovers mislead the next session about what is live.

## What counts as verified

- Evidence ranks: unit/integration tests > a written verification script > manual checking. Prefer targeted checks to full-suite reruns, and exhaust the automated options before asking the user to verify by hand.
- Code with existing test files gets its tests added or updated there, covering the layers the change actually touches — unit and integration where both apply.
- For e2e or integration work, write the verification script inline when feasible.
- Say plainly what you did not verify.

## Git and pull requests

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Branches `feature/*`, `fix/*` unless the project says otherwise.
- Prefer several coherent medium PRs to one monolith when the work naturally splits. Slice vertically — one feature stage end-to-end, handler + service + entity + tests — not horizontally, where each slice carries no logic of its own and only makes sense combined. Small mechanical changes (renames, config, migrations, boilerplate) ride along with the logic that needs them; a sweeping mechanical refactor can still earn its own PR for reviewability. Don't grow a PR past its natural scope — split instead.
- Open PRs substantially complete. The title names the real scope — the workflow and modules touched, not the immediate symptom. The description leads with what the change does and why it needed this design — the cross-module flow, the non-obvious decisions, the invariants preserved — not a file-by-file list.
