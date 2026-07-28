# gpt-fast-toggle

Toggle OpenAI GPT priority service tier from Pi without changing reasoning level.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/gpt-fast-toggle
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/gpt-fast-toggle/extensions/gpt-fast-toggle.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration

See `config/` for safe example config and `setup/configs/` for Aviram's current non-secret defaults.

`~/.pi/agent/gpt-fast-toggle.json` holds two keys:

| Key | Meaning |
| --- | --- |
| `mode` | `"fast"` or `"deep"` — the toggle's own state. |
| `priorityMultiplier` | Optional. How much more the priority tier costs than the standard rate for your model, e.g. `2`. |

## Cost accounting

OpenAI bills the priority service tier **above** the standard per-token rate, and
pi prices every turn from its static model rates, so a session that ran in fast
mode cost more than the usage alone can show.

To keep that visible, this extension appends a `pi-price-tier` entry to the
session whenever the effective tier changes — at session start, when you toggle,
and when you switch to or from an OpenAI GPT model. A later scan can then tell
which turns paid the premium. These are custom entries: durable, but excluded
from LLM context, and they carry nothing but the tier name.

Set `priorityMultiplier` to have those turns priced. Until you do, the
`simple-statusline` cost surfaces mark the total with a leading `~` — a floor
rather than an exact number — instead of quietly reporting it low, and `/cost`
names priority tier as the reason.
