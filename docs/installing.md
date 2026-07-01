# Installing resources

## Install the root bundle

The root package lists all included resources. Installing it without filters loads every extension and theme declared in `package.json`:

```bash
pi install git:github.com/doodledood/pi-plugins@v0.3.1
```

Use this only when you want the full curated resource set.

## Install one resource from the Git repo

Pi's documented Git source installs the repo package. To load one resource from that repo, use an object-form package entry with filters in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.3.1",
      "extensions": ["packages/extensions/message-stash/extensions/message-stash.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```


Theme example:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@v0.3.1",
      "extensions": [],
      "skills": [],
      "prompts": [],
      "themes": ["packages/themes/deep-focus-pi/themes/deep-focus-pi.json"]
    }
  ]
}
```

Do not rely on undocumented Git subdirectory install syntax.

The examples use the pinned `@v0.3.1` release tag. Use `@main` only when you intentionally want the latest development version.

## Install one local package after cloning

```bash
git clone git@github.com:doodledood/pi-plugins.git
pi install /path/to/pi-plugins/packages/extensions/goal-controller
pi install /path/to/pi-plugins/packages/themes/deep-focus-pi
```
