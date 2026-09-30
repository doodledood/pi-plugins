#!/usr/bin/env bash
set -euo pipefail

# Keep upstream skill content upstream; this list records the selected setup.
exec npx --yes skills add emilkowalski/skill \
  --global --agent claude-code codex pi --yes \
  --skill \
  emil-design-eng \
  animate \
  review-animations \
  improve-animations \
  find-animation-opportunities \
  prototype \
  animation-vocabulary \
  apple-design \
  pick-ui-library \
  mobile-native
