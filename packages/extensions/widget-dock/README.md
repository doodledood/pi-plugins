# widget-dock

Folds the todo and subagent widgets above Pi's editor into one summary line, so they stop taking transcript space.

Requires Pi 1.4.0 or later.

```
 ● Todos 1/3 · Push, deploy t205986   ⠋ 20 running agents                    alt+w to expand
```

`alt+w` opens the docked widgets in full in the same place; press it again to fold them back.

The line stays as quiet as the rest of the chrome: its words are muted, and only the glyphs take the accent while a todo is in progress or an agent is running. When rpiv-todo's widget is collapsed or cut short, so its rows can't show whether a task is in progress, the todo glyph follows its heading instead and stays lit while open work remains. When no docked widget draws anything (a finished todo list, no agents left), the dock draws nothing, so the hint never opens onto an empty space.

## What it docks

| Widget key | From | Summary on the dock line |
| --- | --- | --- |
| `rpiv-todos` | `@juicesharp/rpiv-todo` | done/total and the task in progress; when several are in progress, how many and the newest (`Todos 4/15 · 2 active · …`) |
| `agents` | `@gotgenes/pi-subagents` | the running-agent count, with a spinner |

The subagent count (`subagents` status) moves from the footer to the dock line, which saves another row.
Other widgets are left alone.

## How it works and what it depends on

Pi gives every extension the same `ctx.ui` object, and extensions call `ctx.ui.setWidget` when they show or update a widget.
On `session_start` this extension wraps `setWidget` and `setStatus` on that object: the two docked keys are kept by the dock, which draws them as one widget, and everything else passes through unchanged.

- It must load before the widgets' extensions register them; list this package before `rpiv-todo` in `settings.json` `packages` (a todo widget restored at startup by an earlier extension is not docked until it is set again).
- It reads the docked widgets' rendered text to build the summary (`Todos (N/M)`, the `◐` task line). For that one read it renders rpiv-todo's widget as if tools were expanded, so a task in progress beyond the first ten open rows is still found; the setting is put back straight after. The task shown is the row's subject without rpiv-todo's `#id` prefix, its `⛓ #n` blocked-by chain, or the trailing `(active form)` group; parentheses inside the subject stay. A subject that itself ends in parentheses and has no active form loses that last group, since the rendered row cannot tell them apart. If those extensions change their wording, the summary falls back to less detail; the expanded view is always their own rendering.
- The toggle is an alt chord on purpose: `ctrl+shift` chords degrade to plain `ctrl` in terminals without extended keys, and `ctrl+shift+d` would arrive as `ctrl+d`, which quits Pi.

It reads and writes no files.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/widget-dock
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/widget-dock/extensions/widget-dock.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

From npm (once published):

```bash
pi install npm:@doodledood/pi-widget-dock
```
