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

test("inspectKeybinding: cmd/meta normalize to super; invalid chords and f13+ fall back with a warning", () => {
  const cmd = loadConfig(tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }], inspectKeybinding: "cmd+p" })));
  assert.equal(cmd.config.inspectKeybinding, "super+p");
  assert.equal(cmd.warning, undefined);

  const superKey = loadConfig(tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }], inspectKeybinding: "super+o" })));
  assert.equal(superKey.config.inspectKeybinding, "super+o");

  const fkey = loadConfig(tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }], inspectKeybinding: "f5" })));
  assert.equal(fkey.config.inspectKeybinding, "f5");

  // pi-tui's matchesKey rejects modified f-keys, f13+, and malformed chords.
  for (const bad of ["ctrl-p", "f13", "ctrl+f1", "CTRL+", 42]) {
    const { config, warning } = loadConfig(tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }], inspectKeybinding: bad })));
    assert.equal(config.inspectKeybinding, "ctrl+p", `expected fallback for ${JSON.stringify(bad)}`);
    assert.match(warning ?? "", /inspectKeybinding/);
  }
});

test("non-integer preselected indexes are rejected with a warning, resetting to all", () => {
  const { config, warning } = loadConfig(
    tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }, { model: "c/d" }], preselected: [0.5] })),
  );
  assert.match(warning ?? "", /preselected/);
  assert.deepEqual(config.preselected, [0, 1]);
});

test("timeout is clamped to sane bounds", () => {
  const low = loadConfig(tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }], timeoutMs: 1 })));
  assert.equal(low.config.timeoutMs, 30_000);
  const high = loadConfig(tempConfig(JSON.stringify({ panelists: [{ model: "a/b" }], timeoutMs: 999_999_999 })));
  assert.equal(high.config.timeoutMs, 3_600_000);
});
