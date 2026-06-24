# pi-plugins

A collection of individually installable Pi extensions and themes maintained in this repository.

## Language

**Tool activity renderer**:
A Pi extension in this repo that wraps built-in file and shell tools with compact custom TUI renderers.
_Avoid_: Tool rendering plugin.

**Compact tool rendering**:
A renderer mode that minimizes built-in tool rows by hiding routine output unless the row is expanded or something abnormal happens.
_Avoid_: Compact mode when the renderer context is unclear.

**Tool-row glyph**:
The leading colored dot or spinner that marks a compact tool row and anchors the rendered tool activity in the transcript.
_Avoid_: Dot thingy.

**Goal controller**:
A Pi extension in this repo that manages one long-running session goal and delegates completion authority to an independent checker.
_Avoid_: Goal mode when referring to the extension implementation.

**Goal checker**:
An independent Pi subprocess run by the goal controller to assess whether the active goal's completion contract has been proven.
_Avoid_: Worker, completion tool.

**Goal footer**:
The Pi footer/statusline segment used by the goal controller to show the active goal's lifecycle state.
_Avoid_: Goal widget when referring only to the footer/statusline surface.

**Live goal**:
A goal controller goal that is active, checking, or waiting for user input and should block starting a different goal.
_Avoid_: Non-terminal goal when the distinction includes stopped states.

**Stopped goal**:
A goal controller goal that is paused, blocked, or budget-limited and may be replaced by a newly started goal without an explicit clear.
_Avoid_: Inactive goal when the lifecycle boundary is ambiguous.

## Relationships

- The **Goal controller** publishes **Goal footer** state through Pi extension status APIs; the statusline renderer consumes that state but remains a separate surface.
- A **Live goal** blocks new goal starts; a **Stopped goal** can be superseded by a new **Goal controller** goal.

## Flagged ambiguities
