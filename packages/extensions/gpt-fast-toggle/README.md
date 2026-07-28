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
| `priorityMultiplier` | Optional. The priority tier's price as a multiple of the standard rate for your model — `2` means priority turns cost twice the standard rate, not twice plus the standard rate. It is copied into each tier record, so any cost surface can price those turns. |

## Cost accounting

OpenAI bills the priority service tier **above** the standard per-token rate, and
pi prices every turn from its static model rates, so a session that ran in fast
mode cost more than the usage alone can show.

To keep that visible, this extension appends a `pi-price-tier` entry to the session
whenever the effective tier changes, recorded from the same read of the state file
that decides the outgoing request. That matters because the file is shared across
pi processes: toggling fast mode in one session changes what every other session is
billed, and a record derived only from session or model events would go stale —
turns billed at the premium while the session's own records still said standard. A later scan can then tell
which turns paid the premium. These are custom entries: durable, but excluded
from LLM context, and they carry nothing but the tier name.

Set `priorityMultiplier` and the record carries it, so a cost surface prices those
turns without knowing this extension exists. Until you do, the record states the
tier alone and cost surfaces mark the total with a leading `~` — a floor rather
than an exact number — instead of quietly reporting it low.
