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
      "source": "git:github.com/doodledood/pi-plugins@v0.1.0",
      "extensions": ["packages/extensions/gpt-fast-toggle/extensions/gpt-fast-toggle.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration

See `config/` for safe example config and `profiles/aviram/configs/` for Aviram's current non-secret defaults.
