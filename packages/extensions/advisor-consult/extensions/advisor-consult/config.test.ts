import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clampTimeout, DEFAULT_CONFIG, loadConfig } from "./config.ts";

function tmpConfig(name = "advisor-consult.json"): string {
  return join(mkdtempSync(join(tmpdir(), "advisor-consult-config-")), name);
}

test("loadConfig uses defaults when the file is absent", () => {
  const loaded = loadConfig(tmpConfig("missing.json"));
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.equal(loaded.warning, undefined);
});

test("loadConfig merges valid overrides", () => {
  const path = tmpConfig();
  writeFileSync(
    path,
    JSON.stringify({
      defaultModel: "anthropic/claude-fable-5-1",
      defaultThinking: "high",
      defaultTimeoutMs: 120000,
      minTimeoutMs: 10000,
      maxTimeoutMs: 900000,
      excludedTools: ["goal", "subagent"],
    }),
  );
  const loaded = loadConfig(path);
  assert.equal(loaded.warning, undefined);
  assert.equal(loaded.config.defaultModel, "anthropic/claude-fable-5-1");
  assert.equal(loaded.config.defaultThinking, "high");
  assert.equal(loaded.config.defaultTimeoutMs, 120000);
  assert.deepEqual(loaded.config.excludedTools, ["goal", "subagent"]);
});

test("loadConfig falls back safely on invalid JSON", () => {
  const path = tmpConfig();
  writeFileSync(path, "not json");
  const loaded = loadConfig(path);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.match(loaded.warning ?? "", /could not be read/i);
});

test("loadConfig warns and ignores invalid field values", () => {
  const path = tmpConfig();
  writeFileSync(path, JSON.stringify({ defaultTimeoutMs: -1, defaultThinking: "turbo", excludedTools: "goal" }));
  const loaded = loadConfig(path);
  assert.equal(loaded.config.defaultTimeoutMs, DEFAULT_CONFIG.defaultTimeoutMs);
  assert.equal(loaded.config.defaultThinking, DEFAULT_CONFIG.defaultThinking);
  assert.deepEqual(loaded.config.excludedTools, DEFAULT_CONFIG.excludedTools);
  assert.match(loaded.warning ?? "", /defaultTimeoutMs/);
});

test("loadConfig resets swapped timeout bounds and warns", () => {
  const path = tmpConfig();
  writeFileSync(path, JSON.stringify({ minTimeoutMs: 900000, maxTimeoutMs: 1000 }));
  const loaded = loadConfig(path);
  assert.equal(loaded.config.minTimeoutMs, DEFAULT_CONFIG.minTimeoutMs);
  assert.equal(loaded.config.maxTimeoutMs, DEFAULT_CONFIG.maxTimeoutMs);
  assert.match(loaded.warning ?? "", /min exceeds max/i);
});

test("loadConfig clamps default timeout into bounds and warns", () => {
  const path = tmpConfig();
  writeFileSync(path, JSON.stringify({ minTimeoutMs: 10000, maxTimeoutMs: 20000, defaultTimeoutMs: 900000 }));
  const loaded = loadConfig(path);
  assert.equal(loaded.config.defaultTimeoutMs, 20000);
  assert.match(loaded.warning ?? "", /clamped/i);
});

test("loadConfig falls back when JSON is valid but not an object", () => {
  const path = tmpConfig();
  writeFileSync(path, "[]");
  const loaded = loadConfig(path);
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  assert.match(loaded.warning ?? "", /not a JSON object/i);
});

test("loadConfig keeps valid excludedTools entries and warns on invalid ones", () => {
  const path = tmpConfig();
  writeFileSync(path, JSON.stringify({ excludedTools: ["goal", 42, "subagent"] }));
  const loaded = loadConfig(path);
  assert.deepEqual(loaded.config.excludedTools, ["goal", "subagent"]);
  assert.match(loaded.warning ?? "", /excludedTools/);
});

test("loadConfig warns on unsupported fields", () => {
  const path = tmpConfig();
  writeFileSync(path, JSON.stringify({ mode: "fast" }));
  const loaded = loadConfig(path);
  assert.match(loaded.warning ?? "", /mode \(unsupported\)/);
});

test("clampTimeout keeps values within configured bounds", () => {
  assert.equal(clampTimeout(5_000, DEFAULT_CONFIG), DEFAULT_CONFIG.minTimeoutMs);
  assert.equal(clampTimeout(10_000_000, DEFAULT_CONFIG), DEFAULT_CONFIG.maxTimeoutMs);
  assert.equal(clampTimeout(300_000, DEFAULT_CONFIG), 300_000);
});
