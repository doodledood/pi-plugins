# message-stash

Single-slot draft stash for Pi input editor with keyboard shortcuts.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/message-stash
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.2.1",
      "extensions": ["packages/extensions/message-stash/extensions/message-stash.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```
