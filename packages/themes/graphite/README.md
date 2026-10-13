# graphite

A calm dark Pi TUI theme. Brightness carries the hierarchy and color only means state: one blue accent, soft success/error/warning colors, low-saturation diff bands, and a subtle band behind your own messages.

It pairs with [`tool-activity-renderer`](../../extensions/tool-activity-renderer), which draws tool rows from the active theme's tokens. Finished rows recede: verbs toward `muted`, file names toward a soft `text`/`muted` mix, directories toward `dim`, and diffs tint with `toolSuccessBg` and `toolErrorBg`.

Thinking sits below all of that: `thinkingText` is `#7d7d86`, a step under `muted` (tool output) and well above `dim` (metadata), so the reasoning reads as a quiet layer under the reply and the tool rows. It is the darkest tone that still clears 4.5:1 contrast on a `#141418` background, because thinking is often the only explanation of what the agent is about to do. The renderer also draws inline code inside thinking in that tone instead of the bright code color.

The editor border and the footer's level word take the thinking-level color, so they are on screen all the time. Graphite keeps them below the accent up to `high`: `low`, `medium` and `high` climb a desaturated blue ramp from just above `dim` to just above `muted` brightness. Other extensions that borrow a level color follow the same ramp, for example goal-controller's active-goal timer, which uses `thinkingHigh`. The accent stays free to mean "live now" for the working line's dot and a running tool's shimmer. Only `xhigh` and `max`, the rare expensive levels, reach the accent and `accentSoft`.

Pi themes cannot set the terminal background or the reply's text color: the reply is drawn in the terminal's own default foreground. Graphite assumes a dark background (it was tuned against `#0f0f11` and `#141418`) and a bright default foreground; on a terminal whose default text is dimmer than about `#cacad0`, finished tool rows would outrank the reply.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/themes/graphite
```

After npm publication:

```bash
pi install npm:@doodledood/pi-theme-graphite
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": [],
      "skills": [],
      "prompts": [],
      "themes": ["packages/themes/graphite/themes/graphite.json"]
    }
  ]
}
```

Select it after install:

```json
{ "theme": "graphite" }
```
