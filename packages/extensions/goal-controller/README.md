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
      "source": "git:github.com/doodledood/pi-plugins@v0.1.0",
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
/goal_pause           Pause an active or waiting goal
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

- accepts any non-empty goal string when no non-terminal goal exists
- rejects blank goals
- returns `active_goal_exists` without mutating state if a goal is active/checking/waiting-for-user/paused/blocked/budget-limited
- never updates, replaces, edits, clears, pauses, resumes, or completes a goal

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

The checker prompt is adversarial: it treats completion as unproven, audits the exact goal text requirement-by-requirement, treats worker claims as claims rather than proof, and prefers false negatives over false positives. The checker receives compact goal/session navigation context rather than a capped transcript: goal state, the current Pi session file path when available, current leaf entry id, branch/message counts, and latest-turn tool metadata. Its tool access is controlled by `checker.toolMode`: `inspect` (default) allows inspection while excluding obvious local mutation tools and extension tools; `transcript` disables tools and is degraded for session-file inspection; `full` is explicit opt-in for unrestricted tools. When tools and a persisted session file are available, the checker may inspect files, logs, session artifacts, external sources, or command output when that helps judge completion. It must distinguish worker-surfaced evidence from checker-inspected evidence, and it must not use checker tools to perform omitted primary success work on the worker's behalf: if tests/builds/evals/deployments are required and the session state does not show they were done, it tells the worker to run or surface them. It must choose `continue` while the worker has a meaningful next action, including asking the user for a missing success signal; `blocked` is reserved for cases where no safe/actionable next step remains.

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
    "toolMode": "inspect",
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

`checker.toolMode` controls checker subprocess tools:

- `inspect` (default): checker can inspect with built-in tools but excludes obvious local mutation tools (`edit`, `write`) and extension tools.
- `transcript`: checker runs without tools. This mode is degraded with the session-navigation checker design because it cannot inspect the persisted session file; prefer `inspect` unless you deliberately want no checker-side inspection.
- `full`: checker gets unrestricted tools as an explicit opt-in; rely on the checker prompt for restraint.

`continuation.noToolContinuationLimit` blocks runaway automatic continuation loops after the configured number of consecutive checker-driven continuation turns make no tool progress. The default is `3`. Tool-using turns and user/system interventions reset the count.

The default checker timeout is 300000ms (5 minutes), which gives tool-assisted checker subprocesses more room to inspect larger sessions while still bounding runaway checks.

`inherit` means the checker uses the current Pi session model or thinking level when possible. Set explicit values, for example:

```json
{
  "checker": {
    "mode": "llm",
    "toolMode": "inspect",
    "model": "openai/gpt-5.5",
    "thinking": "xhigh",
    "timeoutMs": 300000
  }
}
```

Missing config uses defaults. Invalid JSON or non-object config surfaces a warning and uses defaults. Invalid scalar field values are ignored, surfaced in a warning, and replaced with documented defaults.

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

- Single active non-terminal goal per session.
- No hard goal-quality enforcement.
- No model-callable goal update/replace/clear/pause/resume/complete.
- No worker progress tool; progress is ordinary assistant responses and tool-result evidence in the session.
- Checker is tool-assisted but not a worker substitute. Default `inspect` mode allows inspection but excludes obvious mutation tools and extension tools; `full` is opt-in. The checker should not run omitted primary verification work such as required test/build/eval/deploy steps on the worker's behalf.
- In-memory or otherwise unpersisted sessions provide degraded checker evidence because there is no session file for deeper checker inspection.
- Checker `waiting_for_user` is a stop-for-input state, not terminal completion; the next user-driven turn resumes goal context automatically.
