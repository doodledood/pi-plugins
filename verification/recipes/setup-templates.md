---
kind: setup
covers: setup, docs/aviram-setup.md
---
# Portable setup

The merge-oriented templates under `setup/` that bring a machine to the owner's Pi setup, with
secrets left as placeholders.

## How a user reaches it

- Following `setup/README.md` or `docs/aviram-setup.md` on a new machine.
- The `sync-pi-setup` project skill, which refreshes these templates from a local install.

## Scenarios

### structure
Run: `node scripts/verify-structure.mjs`
Proves: the setup templates name the same extensions and themes as the root manifest, and the
setup agents and skills listed there exist.

## Gotchas

- No scenario applies the templates to a machine; a real install stays a manual check.
