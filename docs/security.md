# Security

Pi extensions execute with the local user's permissions, and skills can instruct the model to take actions. Review any package before installing it.

This repo intentionally excludes live local state:

- `auth.json`, OAuth state, tokens, cookies, and API keys
- Pi sessions, caches, logs, package caches, and cloned package repos
- live MCP config files containing credential-bearing URLs
- generated `node_modules` directories

Profile files under `profiles/` are examples/templates. Copy and edit them locally; do not commit filled-in secrets.
