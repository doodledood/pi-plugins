# graphite

A calm dark Pi TUI theme. Brightness carries the hierarchy and color only means state: one blue accent, soft success/error/warning colors, low-saturation diff bands, and a subtle band behind your own messages.

It pairs with [`tool-activity-renderer`](../../extensions/tool-activity-renderer), which draws tool rows from the active theme's tokens. Finished rows fade from `text` toward `muted`, and diffs tint with `toolSuccessBg` and `toolErrorBg`.

Pi themes cannot set the terminal background, so Graphite assumes a dark terminal background (it was tuned against `#0f0f11`).

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
