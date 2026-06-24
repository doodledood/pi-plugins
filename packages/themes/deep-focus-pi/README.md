# deep-focus-pi

Deep focus custom Pi TUI theme.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/themes/deep-focus-pi
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.2.1",
      "extensions": [],
      "skills": [],
      "prompts": [],
      "themes": ["packages/themes/deep-focus-pi/themes/deep-focus-pi.json"]
    }
  ]
}
```

Select it after install:

```json
{ "theme": "deep-focus-pi" }
```
