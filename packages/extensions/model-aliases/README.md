# model-aliases

Configurable model aliases for Pi: show custom model ids in the selector while routing all model calls to an existing upstream provider/model.

Use this when you want variants such as a 1M model alias, or when Pi should compact against a smaller visible operating window without clamping provider requests to that artificial boundary.

## Why this exists

Pi uses the selected model `provider/id` for UI, context-window metadata, session identity, and provider calls. A plain model override can change context-window metadata, but it cannot make the selector show `gpt-5.5-1m` while the upstream API receives `gpt-5.5`.

This extension makes that split configurable:

- Pi UI / scoped model cycle sees the configured alias model id.
- The alias model routes through a hidden `model-aliases` stream API that delegates every LLM call to the configured `targetProvider` / `targetModel`.
- Normal chat turns, compaction, branch summaries, and other Pi-owned model calls share the same alias routing because the model itself owns the delegation.
- Streamed/session assistant messages are mapped back to the selected alias identity, so session history still records the visible alias.
- Visible context-window metadata can differ from the hard target context window used to clamp delegated provider requests; max-token, cost, input, reasoning, and compatibility metadata can also be inherited or overridden per alias.
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
      "targetContextWindow": 1050000,
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

Additional model variants only require config entries; no extension code change is needed.

### Override an existing model with separate visible and target windows

If `provider/id` already exists, your configured entry wins and sibling models remain available. This is also the safe way to expose an early compaction boundary for a model whose provider accepts a larger hard window:

```json
{
  "aliases": [
    {
      "provider": "openai",
      "id": "gpt-5.6-sol",
      "targetProvider": "openai",
      "targetModel": "gpt-5.6-sol",
      "contextWindow": 372000,
      "targetContextWindow": 1050000,
      "maxTokens": 128000
    }
  ]
}
```

Pi uses `contextWindow` for display and automatic-compaction accounting. The hidden alias stream delegates with `targetContextWindow`, so Pi's provider request clamp still reserves output against the model's real hard capacity. Without this split, an artificially small `contextWindow` can reduce `max_output_tokens` to the provider minimum during a long tool loop before Pi gets a chance to compact.

Because `targetProvider` defaults to `provider` and `targetModel` defaults to `id`, the upstream request still sends the original model id.

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
| `contextWindow` | no | Pi-visible context window used for display and compaction accounting. Defaults to inherited target metadata or `128000`. |
| `targetContextWindow` | no | Hard context window used by the delegated provider request and its output-token clamp. Defaults to `contextWindow`, preserving prior behavior. Set this explicitly when the visible window is an earlier operating/compaction boundary. |
| `maxTokens` | no | Max output metadata. Defaults to inherited target metadata or `16384`. |
| `cost` | no | Cost metadata per million tokens. Defaults to the target model's pricing when pi knows the target; falls back to zeros, which is warned about (see **Pricing**). |
| `compat` | no | Provider compatibility overrides passed through to the target provider. |

## Auth behavior

Aliases under a real provider id, such as `openai/gpt-5.5-1m`, use that provider's normal auth lookup. `/login openai`, `auth.json`'s `openai` entry, and provider-scoped environment settings apply as usual. The alias `apiKey` field is only a fallback when no auth storage entry exists.

Synthetic providers still work for unusual setups, but they have their own provider id and therefore their own auth/cache-retention surface. Prefer same-provider aliases unless you intentionally need a separate auth boundary.

## Troubleshooting

If normal chat appears to work but `/compact` or automatic compaction fails with an upstream `model_not_found` error for the alias id (for example `gpt-5.5-1m`), check that the `model-aliases` extension actually loaded after updating packages. Compaction and branch summaries rely on the hidden `model-aliases` stream API; the compatibility payload rewrite hook is only a fallback for provider call paths that expose Pi's payload hook.

If a deliberately smaller visible window causes repeated `maximum output token limit` stops immediately before compaction, set `targetContextWindow` to the provider's real hard capacity. Do not represent an early compaction boundary by lowering both the visible and target windows.

For Git installs that track `main`, run `pi update --extensions` (or otherwise fast-forward the installed package clone), then `/reload` or restart Pi.

## Pricing

An alias with no `cost` block inherits its target model's pricing, which is the
normal case: point `targetModel` at a model pi already prices and cost accounting
is exact.

When an alias has neither its own `cost` nor a resolvable target, pi still needs
a cost object, so it gets zeros — which means real token spend is reported as
$0. That failure is silent by nature, so this extension warns at load naming
each affected alias, and the `simple-statusline` cost surfaces mark any total
containing unpriced usage with a leading `~` and name the model in `/cost`.

Fix it by adding a `cost` block to the alias or by pointing `targetModel` at a
model in pi's registry.

## Local state

This extension does not read or write local runtime state. It reads Pi settings and registers configured models in memory.
