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

See `config/` for safe example config and `profiles/aviram/configs/` for Aviram's current non-secret defaults.

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

The checker prompt is adversarial: it treats completion as unproven, audits the exact goal text requirement-by-requirement, treats worker claims as claims rather than proof, and prefers false negatives over false positives. The checker receives the transcript and current session file path. Its tool access is controlled by `checker.toolMode`: `inspect` (default) allows inspection while excluding obvious local mutation tools and extension tools; `transcript` disables tools; `full` is explicit opt-in for unrestricted tools. When tools are available, the checker may inspect files, logs, session artifacts, external sources, or command output when that helps judge completion. It must distinguish worker-surfaced evidence from checker-inspected evidence, and it must not use checker tools to perform omitted primary success work on the worker's behalf: if tests/builds/evals/deployments are required and the transcript/state does not show they were done, it tells the worker to run or surface them. It must choose `continue` while the worker has a meaningful next action, including asking the user for a missing success signal; `blocked` is reserved for cases where no safe/actionable next step remains.

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
    "timeoutMs": 120000
  },
  "continuation": {
    "suppressAfterNoToolContinuation": true,
    "transcriptMaxChars": 80000,
    "checkerHistoryLimit": 8
  }
}
```

Budget fields are user-editable and default to unbounded. `defaultTokenBudget`, `defaultTurnBudget`, and `defaultTimeBudgetSeconds` may be positive numbers to add token, turn, or wall-clock limits for new goals; set them to `null` or omit them to leave that dimension unbounded.

`checker.toolMode` controls checker subprocess tools:

- `inspect` (default): checker can inspect with built-in tools but excludes obvious local mutation tools (`edit`, `write`) and extension tools.
- `transcript`: checker runs without tools and judges only the provided state/transcript.
- `full`: checker gets unrestricted tools as an explicit opt-in; rely on the checker prompt for restraint.

`inherit` means the checker uses the current Pi session model or thinking level when possible. Set explicit values, for example:

```json
{
  "checker": {
    "mode": "llm",
    "toolMode": "inspect",
    "model": "openai/gpt-5.5",
    "thinking": "xhigh",
    "timeoutMs": 120000
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
- No worker progress tool; progress is ordinary transcript text/evidence.
- Checker is tool-assisted but not a worker substitute. Default `inspect` mode allows inspection but excludes obvious mutation tools and extension tools; `full` is opt-in. The checker should not run omitted primary verification work such as required test/build/eval/deploy steps on the worker's behalf.
- Checker `waiting_for_user` is a stop-for-input state, not terminal completion; the next user-driven turn resumes goal context automatically.
