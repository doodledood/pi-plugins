# ADR: Split the coding conventions out of setup/AGENTS.md

## Status
Accepted

## Context

`setup/AGENTS.md` is the template for Aviram's user-level agent instructions — the file a machine installs to `~/.pi/agent/AGENTS.md`. It carried two kinds of rule that had nothing to do with each other beyond both being his.

**Operating posture**: voice, evidence register, when to ask, how much autonomy, when to delegate a task. It describes how an agent should behave with him, and it is true of his machine rather than of any codebase.

**Coding conventions**: design against a class of bugs rather than patch the instance, what counts as verified, how commits and pull requests are shaped. These describe the artifact. They hold for anyone working in a codebase, including people and agents that have never met him.

The two were inseparable while they shared a file, and that turned out to matter. Other repositories wanted the conventions — a project benefits from "close the class, don't patch the instance" whatever the environment loads — and could only get them by taking the posture too, pushing rules about how to talk to one person into repositories other people read. Some environments never load a user-level context file at all, so the conventions were reaching only the machines that installed this template.

## Decision

Split them. `setup/CODING_CONVENTIONS.md` carries the conventions; `setup/AGENTS.md` keeps the posture and references the conventions file by name, so a full install still delivers both.

Two constraints follow, and both are enforced rather than remembered:

- **The pair travels together.** A machine that copies `AGENTS.md` without the companion gets a reference to a file that is not there. Nothing at install time fails — the conventions are simply gone, silently. `scripts/verify-structure.mjs` checks that both files exist and that `AGENTS.md` still names the companion, and the replication runbook in `README.md` must list both.
- **The conventions file opens with `# Coding Conventions`.** Repositories outside this one merge the file in as a section anchored on that title, so the title is an interface rather than a heading. `verify-structure.mjs` checks it.

## Alternatives Considered

- **Leave one file and let consumers extract what they want.** Rejected: every consumer would repeat the same split by hand, and the boundary would drift between them. The split belongs where the file is authored.
- **Split by copying rather than referencing** — duplicate the conventions into both files so `AGENTS.md` stays self-contained. Rejected: two copies of one rule set, and the install-time failure it avoids is already covered by a structural check.
- **A third file for the working practices** (`Information gathering`, `Delegating to subagents`, `Tools`). Rejected for now: those describe how an agent conducts a session, which puts them with the posture rather than with the artifact. Worth revisiting if a consumer asks for them.

## Consequences

### Positive

- The conventions can be shared with a project without the posture riding along.
- Each half can change without touching the other, and the conventions have a name a consumer can point at.
- Two failure modes that would have been silent — a missing companion and a renamed title — now fail the structure check.

### Negative

- One more file in the install surface, and one more thing for a partial sync to get wrong.
- The conventions file's title is now load-bearing for consumers outside this repository, which is a constraint no reader of the file alone would guess. The structure check is what carries that knowledge forward.

## Source
- Session: 2026-08-20, splitting the conventions so other repositories can adopt them
- Related: consumed by the `sync-coding-conventions` skill in `doodledood/second-brain`
