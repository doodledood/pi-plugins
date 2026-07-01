# skill-argument-hints

Show argument-hint frontmatter as phantom hints for Pi skill commands.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/skill-argument-hints
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.3.0",
      "extensions": ["packages/extensions/skill-argument-hints/extensions/skill-argument-hints.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```
