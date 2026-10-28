---
kind: theme
covers: packages/themes
---
# Themes

The `graphite` and `deep-focus-pi` color themes, each its own installable package.

## How a user reaches it

- `/settings` → theme, or `theme` in `settings.json`.

## Scenarios

### structure
Run: `node scripts/verify-structure.mjs`
Proves: each theme package names a theme file that exists and is listed in the root manifest.
Line: 0.3 s on darwin-arm64-12cpu

## Gotchas

- Nothing here checks how a theme looks; judge colors in a running Pi.
