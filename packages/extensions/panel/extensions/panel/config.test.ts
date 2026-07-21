import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_INSPECT_KEYBINDING, DEFAULT_PANELISTS, loadConfig } from "./config.ts";

function tempConfig(content?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "panel-config-"));
  const path = join(dir, "panel.json");
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

test("missing config falls back to the default lineup, fully preselected", () => {
  const { config, warning } = loadConfig(tempConfig());
  assert.equal(warning, undefined);
  assert.deepEqual(config.panelists, DEFAULT_PANELISTS);
  assert.deepEqual(config.preselected, [0, 1]);
  assert.equal(config.panelists[0]?.model, "anthropic/claude-fable-5");
  assert.equal(config.panelists[0]?.thinking, "xhigh");
  assert.equal(config.panelists[1]?.model, "openai/gpt-5.6-sol");
  assert.equal(config.panelists[1]?.thinking, "xhigh");
  assert.equal(config.inspectKeybinding, DEFAULT_INSPECT_KEYBINDING);
});

test("unreadable JSON degrades to defaults with a warning", () => {
  const { config, warning } = loadConfig(tempConfig("{not json"));
  assert.match(warning ?? "", /could not be read/);
  assert.deepEqual(config.panelists, DEFAULT_PANELISTS);
});

test("empty lineup in an existing config falls back to the default lineup", () => {
  const { config } = loadConfig(tempConfig(JSON.stringify({ panelists: [] })));
  assert.deepEqual(config.panelists, DEFAULT_PANELISTS);
  assert.deepEqual(config.preselected, [0, 1]);
});

test("valid config lineup, preselection, keybinding, and timeout are honored", () => {
  const path = tempConfig(
    JSON.stringify({
      panelists: [
        { model: "anthropic/claude-fable-5", thinking: "high" },
        { model: "openai/gpt-5.6-sol", thinking: "xhigh" },
        { model: "google/gemini-3-pro", thinking: "medium" },
      ],
      preselected: [0, 2],
      inspectKeybinding: "ctrl+o",
      timeoutMs: 120000,
    }),
  );
  const { config, warning } = loadConfig(path);
  assert.equal(warning, undefined);
  assert.equal(config.panelists.length, 3);
  assert.deepEqual(config.preselected, [0, 2]);
  assert.equal(config.inspectKeybinding, "ctrl+o");
  assert.equal(config.timeoutMs, 120000);
});

test("invalid values are ignored with a warning, valid parts kept", () => {
  const path = tempConfig(
    JSON.stringify({
      panelists: [{ model: "a/b", thinking: "bogus" }, { notAModel: true }],
      preselected: [7],
      timeoutMs: "soon",
    }),
  );
  const { config, warning } = loadConfig(path);
  assert.match(warning ?? "", /invalid/);
  assert.equal(config.panelists.length, 1);
  assert.equal(config.panelists[0]?.thinking, "high"); // invalid level defaults
  assert.deepEqual(config.preselected, [0]); // out-of-range preselect resets to all
});

test("timeout is clamped to sane bounds", () => {
  const low = loadConfig(tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }], timeoutMs: 1 })));
  assert.equal(low.config.timeoutMs, 30_000);
  const high = loadConfig(tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }], timeoutMs: 999_999_999 })));
  assert.equal(high.config.timeoutMs, 3_600_000);
});
