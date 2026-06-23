# Installing resources

## Install the root bundle

The root package lists all included resources. Installing it without filters loads every extension, skill, and theme declared in `package.json`:

```bash
pi install git:github.com/doodledood/pi-plugins@main
```

Use this only when you want the full curated resource set.

## Install one resource from the Git repo

Pi's documented Git source installs the repo package. To load one resource from that repo, use an object-form package entry with filters in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
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
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": [],
      "skills": [],
      "prompts": [],
      "themes": ["packages/themes/deep-focus-pi/themes/deep-focus-pi.json"]
    }
  ]
}
```

Do not rely on undocumented Git subdirectory install syntax.

The examples use `@main` because this repository has not cut a release tag yet. After a release, prefer a pinned tag such as `@v0.1.0`.

## Install one local package after cloning

```bash
git clone git@github.com:doodledood/pi-plugins.git
pi install /path/to/pi-plugins/packages/extensions/goal-controller
pi install /path/to/pi-plugins/packages/themes/deep-focus-pi
```

## Future npm install shape

Each extension/theme package is named for future publishing, for example:

```bash
pi install npm:@doodledood/pi-goal-controller
pi install npm:@doodledood/pi-theme-deep-focus-pi
```

Publishing is not part of the initial setup.
