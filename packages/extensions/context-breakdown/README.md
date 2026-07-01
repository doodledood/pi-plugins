# context-breakdown

Claude-Code-style /context command for Pi showing context-window usage by category.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/context-breakdown
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.3.1",
      "extensions": ["packages/extensions/context-breakdown/extensions/context-breakdown.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration and local state

`context-breakdown` works without package-specific config.

It reads Pi settings to display the effective context reserve:

- `~/.pi/agent/settings.json`
- `<current-project>/.pi/settings.json`

For Anthropic models, it can call Anthropic's `count_tokens` API for exact token accounting. Set these environment variables locally when you want exact counts:

- `ANTHROPIC_API_KEY` — required for exact Anthropic token counts.
- `ANTHROPIC_BASE_URL` — optional; defaults to `https://api.anthropic.com`.

When the active model is not Anthropic, or when `ANTHROPIC_API_KEY` is absent, the extension falls back to an estimated breakdown and labels it as estimated. Do not commit API keys in repo/profile files.
