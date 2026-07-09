import test from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redact.ts";

test("redacts openai-style keys anywhere", () => {
  const out = redactSecrets("failed with key sk-abcd1234EFGH5678 in payload");
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /sk-abcd1234/);
});

test("redacts apiKey / token key-value pairs in either quote style", () => {
  assert.match(redactSecrets(`{ apiKey: 'sk-topsecretvalue' }`), /apiKey: '\[REDACTED\]'/);
  assert.match(redactSecrets(`"access_token":"abc123def456"`), /"access_token":"\[REDACTED\]"/);
  assert.match(redactSecrets(`password=hunter2hunter2`), /password=\[REDACTED\]/);
});

test("redacts authorization headers and standalone bearer tokens", () => {
  assert.match(redactSecrets("Authorization: Bearer eyJhbGciOi.payload.sig"), /Authorization: Bearer \[REDACTED\]/);
  assert.match(redactSecrets("sent bearer abcdef123456 upstream"), /bearer \[REDACTED\]/i);
});

test("leaves ordinary prose untouched", () => {
  const prose = "basic validation failed for the tokenizer config";
  assert.equal(redactSecrets(prose), prose);
});
