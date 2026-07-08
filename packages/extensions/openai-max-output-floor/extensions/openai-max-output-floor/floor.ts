/**
 * OpenAI Responses (and Azure OpenAI Responses) reject `max_output_tokens`
 * values below 16 with:
 *
 *   Invalid 'max_output_tokens': integer below minimum value.
 *   Expected a value >= 16, but got 1 instead.
 *
 * Pi's context-aware clamp (`clampMaxTokensToContext`) can legitimately compute
 * a value as low as 1 when a session is near the model's context window, and
 * the openai-responses request builder passes that straight through as
 * `max_output_tokens`. That produces a hard 400 instead of a graceful response.
 *
 * This is the provider's documented minimum, so flooring is always safe: we only
 * ever raise a sub-minimum value up to the floor and never lower a legitimate
 * budget. See https://github.com/earendil-works/pi/issues/6265.
 */
export const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/**
 * The `max_output_tokens` field is unique to the OpenAI Responses / Azure OpenAI
 * Responses payloads. Other provider payloads use different fields
 * (`max_tokens`, `max_completion_tokens`, `maxOutputTokens`), so keying on this
 * snake_case field scopes the fix to the affected APIs without inspecting the
 * model or provider.
 *
 * Returns a new payload object with the floored value when a change is needed,
 * or `undefined` to leave the payload untouched. This matches the
 * `before_provider_request` contract: returning `undefined` keeps the payload
 * as-is; returning a value replaces it.
 */
export function floorMaxOutputTokens(
  payload: unknown,
  floor: number = OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;

  const record = payload as Record<string, unknown>;
  const current = record.max_output_tokens;

  if (typeof current !== "number" || !Number.isFinite(current)) return undefined;
  if (current >= floor) return undefined;

  return { ...record, max_output_tokens: floor };
}
