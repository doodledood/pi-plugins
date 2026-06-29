# goal-controller

Pi goal controller with model-callable goal start and checker-only completion.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/goal-controller
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.2.1",
      "extensions": ["packages/extensions/goal-controller/extensions/goal-controller/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration

See `config/` for a safe example config. Aviram's profile intentionally ships no goal-controller override right now; the package defaults are the current setup defaults unless you create `~/.pi/agent/goal-controller.config.json` locally.

## Original extension notes

# goal-controller

Local Pi extension for long-running goals with **checker-only completion**.

## What this replaces

This extension replaces `@narumitw/pi-goal` for this machine. The old package exposed a model-callable `goal_complete` tool, which let the same worker model doing the task mark the goal complete. `goal-controller` keeps goal start model-callable, but completion is controlled only by an independent checker subprocess run by the extension.

## Commands

```text
/goal <goal text>     Start a goal from the user/harness
/goal                 Show current goal status
/goal_pause           Pause an active, checking, or waiting goal
/goal_resume          Resume a paused, waiting, blocked, or budget-limited goal
/goal_edit            Open an editor UI prefilled with the current goal; submitting replaces it
/goal_edit <text>     Replace the current goal text immediately
/goal_clear           Clear the current goal
```

The model also sees one tool:

```ts
goal({ goal: string })
```

`goal` is **create-only**:

- accepts any non-empty goal string when no live goal exists
- rejects blank goals
- returns `active_goal_exists` without mutating state if a goal is active/checking/waiting-for-user
- creates a fresh active goal over a stopped paused/blocked/budget-limited goal without requiring `/goal_clear`
- never updates, edits, clears, pauses, resumes, or completes a live goal

## Writing effective goal text

Goal quality is guidance, not enforcement. Weak goals are accepted, but stronger goals make checker-only completion work better.

Prefer a standalone completion contract:

- durable objective
- desired end state
- verification signal (test/build/lint/eval/artifact/empty queue/etc.)
- important constraints
- stop/block condition
- optional compact progress clause

Example:

```text
Migrate the auth module to the new token API, preserving current public behavior.
Done when npm test -- auth and npm run typecheck pass, no legacy token call sites remain,
and the final diff is limited to auth-related code/tests. After each meaningful checkpoint,
record what changed, what was verified, what remains, and any blocker. If required test
credentials or environment setup are missing, stop as blocked and report exactly what is needed.
```

Goal text may reference files, docs, issues, or plans for context. Prefer not to rely on those files as the only place where success is defined; the checker should be able to understand what “done” means from the goal text itself.

## Completion behavior

On each completed worker turn, the controller:

1. updates goal usage counters,
2. checks budgets/limits,
3. runs an independent checker subprocess when safe,
4. applies the checker verdict:
   - `decision: "complete"` → goal becomes complete and continuation stops
   - `decision: "continue"` → checker guidance is fed into the next worker turn
   - `decision: "waiting_for_user"` → automatic continuation stops until the next user-driven worker turn, then goal context resumes automatically
   - `decision: "blocked"` → goal becomes blocked and continuation stops until resumed

The checker prompt is adversarial: it treats completion as unproven, audits the exact goal text requirement-by-requirement, treats worker claims as claims rather than proof, and prefers false negatives over false positives. The checker receives compact goal/session navigation context rather than capped inline history: goal state, the current Pi session file path when available, current leaf entry id, branch/message counts, and latest-turn tool metadata. The checker always runs with one audit-only capability profile: built-in `read`, `grep`, `find`, and `ls` plus skill discovery. Extension tools, prompt templates, context files, shell execution, and file mutation tools are disabled. When read/search tools and a persisted session file are available, the checker may review the session artifact, referenced files, workspace search results, or relevant skills when that helps judge completion. It must distinguish worker-surfaced evidence from checker-reviewed evidence, and it must not use checker-side review to perform omitted primary success work on the worker's behalf: if tests/builds/evals/deployments are required and the session state does not show they were done, it tells the worker to run or surface them. It must choose `continue` while the worker has a meaningful next action, including asking the user for a missing success signal; `blocked` is reserved for cases where no safe/actionable next step remains.

## Footer status and checker control

The controller publishes compact lifecycle status through Pi's extension status API under the `goal-controller` key. It does not own or customize the footer renderer; any installed statusline consumes the published status as a generic extension status.

While a checker subprocess is running, the published status includes a subtle loading frame plus second-level elapsed time and the configured timeout, for example:

```text
goal checking ⠋ 0:42/5m
```

While a goal is active and no checker is running, the status includes only calm wall-clock elapsed time since the goal started. The elapsed token is subtly highlighted with the statusbar effort/high theme color when theming is available, and it is rounded to the visible minute boundary instead of ticking every second, for example:

```text
goal active 12m
goal active 1h 04m
```

Other non-checking lifecycle states stay compact, for example `goal waiting user`, `goal paused`, or `goal complete`.

User commands that change goal state handle a running checker explicitly:

- `/goal_pause` cancels the running checker and pauses the goal.
- `/goal_clear` cancels the running checker and clears the goal.
- `/goal_edit` refuses to edit while checking and asks the user to pause or clear first.

If Pi reloads, switches session tree state, or shuts down while a persisted goal says `checking`, the controller treats that checker as interrupted rather than showing it as still running with no subprocess behind it.

## Configuration

Config path:

```text
~/.pi/agent/goal-controller.config.json
```

Default installed config:

```json
{
  "defaultTokenBudget": null,
  "defaultTurnBudget": null,
  "defaultTimeBudgetSeconds": null,
  "checker": {
    "mode": "llm",
    "model": "inherit",
    "thinking": "inherit",
    "timeoutMs": 300000
  },
  "continuation": {
    "noToolContinuationLimit": 3
  }
}
```

Budget fields are user-editable and default to unbounded. `defaultTokenBudget`, `defaultTurnBudget`, and `defaultTimeBudgetSeconds` may be positive numbers to add token, turn, or wall-clock limits for new goals; set them to `null` or omit them to leave that dimension unbounded.

The checker subprocess capability profile is fixed: it can use built-in `read`, `grep`, `find`, and `ls`, and it can discover and activate skills. Extension tools, prompt templates, context files, `bash`, `edit`, and `write` are disabled so the checker remains an auditor rather than a worker substitute.

If an existing local config still contains `checker.toolMode`, remove that field. It no longer changes checker behavior; the loader warns that it is unsupported and uses the fixed audit-only profile.

`continuation.noToolContinuationLimit` blocks runaway automatic continuation loops after the configured number of consecutive checker-driven continuation turns make no tool progress. The default is `3`. Tool-using turns and user/system interventions reset the count.

The default checker timeout is 300000ms (5 minutes), which gives tool-assisted checker subprocesses more room to review larger sessions while still bounding runaway checks.

`inherit` means the checker uses the current Pi session model or thinking level when possible. Set explicit values, for example:

```json
{
  "checker": {
    "mode": "llm",
    "model": "openai/gpt-5.5",
    "thinking": "xhigh",
    "timeoutMs": 300000
  }
}
```

Missing config uses defaults. Invalid JSON or non-object config surfaces a warning and uses defaults. Invalid scalar field values are ignored, surfaced in a warning, and replaced with documented defaults. Unsupported checker fields are also surfaced in a warning and ignored.

## Reload

After changing extension files or config:

```text
/reload
```

or restart Pi.

## Rollback

The old package was removed from `~/.pi/agent/settings.json`:

```json
"npm:@narumitw/pi-goal"
```

To roll back, add that package entry back to `packages`, remove or disable this `goal-controller` extension directory, then reload/restart Pi.

## Current limitations

- Single live goal per session; stopped paused/blocked/budget-limited goals may be superseded by a new goal.
- No hard goal-quality enforcement.
- No model-callable lifecycle controls beyond starting a fresh goal and superseding stopped goals; no live-goal update/replace/clear/pause/resume/complete.
- No worker progress tool; progress is ordinary assistant responses and tool-result evidence in the session.
- Checker is tool-assisted but not a worker substitute. Its fixed audit-only profile allows read/search/list tools and skills, while disabling shell execution, file mutation, extension tools, prompt templates, and context files. The checker should not run omitted primary verification work such as required test/build/eval/deploy steps on the worker's behalf.
- In-memory or otherwise unpersisted sessions provide degraded checker evidence because there is no session file for deeper checker review.
- Checker `waiting_for_user` is a stop-for-input state, not terminal completion; the next user-driven turn resumes goal context automatically.
