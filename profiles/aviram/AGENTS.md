# Tools

## Tool Usage

- Use `mv`/`cp` via Bash for file copying/moving instead of Read+Write—shell commands are faster and preserve metadata.

## Subagents

- When launching subagents, do not set `model` or `thinking` / reasoning-effort overrides by default.
- Leave those fields unset so the harness uses the current session or configured subagent default; do not downgrade agents for speed or cost unless requested.
- Override a subagent's model or reasoning effort only when the user explicitly asks for it or when the task clearly requires a different capability; state the reason when overriding.

## Thoroughness

- Default to high comprehensiveness—optimize for recall over precision.
- Applies to exploration, search, research, and all information-gathering tasks.
- Err toward more coverage; shallow/lazy passes miss critical context.

# Planning

## Prompt Work

- For prompt-related work (skills, agents, system prompts, CLAUDE.md files), invoke a prompt-engineering skill if one is separately installed; otherwise apply the calibration inline before suggesting or making changes.

# Implementation

## Change Philosophy

- Don't overfit to feedback—make right-sized changes without overcorrecting.

## Git Workflow

- Use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Branch naming: `feature/*`, `fix/*` by default (project CLAUDE.md can override).

# Verification

## Testing

- Every code change requires verification—don't trust output without testing.
- Prefer: unit/integration tests > bash verification scripts > manual verification.
- For code with existing test files, add or update tests there.
- For e2e or integration work, write inline verification scripts when feasible.
- Only when automated verification is impossible, prompt user for manual verification—but exhaust automated options first.
