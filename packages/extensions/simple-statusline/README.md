# simple-statusline

Aviram's ambient custom Pi footer/statusline.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/simple-statusline
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.3.0",
      "extensions": ["packages/extensions/simple-statusline/extensions/simple-statusline.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration and local state

`simple-statusline` does not require its own config file.

It reads `~/.pi/agent/gpt-fast-toggle.json` when present so the footer can show whether the separately installed `gpt-fast-toggle` extension is in priority mode. If that file is absent or invalid, the statusline simply omits the GPT priority indicator.

This is a read-only dependency on local Pi state. Do not commit a live `gpt-fast-toggle.json`; use `packages/extensions/gpt-fast-toggle/config/gpt-fast-toggle.example.json` or `profiles/aviram/configs/gpt-fast-toggle.json` as a safe example.
