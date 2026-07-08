# openai-max-output-floor

Guardrail extension that floors `max_output_tokens` to the OpenAI Responses
provider minimum (**16**) on every outgoing provider payload.

## Why

OpenAI Responses and Azure OpenAI Responses reject `max_output_tokens` below 16:

```
OpenAI API error (400): Invalid 'max_output_tokens': integer below minimum
value. Expected a value >= 16, but got 1 instead.
```

Pi caps output tokens against the remaining context window
(`clampMaxTokensToContext`), flooring at 1. Near the context window that clamp
can legitimately produce `1`, and the openai-responses request builder passes it
straight through as `max_output_tokens: 1` — a hard 400 instead of a graceful
(short or length-capped) response. This is most visible on a regular
`openai/gpt-5.5` session whose history has grown close to the 272k window; a
large-context alias (e.g. a 1M-context variant) leaves enough headroom to avoid
it. Upstream fixed this in pi-ai
([earendil-works/pi#6265](https://github.com/earendil-works/pi/issues/6265)),
but the fix is unreleased; this extension applies the same floor from your own
config so you are covered on the current release and after it ships.

## How

Registers a `before_provider_request` handler that inspects the final serialized
payload. When `max_output_tokens` is a finite number below the floor, it returns
a copy with the value raised to 16; otherwise it returns nothing and the payload
is sent unchanged.

Flooring is always safe — it only ever raises a sub-minimum value and never
lowers a legitimate budget. The fix is scoped by field name: only OpenAI
Responses / Azure OpenAI Responses payloads carry the snake_case
`max_output_tokens` field, so Anthropic (`max_tokens`), OpenAI Completions
(`max_completion_tokens`), and Google (`maxOutputTokens`) payloads are never
touched, without inspecting the model or provider.

Load-order note: the handler keys on the outgoing payload, so it composes with
other payload-rewriting extensions (e.g. `model-aliases`) in any order — it only
adjusts `max_output_tokens` and leaves every other field intact.

## Install

From a local clone:

```bash
pi install /path/to/pi-plugins/packages/extensions/openai-max-output-floor
```

From the Git repo with a package filter, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/doodledood/pi-plugins@main",
      "extensions": ["packages/extensions/openai-max-output-floor/extensions/openai-max-output-floor.ts"],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

## Design rationale

For the full decision record — why an extension instead of a node_modules patch
or waiting for the upstream release, why the `before_provider_request` seam, why
scope by field name, and the alternatives weighed — see
[`docs/adr/20260708-openai-max-output-floor-extension.md`](../../../docs/adr/20260708-openai-max-output-floor-extension.md).

## Configuration, environment, and local state

No config file, no environment variables, no persisted state. The floor is the
provider's fixed minimum (16). Behavior is stateless: each request is evaluated
independently and nothing is written to disk or injected into LLM context.
