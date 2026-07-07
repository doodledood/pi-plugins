# model-aliases

Configurable model aliases for Pi: show custom model/provider ids in the selector while sending an existing upstream model id in the provider payload.

Use this when you want variants such as `openai-1m/gpt-5.5-1m` or a future `openai-1m/gpt-5.6-1m` without writing a new extension for each model release.

## Why this exists

Pi currently uses the model `id` as the primary selector/footer label and also sends that `id` as `payload.model` to the provider. A plain model override can change context-window metadata, but it cannot make the selector show `gpt-5.5-1m` while the API receives `gpt-5.5`.

This extension makes that split configurable:

- Pi UI / scoped model cycle sees the configured alias model id.
- The provider request payload is rewritten so `model` is the configured `targetModel`.
- Context-window, max-token, cost, input, reasoning, and compatibility metadata can be inherited from an existing target model and overridden per alias.
- If the configured `provider/id` already exists, the configured entry wins and the provider's other models are preserved.

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
      "provider": "openai-1m",
      "providerName": "OpenAI 1M Context",
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
    "openai-1m/gpt-5.5-1m:xhigh"
  ]
}
```

To add a later GPT-5.6 1M variant, add another alias with `id: "gpt-5.6-1m"`, `targetProvider: "openai"`, and `targetModel: "gpt-5.6"`. No extension code change is needed.

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

That explicit bootstrap lets the checker subprocess register the same alias models and run the same provider payload rewrite, so an inherited selector such as `openai-1m/gpt-5.5-1m` remains available while the upstream API still receives `gpt-5.5`. The checker does not gain model-aliases tools from this integration; it only loads the trusted model/provider bootstrap code needed to execute the inherited model.

## Alias fields

| Field | Required | Description |
|---|---:|---|
| `provider` | yes | Provider id shown by Pi. Use a synthetic provider such as `openai-1m` for a new selector-visible alias, or an existing provider such as `openai` to override an existing model id. |
| `providerName` | no | Display name for the synthetic provider. Defaults to `provider`. |
| `id` | yes | Selector-visible alias model id, for example `gpt-5.5-1m`. |
| `targetProvider` | no | Existing provider to inherit model metadata from. Defaults to `provider`. Legacy key `actualProvider` is also accepted. |
| `targetModel` | no | Upstream model id written into `payload.model`, for example `gpt-5.5`. Defaults to `id`. Legacy keys `actualModelId` and `model` are also accepted. |
| `name` | no | Human-friendly model name. Defaults to `id`. |
| `api` | no | Pi provider API type, such as `openai-responses` or `anthropic-messages`. Required in practice for custom synthetic providers. |
| `baseUrl` | no | Provider base URL. Required in practice for custom synthetic providers. |
| `apiKey` | no | Env interpolation, shell command, or literal key using Pi provider config syntax, e.g. `$OPENAI_API_KEY`. |
| `headers` | no | Extra provider headers. |
| `authHeader` | no | Add `Authorization: Bearer <key>` for non-standard providers. |
| `reasoning` | no | Whether the alias supports Pi thinking levels. Defaults to `false`. |
| `thinkingLevelMap` | no | Per-level provider values / `null` for hidden unsupported levels. |
| `input` | no | `text` or `text,image`. Defaults to `text`. |
| `contextWindow` | no | Context-window metadata. Defaults to `128000`. |
| `maxTokens` | no | Max output metadata. Defaults to `16384`. |
| `cost` | no | Cost metadata per million tokens. Defaults to zeros. |
| `compat` | no | Provider compatibility overrides passed through to Pi. |

## Auth caveat

When `provider/id` clashes with an existing model, the configured entry wins. The extension builds a full provider registration that preserves the provider's other current models, then replaces the clashing model with your configured metadata.

Synthetic providers such as `openai-1m` do not automatically reuse `/login openai` OAuth/subscription credentials. Configure `apiKey` (usually `$OPENAI_API_KEY`) or another provider-specific auth mechanism in settings. Existing-provider overrides such as `openai/gpt-5.5` continue to use that provider's normal auth, with `apiKey` as an optional fallback.

## Local state

This extension does not read or write local runtime state. It reads Pi settings and registers configured models in memory.
