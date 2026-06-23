import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";

test("loadConfig uses defaults when config file is absent", () => {
  const path = join(mkdtempSync(join(tmpdir(), "goal-controller-config-")), "missing.json");
  const loaded = loadConfig(path);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.equal(loaded.warning, undefined);
});

test("loadConfig merges valid user overrides", () => {
  const path = join(mkdtempSync(join(tmpdir(), "goal-controller-config-")), "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      defaultTokenBudget: 1234,
      defaultTurnBudget: 9,
      defaultTimeBudgetSeconds: 456,
      checker: { model: "openai/gpt-5.5", toolMode: "transcript", thinking: "xhigh", timeoutMs: 77_000 },
      continuation: { suppressAfterNoToolContinuation: false, transcriptMaxChars: 42_000, checkerHistoryLimit: 3 },
    }),
  );
  const loaded = loadConfig(path);
  assert.equal(loaded.config.defaultTokenBudget, 1234);
  assert.equal(loaded.config.defaultTurnBudget, 9);
  assert.equal(loaded.config.defaultTimeBudgetSeconds, 456);
  assert.equal(loaded.config.checker.model, "openai/gpt-5.5");
  assert.equal(loaded.config.checker.toolMode, "transcript");
  assert.equal(loaded.config.checker.thinking, "xhigh");
  assert.equal(loaded.config.checker.timeoutMs, 77_000);
  assert.equal(loaded.config.continuation.suppressAfterNoToolContinuation, false);
  assert.equal(loaded.config.continuation.transcriptMaxChars, 42_000);
  assert.equal(loaded.config.continuation.checkerHistoryLimit, 3);
});

test("loadConfig falls back safely on invalid JSON", () => {
  const path = join(mkdtempSync(join(tmpdir(), "goal-controller-config-")), "config.json");
  writeFileSync(path, "not json");
  const loaded = loadConfig(path);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.match(loaded.warning ?? "", /could not be read/iu);
});

test("loadConfig warns and ignores invalid field values", () => {
  const path = join(mkdtempSync(join(tmpdir(), "goal-controller-config-")), "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      defaultTokenBudget: -1,
      checker: { model: "", toolMode: "reckless", thinking: "turbo", timeoutMs: 0 },
      continuation: { suppressAfterNoToolContinuation: "yes", transcriptMaxChars: -10, checkerHistoryLimit: 0 },
    }),
  );
  const loaded = loadConfig(path);
  assert.match(loaded.warning ?? "", /defaultTokenBudget/iu);
  assert.match(loaded.warning ?? "", /checker\.model/iu);
  assert.match(loaded.warning ?? "", /checker\.toolMode/iu);
  assert.match(loaded.warning ?? "", /continuation\.transcriptMaxChars/iu);
  assert.equal(loaded.config.defaultTokenBudget, DEFAULT_CONFIG.defaultTokenBudget);
  assert.equal(loaded.config.checker.model, DEFAULT_CONFIG.checker.model);
  assert.equal(loaded.config.checker.toolMode, DEFAULT_CONFIG.checker.toolMode);
  assert.equal(loaded.config.checker.thinking, DEFAULT_CONFIG.checker.thinking);
  assert.equal(loaded.config.checker.timeoutMs, DEFAULT_CONFIG.checker.timeoutMs);
  assert.equal(loaded.config.continuation.suppressAfterNoToolContinuation, DEFAULT_CONFIG.continuation.suppressAfterNoToolContinuation);
  assert.equal(loaded.config.continuation.transcriptMaxChars, DEFAULT_CONFIG.continuation.transcriptMaxChars);
  assert.equal(loaded.config.continuation.checkerHistoryLimit, DEFAULT_CONFIG.continuation.checkerHistoryLimit);
});
