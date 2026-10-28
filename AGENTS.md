# pi-plugins repo guidance

- Keep every shareable resource individually installable: each extension and theme lives in its own package under `packages/`; global skills are intentionally excluded.
- Keep the root `package.json` Pi manifest in sync with all included extension/theme resource paths so Git package filters can select individual resources from this repo.
- Do not commit live Pi runtime state, credentials, OAuth material, session logs, caches, `node_modules`, raw `auth.json`, or unredacted API keys.
- Put Aviram's portable setup in top-level `setup/`; make it merge-oriented and template secrets/placeholders.
- Verify changes through `scripts/verify` (see *Project surfaces*); its `project-checks` recipe runs the structure check, every typecheck and every test.

## Sync checklist for resource changes

When adding, removing, renaming, or moving an extension/theme, keep all install surfaces in sync in the same change:

- Root `package.json`: `workspaces` and `pi.extensions` / `pi.themes` paths.
- The resource package `package.json`: `name`, `description`, `keywords`, `pi.*`, `files`, `repository.directory`, version, and publish metadata.
- Package README: local install, future npm install, Git package-filter path, config/local-state notes.
- Root docs: `README.md` and `docs/installing.md` examples and resource lists.
- Setup templates: `setup/settings.local.example.json`, `setup/settings.example.json`, relevant `configs/*.json`, and `mcp-adapter.example.json` when MCP categories change.
- `scripts/verify-structure.mjs`: expected extension/theme lists and structural checks.
- `package-lock.json`: regenerate with `npm install --package-lock-only --ignore-scripts` when package metadata/workspaces change; remove `node_modules/` afterward.

If an extension starts reading or writing local files, env vars, credentials, browser profiles, caches, or generated state, document that in its package README and add/verify matching `.gitignore` coverage. Do not leave stale install paths such as `~/.pi/agent/extensions/<name>` unless that is truly the supported install mode.

## Project surfaces

<!-- setup-project surfaces v11 -->

This project keeps its direction, vocabulary, and decision memory in the repo — shared
ground for every contributor and agent, regardless of tooling. Read `NORTH_STAR.md` and
`CONTEXT.md` at the start of every session.

- **NORTH_STAR.md** — what this project is for and for whom, the principles it holds, how it
  measures progress, and the bets it rests on. Anchor on it scope, priority, outward claims, and
  any call the work's own contract does not settle — a mid-run pivot, whether to act on a
  review comment, what to leave alone. The choices made along the way live in `docs/adr/`,
  never in it. Each position carries a dated state
  (evidence / hypothesis / ruled / empty): new evidence may lower a state, but a
  position changes only by an authorized ruling, recorded with its decider and any explicit
  delegation. Owner-retained ends and bounds stay with the owner. A line gives grounds for a
  second look, not a veto: before it cuts an option, check that it covers the case. Where it
  does, a person decides; a run with no person present follows it and raises the challenge. The full form is `docs/NORTH_STAR_CONVENTIONS.md` — it is self-contained.
- **Scoped instructions** — coordinating Tickets in this repository follows
  `tickets/store-config.md`, which names the venue, the automation identity unattended runs
  need, and the escalation recipient. These apply within assigned work; they do not start work.
  Personal restrictions stay in the existing private instructions.
- **CONTEXT.md** — what words mean here. It is not optional reading: it exists to stop silent
  misreading, and nobody looks up a term they already believe they understand. Read it before
  naming things; add a term when the project settles one.
- **docs/adr/** — why decisions went the way they did. Open `docs/adr/README.md` before
  deciding a question a record may already cover, and when a change contradicts or narrows
  one; outside those two moments, leave it closed. A record gives grounds, not a veto: follow
  it where its reasons still hold, and reopen it where a premise no longer holds or a need it
  did not weigh makes sense. Outside the `Strategy` area, a run with no
  person present decides for itself and lists each record it reopened first in its report
  and pull request. Write new records per
  `docs/adr/CONVENTIONS.md` — it is self-contained, and writing one is one act: the
  record, the restatus of what it changes, and the index rebuild together. The restatus is the
  step that gets dropped; the index is rebuilt from the records, never edited beside them.
- **Verification** — `scripts/verify`: how this project checks that its work still does its job.
  Run it before saying a change works, when reproducing a reported problem, and when a change
  touches something one of its recipes covers (`scripts/verify list` shows them); a change that
  needs a check no recipe has adds one. Every check this project keeps is a recipe, the checks it
  runs across the whole tree among them: call their commands directly while iterating, and drive the recipe for the
  evidence a change rests on. Recipes without the ask-first mark are free: run them as often as
  they help.
  Recipes marked ask-first cost money, quota, load on shared systems or effects outside the
  repository: run those only when a person runs them or has agreed. `scripts/verify --help` gives the
  rest.

## Version and install-ref policy

Pi clients install this repo via a Git source tracking the `main` branch (`git:github.com/doodledood/pi-plugins@main`), so installs and `pi update --extensions` always follow the latest version — no doc reference needs to move on release. Tags are not published for new versions; a few old `vX.Y.Z` tags remain as frozen historical snapshots.

- All Pi install snippets in docs (`README.md`, `docs/installing.md`, package READMEs, setup templates) reference `@main`. Do not reintroduce `@vX.Y.Z` pins into install examples.
- Prime Agent install snippets are deliberately ref-less (`git:github.com/doodledood/pi-plugins`). Prime Agent 0.7.0 treats any ref as pinned and silently skips pinned sources in `prime-agent package update` and in its startup update notice, so `@main` there means the package never updates. Do not "fix" those snippets to `@main`.
- Any change under `packages/**` must still bump the root `package.json` `version` (and the affected package's own `version`) in the same change. Bump minor for new features, patch for fixes, per semver — versions remain the release history and npm-publish metadata.
- `.github/workflows/version-bump-check.yml` fails PRs that touch `packages/**` without bumping the root version, so this can't regress silently.

## Coding Conventions

### Solution design

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

### What counts as verified

- Evidence ranks: unit/integration tests > a written verification script > manual checking. Prefer targeted checks to full-suite reruns, and exhaust the automated options before asking the user to verify by hand.
- Code with existing test files gets its tests added or updated there, covering the layers the change actually touches — unit and integration where both apply.
- For e2e or integration work, write the verification script inline when feasible.
- Say plainly what you did not verify.

### Git and pull requests

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. Branches `feature/*`, `fix/*` unless the project says otherwise.
- Prefer several coherent medium PRs to one monolith when the work naturally splits. Slice vertically — one feature stage end-to-end, handler + service + entity + tests — not horizontally, where each slice carries no logic of its own and only makes sense combined. Small mechanical changes (renames, config, migrations, boilerplate) ride along with the logic that needs them; a sweeping mechanical refactor can still earn its own PR for reviewability. Don't grow a PR past its natural scope — split instead.
- Open PRs substantially complete. The title names the real scope — the workflow and modules touched, not the immediate symptom. The description leads with what the change does and why it needed this design — the cross-module flow, the non-obvious decisions, the invariants preserved — not a file-by-file list.
