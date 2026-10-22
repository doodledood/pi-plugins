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

`~/.pi/agent/gpt-fast-toggle.json` (in Pi's agent directory) holds one key, `mode`: `"fast"` or `"deep"` — the toggle's own state. It is shared by every pi process, and each request reads it, so a toggle in one session applies to the next request of every other.

Requires Pi 1.4.0 or newer.

## Cost accounting

OpenAI bills the priority service tier above the standard per-token rate. pi-ai
prices each turn at the tier OpenAI reports having billed it at, so a priority
turn's recorded cost already includes the premium and every cost surface that sums
Pi's usage — `/session`, simple-statusline's footer and `/cost` — shows it without
any help from this extension.

Versions before 0.3.0 wrote a `pi-price-tier` entry into the session and read a
`priorityMultiplier` from the state file, which made cost surfaces apply the premium
a second time. Neither exists any more; a `priorityMultiplier` left in the state file
is ignored, and old entries in existing sessions are ignored by simple-statusline.
