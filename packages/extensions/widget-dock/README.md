# widget-dock

Folds the todo and subagent widgets above Pi's editor into one summary line, so they stop taking transcript space.

```
 ● Todos 1/3 · Push, deploy t205986   ⠋ 20 running agents                    alt+w to expand
```

`alt+w` opens the docked widgets in full in the same place; press it again to fold them back.

## What it docks

| Widget key | From | Summary on the dock line |
| --- | --- | --- |
| `rpiv-todos` | `@juicesharp/rpiv-todo` | done/total and the task in progress |
| `agents` | `@gotgenes/pi-subagents` | the running-agent count, with a spinner |

The subagent count (`subagents` status) moves from the footer to the dock line, which saves another row.
Other widgets are left alone.

## How it works and what it depends on

Pi gives every extension the same `ctx.ui` object, and extensions call `ctx.ui.setWidget` when they show or update a widget.
On `session_start` this extension wraps `setWidget` and `setStatus` on that object: the two docked keys are kept by the dock, which draws them as one widget, and everything else passes through unchanged.

- It must load before the widgets' extensions register them; list this package before `rpiv-todo` in `settings.json` `packages` (a todo widget restored at startup by an earlier extension is not docked until it is set again).
- It reads the docked widgets' rendered text to build the summary (`Todos (N/M)`, the `◐` task line). If those extensions change their wording, the summary falls back to less detail; the expanded view is always their own rendering.
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
