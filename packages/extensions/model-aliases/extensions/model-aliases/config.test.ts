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
      maxTokens: undefined,
      cost: undefined,
      compat: undefined,
    },
  ]);
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
