import assert from "node:assert/strict";
import { consult } from "./index.ts";
import { defaultConfig } from "./config.ts";
import type { AdvisorResult } from "./types.ts";

const fakeAdvice: AdvisorResult = { ok: true, advice: "Smoke advice: proceed, but add a rollback.", model: "anthropic/claude-fable-5-1", elapsedMs: 1234 };

const out = await consult(
  { query: "Smoke brief: are we clear to proceed with the change?" },
  {
    runner: { run: async () => fakeAdvice },
    config: defaultConfig(),
    cwd: process.cwd(),
    parentModelPattern: "openai/gpt-5.5",
    bootstrapExtensionPath: "/abs/child-bootstrap.ts",
  },
);

assert.equal(out.details.ok, true);
assert.match(out.text, /Smoke advice/);

const empty = await consult(
  { query: "   " },
  {
    runner: { run: async () => fakeAdvice },
    config: defaultConfig(),
    cwd: process.cwd(),
    bootstrapExtensionPath: "/abs/child-bootstrap.ts",
  },
);
assert.equal(empty.details.ok, false);

console.log("advisor-consult smoke PASS");
