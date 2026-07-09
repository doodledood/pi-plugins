# model-aliases

Configurable model aliases for Pi: show custom model ids in the selector while routing all model calls to an existing upstream provider/model.

Use this when you want variants such as `openai/gpt-5.5-1m` or a future `openai/gpt-5.6-1m` without writing a new extension for each model release.

## Why this exists

Pi uses the selected model `provider/id` for UI, context-window metadata, session identity, and provider calls. A plain model override can change context-window metadata, but it cannot make the selector show `gpt-5.5-1m` while the upstream API receives `gpt-5.5`.

This extension makes that split configurable:

- Pi UI / scoped model cycle sees the configured alias model id.
- The alias model routes through a hidden `model-aliases` stream API that delegates every LLM call to the configured `targetProvider` / `targetModel`.
- Normal chat turns, compaction, branch summaries, and other Pi-owned model calls share the same alias routing because the model itself owns the delegation.
- Streamed/session assistant messages are mapped back to the selected alias identity, so session history still records the visible alias.
- Context-window, max-token, cost, input, reasoning, and compatibility metadata can be inherited from an existing target model and overridden per alias.
- If the configured `provider/id` already exists, the configured entry wins and the provider's other models are preserved.

A `before_provider_request` payload rewrite is still registered as a compatibility fallback for call paths that expose Pi's payload hook, but alias routing does not depend on that hook.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/model-aliases
```

From npm, once published:

```bash
pi install npm:@doodledood/pi-model-aliases
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/model-aliases/extensions/model-aliases/index.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Configuration

Aliases are configured in `model-aliases.json`. The extension reads config files in normal priority order:

1. `~/.pi/agent/model-aliases.json`
2. `$PI_AGENT_HOME/model-aliases.json`, when set
3. `<cwd>/.pi/model-aliases.json`

Higher-priority files override lower-priority fields. After editing config, run `/reload` or restart Pi.

### GPT-5.5 1M example

`~/.pi/agent/model-aliases.json`:

```json
{
  "enabled": true,
  "aliases": [
    {
      "provider": "openai",
      "id": "gpt-5.5-1m",
      "name": "GPT-5.5 1M",
      "targetProvider": "openai",
      "targetModel": "gpt-5.5",
      "apiKey": "$OPENAI_API_KEY",
      "contextWindow": 1050000,
      "maxTokens": 128000
    }
  ]
}
```

Then include the alias in `~/.pi/agent/settings.json` if you want it in the scoped model cycle:

```json
{
  "enabledModels": [
    "openai/gpt-5.5:xhigh",
    "openai/gpt-5.5-1m:xhigh"
  ]
}
```

To add a later GPT-5.6 1M variant, add another alias with `provider: "openai"`, `id: "gpt-5.6-1m"`, `targetProvider: "openai"`, and `targetModel: "gpt-5.6"`. No extension code change is needed.

### Override an existing model in place

If `provider/id` already exists, your configured entry wins and sibling models remain available. For example, this keeps the selector label as `openai/gpt-5.5` but overrides its context-window metadata:

```json
{
  "aliases": [
    {
      "provider": "openai",
      "id": "gpt-5.5",
      "contextWindow": 1050000
    }
  ]
}
```

Because `targetProvider` defaults to `provider` and `targetModel` defaults to `id`, the upstream request still sends `model: "gpt-5.5"`.

See `config/model-aliases.example.json` for a fuller example.

## goal-controller checker integration

When `@doodledood/pi-goal-controller` is installed too, no extra config is needed for goal checkers to inherit aliased models. `model-aliases` advertises its dedicated no-tools checker bootstrap entrypoint over Pi's shared extension event bus; `goal-controller` validates the package/path against its trusted model-bootstrap list, then launches its checker subprocess with normal extension discovery disabled plus an explicit `-e <model-aliases checker-bootstrap.ts>` model-bootstrap exception.

That explicit bootstrap lets the checker subprocess register the same alias models and hidden alias stream API, so an inherited selector such as `openai/gpt-5.5-1m` remains available while the upstream API still receives `gpt-5.5`. The checker does not gain model-aliases tools from this integration; it only loads the trusted model/provider bootstrap code needed to execute the inherited model.

## Alias fields

| Field | Required | Description |
|---|---:|---|
| `provider` | yes | Provider id shown by Pi. Prefer the real provider, such as `openai`, so aliases reuse the normal provider auth/login surface. |
| `providerName` | no | Optional display name for non-standard/synthetic provider ids. Normally omit this when `provider` is a built-in provider such as `openai`. |
| `id` | yes | Selector-visible alias model id, for example `gpt-5.5-1m`. |
| `targetProvider` | no | Existing provider to inherit model metadata from and route upstream calls to. Defaults to `provider`. Legacy key `actualProvider` is also accepted. |
| `targetModel` | no | Upstream model id sent to the target provider, for example `gpt-5.5`. Defaults to `id`. Legacy keys `actualModelId` and `model` are also accepted. |
| `name` | no | Human-friendly model name. Defaults to `id`. |
| `api` | no | Target Pi provider API type, such as `openai-responses` or `anthropic-messages`, when it cannot be inherited from `targetProvider` / `targetModel`. |
| `baseUrl` | no | Target provider base URL when it cannot be inherited. |
| `apiKey` | no | Env interpolation, shell command, or literal key using Pi provider config syntax, e.g. `$OPENAI_API_KEY`. This is a fallback; normal auth storage for `provider` wins first. |
| `headers` | no | Extra provider/model headers. |
| `authHeader` | no | Add `Authorization: Bearer <key>` for non-standard providers. |
| `reasoning` | no | Whether the alias supports Pi thinking levels. Defaults to inherited target metadata or `false`. |
| `thinkingLevelMap` | no | Per-level provider values / `null` for hidden unsupported levels. |
| `input` | no | `text` or `text,image`. Defaults to inherited target metadata or `text`. |
| `contextWindow` | no | Context-window metadata. Defaults to inherited target metadata or `128000`. |
| `maxTokens` | no | Max output metadata. Defaults to inherited target metadata or `16384`. |
| `cost` | no | Cost metadata per million tokens. Defaults to inherited target metadata or zeros. |
| `compat` | no | Provider compatibility overrides passed through to the target provider. |

## Auth behavior

Aliases under a real provider id, such as `openai/gpt-5.5-1m`, use that provider's normal auth lookup. `/login openai`, `auth.json`'s `openai` entry, and provider-scoped environment settings apply as usual. The alias `apiKey` field is only a fallback when no auth storage entry exists.

Synthetic providers still work for unusual setups, but they have their own provider id and therefore their own auth/cache-retention surface. Prefer same-provider aliases unless you intentionally need a separate auth boundary.

## Troubleshooting

If normal chat appears to work but `/compact` or automatic compaction fails with an upstream `model_not_found` error for the alias id (for example `gpt-5.5-1m`), check that the `model-aliases` extension actually loaded after updating packages. Compaction and branch summaries rely on the hidden `model-aliases` stream API; the compatibility payload rewrite hook is only a fallback for provider call paths that expose Pi's payload hook.

For Git installs that track `main`, run `pi update --extensions` (or otherwise fast-forward the installed package clone), then `/reload` or restart Pi.

## Local state

This extension does not read or write local runtime state. It reads Pi settings and registers configured models in memory.
