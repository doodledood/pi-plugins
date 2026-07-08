import assert from "node:assert/strict";
import { test } from "node:test";

import openaiMaxOutputFloor from "../openai-max-output-floor.ts";

type Handler = (event: { payload: unknown }) => unknown;

function fakePi() {
  const handlers: Handler[] = [];
  return {
    handlers,
    on(event: string, handler: Handler) {
      assert.equal(event, "before_provider_request");
      handlers.push(handler);
    },
  };
}

test("registers a single before_provider_request handler", () => {
  const pi = fakePi();
  openaiMaxOutputFloor(pi);
  assert.equal(pi.handlers.length, 1);
});

test("handler replaces a sub-minimum payload and leaves valid payloads unchanged", () => {
  const pi = fakePi();
  openaiMaxOutputFloor(pi);
  const handler = pi.handlers[0]!;

  const floored = handler({ payload: { model: "gpt-5.5", max_output_tokens: 1 } });
  assert.deepEqual(floored, { model: "gpt-5.5", max_output_tokens: 16 });

  // Returning undefined keeps the payload unchanged per the hook contract.
  assert.equal(handler({ payload: { model: "gpt-5.5", max_output_tokens: 128000 } }), undefined);
  assert.equal(handler({ payload: { model: "claude", max_tokens: 1 } }), undefined);
});

test("handler tolerates a missing payload without throwing", () => {
  const pi = fakePi();
  openaiMaxOutputFloor(pi);
  const handler = pi.handlers[0]!;
  assert.equal(handler({ payload: undefined }), undefined);
  assert.equal(handler({} as { payload: unknown }), undefined);
});
