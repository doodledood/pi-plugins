import { floorMaxOutputTokens } from "./openai-max-output-floor/floor.ts";

/**
 * Floors `max_output_tokens` to the OpenAI Responses provider minimum (16) on
 * outgoing provider payloads, preventing hard 400s when Pi's context-aware
 * clamp computes a sub-minimum value near the context window.
 *
 * Registered as a `before_provider_request` handler so it applies to the final
 * serialized payload regardless of model, alias, or provider wiring. Only
 * OpenAI Responses / Azure OpenAI Responses payloads carry `max_output_tokens`,
 * so other providers are untouched.
 */
export default function openaiMaxOutputFloor(pi: {
  on: (event: "before_provider_request", handler: (event: { payload: unknown }) => unknown) => void;
}): void {
  pi.on("before_provider_request", (event) => floorMaxOutputTokens(event?.payload));
}
