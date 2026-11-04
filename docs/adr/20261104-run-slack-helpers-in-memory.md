# ADR: Run Slack helpers in memory and keep only what each one adds

## Status
Accepted; amended by 20261104-show-slack-activity-in-a-dock-line (exchanges show in one line above the editor and a panel, not in main's transcript)

## Area
slack-companion

## Decided by
An agent, from the owner's rulings that every interaction is a fresh fork of the main session and that the forks must not pollute the session space. The owner saw it in the read and did not object. The owner did not review this record's text.

## Context
A Slack helper is forked from the main session for each batch of new messages. 20260728-session-tree-cost-accounting has every spawned model run persist as a normal session file under its parent's sidecar directory, and a fork copies its parent's entries verbatim. A long main session copied once per batch would multiply disk use, and the owner asked that the forks not pollute the session space. Pi's SDK can run a session on an in-memory session manager seeded with entries, and an extension can show durable entries in the transcript without sending them to the model.

## Decision
- Each helper runs on an in-memory session seeded from the main session's branch, without the parent's extension state, as 20261014-fork-btw-without-parent-extension-state does for BTW.
- When the helper ends, its own entries (the messages it received, its tool calls and its replies, with their usage) are written to a session file under the parent's sidecar directory, linked to the parent, without the copied parent entries. Its spend and what it did stay discoverable; no copy of main is kept.
- The main session's model context receives only hand-offs; the owner sees each exchange in main's transcript as a display-only entry.

## Alternatives Considered
- **Persist each helper as a full copy, like BTW**: a transcript that loads on its own; rejected because it copies main's whole history for every batch of messages.
- **Persist nothing and record only a cost entry**: smallest; rejected because what the helper said and read on the owner's behalf would be lost.

## Consequences

### Positive
- Disk use grows with what helpers do, not with the size of main.
- Session-tree cost accounting still counts every helper.

### Negative
- A helper's file is not a complete session: it cannot be resumed on its own, and reading it needs the parent for context.

## Enforced by
`packages/extensions/slack-companion/extensions/slack-companion/records.test.ts` ("a helper's record holds only its own entries, links to the parent, and the tree total counts helpers and triage") — pins the thin record and that session-tree cost accounting counts every helper and triage call.

## Source
- Session: figure-out on a Slack companion for a running Pi session (2026-11-04), log `~/.manifest-dev/logs/figure-out-log-20261104-121826.md`.
- Narrows 20260728-session-tree-cost-accounting for Slack helpers.
- Related: 20261104-hold-slack-conversations-in-a-read-only-fork-of-main
