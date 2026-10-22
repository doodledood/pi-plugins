# skill-argument-hints

Show argument-hint frontmatter as phantom hints for Pi skill commands.

Requires Pi 1.4.0 or later.

Typing `/skill:<name> ` for a skill whose `SKILL.md` frontmatter declares `argument-hint` (or `argumentHint` / `argument_hint`) shows the hint as dim text after the cursor until you type an argument. The value is read with Pi's own frontmatter parser, so every YAML form works, including quoted values with a trailing `# comment` and block scalars (`|`, `|-`, `>`, `>-`, `|+`); line breaks are shown as single spaces. `/skill-hints` lists the skills that declare one.

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
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/skill-argument-hints/extensions/skill-argument-hints.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```
