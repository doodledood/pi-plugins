import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { loadConfig, normalizeConfig } from "./config.ts";

test("normalizeConfig accepts a minimal alias without forcing model defaults before inheritance", () => {
  const config = normalizeConfig({
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.5-1m",
      },
    ],
  });

  assert.equal(config.enabled, true);
  assert.deepEqual(config.aliases, [
    {
      provider: "openai",
      providerName: undefined,
      id: "gpt-5.5-1m",
      targetProvider: "openai",
      targetModel: "gpt-5.5-1m",
      name: undefined,
      api: undefined,
      baseUrl: undefined,
      apiKey: undefined,
      headers: undefined,
      authHeader: undefined,
      reasoning: undefined,
      thinkingLevelMap: undefined,
      input: undefined,
      contextWindow: undefined,
      targetContextWindow: undefined,
      maxTokens: undefined,
      cost: undefined,
      compat: undefined,
    },
  ]);
});

test("normalizeConfig accepts distinct visible and target context windows", () => {
  const config = normalizeConfig({
    aliases: [
      {
        provider: "openai",
        id: "gpt-5.6-sol",
        contextWindow: 372000,
        targetContextWindow: 1050000,
      },
    ],
  });

  assert.equal(config.aliases[0]?.contextWindow, 372000);
  assert.equal(config.aliases[0]?.targetContextWindow, 1050000);
});

test("normalizeConfig drops invalid aliases and honors enabled:false", () => {
  const config = normalizeConfig({
    enabled: false,
    aliases: [
      { provider: "ok-default", id: "alias" },
      { provider: "ok", id: "alias", actualProvider: "real-provider", actualModelId: "real-model" },
    ],
  });

  assert.equal(config.enabled, false);
  assert.equal(config.aliases.length, 2);
  assert.equal(config.aliases[0]?.targetProvider, "ok-default");
  assert.equal(config.aliases[0]?.targetModel, "alias");
  assert.equal(config.aliases[1]?.targetProvider, "real-provider");
  assert.equal(config.aliases[1]?.targetModel, "real-model");
});

test("loadConfig merges model-aliases config files from low to high priority", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-model-aliases-"));
  const globalPath = join(dir, "global-model-aliases.json");
  const projectPath = join(dir, "project-model-aliases.json");
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    globalPath,
    `${JSON.stringify({
      enabled: false,
      aliases: [{ provider: "global", id: "global-alias", targetModel: "global-real" }],
    })}\n`,
  );
  writeFileSync(
    projectPath,
    `${JSON.stringify({
      enabled: true,
      aliases: [{ provider: "project", id: "project-alias", targetModel: "project-real" }],
    })}\n`,
  );

  const config = loadConfig([globalPath, projectPath]);

  assert.equal(config.enabled, true);
  assert.equal(config.aliases.length, 1);
  assert.equal(config.aliases[0]?.provider, "project");
  assert.equal(config.aliases[0]?.targetModel, "project-real");
});

// Pi resolves every registered provider/model header through its config-value
// resolver, which throws `TypeError: Cannot read properties of null (reading
// 'startsWith')` on a null value. Keeping a null out of the normalized config is
// what stops that unattributable crash at provider composition.
test("normalizeConfig keeps only string header values and names what it dropped", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  try {
    const config = normalizeConfig({
      aliases: [
        {
          provider: "openai",
          id: "aliased",
          targetModel: "real",
          headers: { "X-Keep": "value", "X-Drop": null, "X-Also-Drop": 42 },
        },
      ],
    });

    assert.deepEqual(config.aliases[0]?.headers, { "X-Keep": "value" });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /X-Drop/u);
  assert.match(warnings[0] ?? "", /X-Also-Drop/u);
});

test("normalizeConfig leaves headers undefined when every value is dropped", () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const config = normalizeConfig({
      aliases: [{ provider: "openai", id: "aliased", targetModel: "real", headers: { "X-Drop": null } }],
    });
    assert.equal(config.aliases[0]?.headers, undefined);
  } finally {
    console.warn = originalWarn;
  }
});
