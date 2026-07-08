# ADR: openai-max-output-floor extension

## Status
Accepted

## Context
Regular `openai/gpt-5.5` sessions started failing with a hard provider 400 once
their history grew close to the model's 272k context window:

```
OpenAI API error (400): Invalid 'max_output_tokens': integer below minimum
value. Expected a value >= 16, but got 1 instead.
```

Root cause (investigation log `~/.manifest-dev/logs/figure-out-log-20260708-100813.md`):

- pi-ai caps output tokens against the remaining context window in
  `clampMaxTokensToContext`: `available = contextWindow - estimatedContext - 4096`,
  then `min(model.maxTokens, max(1, available))`. The floor there is **1**.
- Near (or over) the window `available` goes to zero or negative, so the clamp
  legitimately returns `1`, and the openai-responses request builder assigned
  `max_output_tokens = options.maxTokens` verbatim — emitting `max_output_tokens: 1`.
- OpenAI Responses (and Azure OpenAI Responses) reject any value below **16**,
  so the request 400s instead of returning a short or length-capped answer.
- The same session on the `openai-1m/gpt-5.5-1m` alias (contextWindow 1.05M) never
  hit this: the larger declared window leaves ample `available`, so the clamp
  stays far above 16. That asymmetry is why the bug looked provider-specific when
  it was really context-budget-specific.

Upstream already fixed this in pi-ai by flooring `max_output_tokens` to 16 in the
openai-responses and azure-openai-responses request builders
([earendil-works/pi#6265](https://github.com/earendil-works/pi/issues/6265),
commit `2e4ad6a0`). But that commit is **unreleased** — the latest tag (v0.80.3)
predates it, and the installed pi is v0.80.3 — so the running client still emits
`max_output_tokens: 1`. We do not own the upstream repo (no push access; `main`
is protected), and the constraint was: fix it in our own repo only, touching
nothing in the installed pi package.

## Decision
Ship a standalone `openai-max-output-floor` extension that raises
`max_output_tokens` to 16 on the outgoing provider payload via
`before_provider_request`.

- **Own repo, not a node_modules patch.** A dist patch to the installed pi-ai
  works but edits the pi package (violating the "don't change pi" constraint) and
  is wiped by the next `pi update`/reinstall. An extension lives in our repo,
  survives updates, is independently installable, and is superseded harmlessly
  once a pi release containing #6265 lands (both then floor to the same 16).
- **`before_provider_request` seam.** It fires after the provider payload is
  built, right before send, and returning a value replaces the payload. This is
  the same seam `model-aliases` already uses, so the fix applies to the final
  serialized request regardless of model, alias, or provider wiring.
- **Scope by field name, not by model/provider.** Only OpenAI Responses / Azure
  OpenAI Responses payloads carry the snake_case `max_output_tokens` field
  (Completions use `max_completion_tokens`, Anthropic uses `max_tokens`, Google
  uses `maxOutputTokens`). Keying on the field is simpler than model inspection
  and cannot touch other providers.
- **Floor is always safe.** It only ever raises a sub-16 value to 16 and never
  lowers a legitimate budget, so it is a transparent no-op on normal sessions
  (verified: a full-window request still carries `max_output_tokens: 128000`).
- **16 as a named constant.** It is OpenAI's documented minimum; kept overridable
  via a `floor` parameter on the pure helper so tests and any future minimum
  change stay one-liners.

## Alternatives Considered
- **Patch the installed pi-ai dist (node_modules).** Fastest and exactly mirrors
  upstream — rejected as the durable answer: it modifies the pi package the user
  asked to leave untouched and does not survive updates. Used only as a
  throwaway reproduction step, then reverted.
- **Wait for / rely on a pi release with #6265.** Zero code — rejected as the
  sole fix: the error is happening now on v0.80.3 and the release date is not in
  our control. The extension coexists with the eventual release rather than
  blocking on it.
- **Open an upstream PR (e.g. add the missing regression test).** Rejected for
  this task: no push access, `main` is protected, and the maintainer fix is
  already merged; an external PR under the user's identity was explicitly out of
  scope.
- **Raise the global clamp floor (`MIN_MAX_TOKENS`) instead of a per-API floor.**
  Not ours to change, and wrong in general: other provider APIs may accept
  smaller values, so the minimum belongs at the OpenAI Responses boundary, which
  is exactly where this extension applies it.
- **Trigger compaction when the computed budget is below 16.** More "correct"
  long-term (a sub-16 budget means the session is effectively out of room), but
  that is an agent-loop policy decision that belongs in pi core, not a payload
  guardrail. Flooring to 16 keeps the request valid; compaction can still happen
  through pi's normal context-pressure paths.

## Consequences

### Positive
- Regular `openai/gpt-5.5` (and any OpenAI Responses model) no longer 400s near
  the context window; the request goes through with a small output budget instead
  of failing outright.
- Fix lives in our repo, survives `pi update`, and is individually installable.
- Stateless and provider-scoped by construction: no config, no env, no persisted
  state, and impossible to affect non-OpenAI-Responses providers.

### Negative
- It papers over a near-context-limit condition rather than resolving it: a
  request floored to 16 output tokens will usually stop on `length`. That is
  strictly better than a 400, but it is a symptom the user may still want to fix
  by compacting. The README and this ADR name that explicitly.
- Redundant once a pi release includes #6265 (both floor to 16). Harmless overlap;
  the extension can be removed after upgrading if desired.
- Another `before_provider_request` handler in the chain. It only adjusts
  `max_output_tokens`, so it composes with `model-aliases` and `cache-optimization`
  in any order.

## Related
- `docs/adr/20260706-cache-optimization-extension.md` — another
  `before_provider_request` payload-shaping extension in this repo; load-order
  reasoning for payload-rewriting handlers.
- Upstream fix: [earendil-works/pi#6265](https://github.com/earendil-works/pi/issues/6265)
  (`2e4ad6a0`, unreleased as of pi v0.80.3).
- Investigation log: `~/.manifest-dev/logs/figure-out-log-20260708-100813.md`.
