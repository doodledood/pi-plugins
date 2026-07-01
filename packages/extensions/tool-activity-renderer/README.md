# tool-activity-renderer

Compact custom rendering wrappers for Pi built-in file and shell tools.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/tool-activity-renderer
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.3.0",
      "extensions": ["packages/extensions/tool-activity-renderer/extensions/tool-activity-renderer.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration

See `config/` for safe example config and `profiles/aviram/configs/` for Aviram's current non-secret defaults.
