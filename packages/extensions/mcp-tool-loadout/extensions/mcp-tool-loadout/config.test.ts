import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadConfig, DEFAULTS } from "./config.ts";
import { tmpDir, writeJson, writeRaw } from "./testutil.ts";

test("missing file -> full defaults", () => {
  const cfg = loadConfig(join(tmpDir(), "nope.json"));
  assert.equal(cfg.enabled, DEFAULTS.enabled);
  assert.equal(cfg.budgetTokens, 10_000);
  assert.equal(cfg.halfLifeDays, 14);
  assert.deepEqual(cfg.prior, {});
});

test("partial file -> defaults merged with overrides, neutral default prior preserved", () => {
  const p = join(tmpDir(), "c.json");
  writeJson(p, { budgetTokens: 5000 });
  const cfg = loadConfig(p);
  assert.equal(cfg.budgetTokens, 5000);
  assert.equal(cfg.halfLifeDays, 14);
  assert.deepEqual(cfg.prior, {});
});

test("malformed JSON -> defaults (no throw)", () => {
  const p = join(tmpDir(), "bad.json");
  writeRaw(p, "{ not valid json");
  const cfg = loadConfig(p);
  assert.equal(cfg.budgetTokens, 10_000);
  assert.equal(cfg.enabled, true);
});

test("enabled:false is honored", () => {
  const p = join(tmpDir(), "off.json");
  writeJson(p, { enabled: false });
  assert.equal(loadConfig(p).enabled, false);
});

test("prior override replaces default prior", () => {
  const p = join(tmpDir(), "prior.json");
  writeJson(p, { prior: { foo: 5 } });
  const cfg = loadConfig(p);
  assert.equal(cfg.prior.foo, 5);
  assert.equal(cfg.prior.alpha_mcp, undefined);
});

test("invalid budget/halfLife fall back to defaults", () => {
  const p = join(tmpDir(), "inv.json");
  writeJson(p, { budgetTokens: -1, halfLifeDays: 0 });
  const cfg = loadConfig(p);
  assert.equal(cfg.budgetTokens, 10_000);
  assert.equal(cfg.halfLifeDays, 14);
});

test("minProjectEvents: default, override, and invalid fallback", () => {
  assert.equal(loadConfig(join(tmpDir(), "none.json")).minProjectEvents, 5);
  const p = join(tmpDir(), "mpe.json");
  writeJson(p, { minProjectEvents: 2 });
  assert.equal(loadConfig(p).minProjectEvents, 2);
  const bad = join(tmpDir(), "mpe-bad.json");
  writeJson(bad, { minProjectEvents: -3 });
  assert.equal(loadConfig(bad).minProjectEvents, 5);
});
