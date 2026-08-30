import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateLocalSettings } from "./verify-structure-helpers.mjs";

const root = process.cwd();
const errors = [];
const expectedExtensions = ["advisor-consult", "btw", "cache-optimization", "goal-controller", "hq", "mcp-tool-loadout", "context-breakdown", "gpt-fast-toggle", "model-aliases", "message-stash", "openai-max-output-floor", "openai-tts", "panel", "simple-statusline", "skill-argument-hints", "tool-activity-renderer"];
const directoryEntryExtensions = new Set(["advisor-consult", "btw", "goal-controller", "hq", "mcp-tool-loadout", "model-aliases", "openai-tts", "panel"]);
const packageRootEntryExtensions = new Set(["btw"]);
const expectedSkills = ["sync-pi-setup"];
const expectedThemes = ["deep-focus-pi"];
const expectedSetupAgents = ["Explore"];
const expectedSetupSkills = ["deletion-pass"];
const expectedEnabledModels = [
  "openai/gpt-5.6-sol:high",
  "anthropic/claude-opus-5:high",
  "anthropic/claude-opus-5-full:high",
  "openai/gpt-5.6-luna:max",
  "anthropic/claude-fable-5:high",
  "anthropic/claude-fable-5-full:high",
];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { errors.push(`${path}: invalid JSON (${error.message})`); return undefined; }
}
function mustExist(path) { if (!existsSync(path)) errors.push(`${path}: missing`); }
function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (["node_modules", ".git"].includes(entry)) continue;
    const st = lstatSync(path);
    // Skip symlinks: `.claude/skills/*` point back into `.agents/skills/*`, so following
    // them would walk the same real files twice.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walkFiles(path, predicate, out);
    else if (predicate(path)) out.push(path);
  }
  return out;
}
function ensureNoForbiddenNames(dir = root) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = path.slice(root.length + 1);
    if (["node_modules", ".git"].includes(entry)) continue;
    if (["auth.json", "trust.json"].includes(entry)) errors.push(`${rel}: forbidden live Pi state file`);
    if (/mcp-oauth|sessions|mcp-cache|mcp-npx-cache|pi-debug|pi-crash/.test(rel)) errors.push(`${rel}: forbidden runtime state`);
    const st = statSync(path);
    if (st.isDirectory()) ensureNoForbiddenNames(path);
  }
}
function expectedExtensionPath(name) {
  if (packageRootEntryExtensions.has(name)) return "./index.ts";
  if (directoryEntryExtensions.has(name)) return `./extensions/${name}/index.ts`;
  return `./extensions/${name}.ts`;
}
function verifyPackage(pkgDir, resourceType, expectedPath) {
  mustExist(join(pkgDir, "package.json"));
  mustExist(join(pkgDir, "README.md"));
  const pkg = readJson(join(pkgDir, "package.json"));
  if (!pkg) return;
  const relativePkgDir = pkgDir.slice(root.length + 1);
  if (!pkg.name || !pkg.version || pkg.type !== "module" || !pkg.description) errors.push(`${pkgDir}: package metadata incomplete`);
  if (!pkg.keywords?.includes("pi-package")) errors.push(`${pkgDir}: missing pi-package keyword`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) errors.push(`${pkgDir}: missing publish files`);
  if (pkg.repository?.directory !== relativePkgDir) errors.push(`${pkgDir}: repository.directory must be ${relativePkgDir}`);
  if (!pkg.homepage || !pkg.bugs?.url || pkg.publishConfig?.access !== "public") errors.push(`${pkgDir}: publish metadata incomplete`);
  if (Array.isArray(pkg.pi?.skills) && pkg.pi.skills.length > 0) errors.push(`${pkgDir}: package must not declare pi.skills`);
  const piPaths = pkg.pi?.[resourceType];
  if (!Array.isArray(piPaths) || !piPaths.includes(expectedPath)) errors.push(`${pkgDir}: missing pi.${resourceType} ${expectedPath}`);
  const publishRoot = expectedPath.replace(/^\.\//, "").split("/")[0];
  if (!pkg.files?.includes(publishRoot)) errors.push(`${pkgDir}: files must publish ${publishRoot}`);
  mustExist(join(pkgDir, expectedPath));
}

const extensionsDir = join(root, "packages", "extensions");
const actualExtensions = readdirSync(extensionsDir)
  .filter((entry) => statSync(join(extensionsDir, entry)).isDirectory())
  .sort();
if (JSON.stringify(actualExtensions) !== JSON.stringify([...expectedExtensions].sort())) {
  errors.push(`extension inventory mismatch: expected ${expectedExtensions.join(", ")}; found ${actualExtensions.join(", ")}`);
}

const rootPkg = readJson(join(root, "package.json"));
if (rootPkg) {
  for (const name of expectedExtensions) {
    const rootPath = `./packages/extensions/${name}/${expectedExtensionPath(name).slice(2)}`;
    if (!rootPkg.pi?.extensions?.includes(rootPath)) errors.push(`root package.json: missing pi.extensions ${rootPath}`);
  }
  for (const p of rootPkg.pi?.extensions ?? []) mustExist(join(root, p));
  for (const p of rootPkg.pi?.skills ?? []) mustExist(join(root, p));
  for (const p of rootPkg.pi?.themes ?? []) mustExist(join(root, p));
}

const installedSettings = readJson(join(root, "setup", "settings.example.json"));
const localSettings = readJson(join(root, "setup", "settings.local.example.json"));
if (installedSettings && localSettings) {
  errors.push(
    ...validateLocalSettings({
      installedPackages: installedSettings.packages ?? [],
      localPackages: localSettings.packages ?? [],
      expectedExtensions,
      expectedThemes,
    }),
  );
  for (const [label, settings] of [["installed", installedSettings], ["local", localSettings]]) {
    if (settings.defaultProvider !== "anthropic") errors.push(`setup ${label} settings: defaultProvider must be anthropic`);
    if (settings.defaultModel !== "claude-opus-5") errors.push(`setup ${label} settings: defaultModel must be claude-opus-5`);
    if (settings.defaultThinkingLevel !== "high") errors.push(`setup ${label} settings: defaultThinkingLevel must be high`);
    if (JSON.stringify(settings.enabledModels) !== JSON.stringify(expectedEnabledModels)) {
      errors.push(`setup ${label} settings: enabledModels must match the full profile`);
    }
  }
}
const setupModels = readJson(join(root, "setup", "models.example.json"));
if (setupModels && Object.keys(setupModels.providers ?? {}).length !== 0) {
  errors.push("setup/models.example.json: full profile must not use model-provider overrides");
}
const setupGoalController = readJson(join(root, "setup", "configs", "goal-controller.config.json"));
if (setupGoalController) {
  const checker = setupGoalController.checker;
  if (checker?.model !== "openai/gpt-5.6-luna") {
    errors.push("setup/configs/goal-controller.config.json: checker model must be openai/gpt-5.6-luna");
  }
  if (checker?.thinking !== "high") {
    errors.push("setup/configs/goal-controller.config.json: checker thinking must be high");
  }
  if (JSON.stringify(Object.keys(setupGoalController).sort()) !== JSON.stringify(["checker"])) {
    errors.push("setup/configs/goal-controller.config.json: setup override must contain only checker settings");
  }
  if (checker && JSON.stringify(Object.keys(checker).sort()) !== JSON.stringify(["model", "thinking"])) {
    errors.push("setup/configs/goal-controller.config.json: checker override must contain only model and thinking");
  }
}
// The full profile's operating boundaries live here rather than in models.json, so this is
// the one place they are stated: an exact id set (no stale aliases) with each window pair.
const expectedSetupAliases = new Map([
  ["gpt-5.6-sol", { contextWindow: 240000, targetContextWindow: 1050000 }],
  ["gpt-5.6-luna", { contextWindow: 272000, targetContextWindow: 1050000 }],
  ["claude-opus-5", { contextWindow: 350000, targetContextWindow: 1000000 }],
  ["claude-fable-5", { contextWindow: 350000, targetContextWindow: 1000000 }],
  ["claude-opus-5-full", { contextWindow: 1000000, targetContextWindow: 1000000 }],
  ["claude-fable-5-full", { contextWindow: 1000000, targetContextWindow: 1000000 }],
]);
const setupModelAliases = readJson(join(root, "setup", "configs", "model-aliases.json"));
if (setupModelAliases) {
  const aliases = new Map((setupModelAliases.aliases ?? []).map((alias) => [alias.id, alias]));
  const actualIds = [...aliases.keys()].sort().join(", ");
  const expectedIds = [...expectedSetupAliases.keys()].sort().join(", ");
  if (actualIds !== expectedIds) {
    errors.push(`setup/configs/model-aliases.json: full profile must define exactly [${expectedIds}], found [${actualIds}]`);
  }
  for (const [id, expected] of expectedSetupAliases) {
    const alias = aliases.get(id);
    if (!alias) continue;
    if (alias.contextWindow !== expected.contextWindow || alias.targetContextWindow !== expected.targetContextWindow) {
      errors.push(`setup/configs/model-aliases.json: ${id} must expose ${expected.contextWindow} and target ${expected.targetContextWindow}`);
    }
  }
}
for (const name of expectedExtensions) {
  verifyPackage(join(root, "packages", "extensions", name), "extensions", expectedExtensionPath(name));
}
if (existsSync(join(root, "packages", "skills"))) errors.push("packages/skills: global skills are intentionally excluded");
if (rootPkg?.pi?.skills && rootPkg.pi.skills.length > 0) errors.push("root package.json must not declare pi.skills");
for (const name of expectedThemes) verifyPackage(join(root, "packages", "themes", name), "themes", `./themes/${name}.json`);
const setupAgentsDir = join(root, "setup", "agents");
const actualSetupAgents = existsSync(setupAgentsDir)
  ? readdirSync(setupAgentsDir).filter((entry) => entry.endsWith(".md")).map((entry) => entry.slice(0, -3)).sort()
  : [];
if (JSON.stringify(actualSetupAgents) !== JSON.stringify([...expectedSetupAgents].sort())) {
  errors.push(`setup/agents inventory mismatch: expected ${expectedSetupAgents.join(", ")}; found ${actualSetupAgents.join(", ")}`);
}
for (const name of expectedSetupSkills) {
  mustExist(join(root, "setup", "skills", name, "SKILL.md"));
}

// The coding conventions were split out of setup/AGENTS.md, which now names the
// new file. Copy one without the other and the reference dangles silently — no
// install step fails, the rules are just gone. Checked here so it cannot.
const setupAgentsFile = join(root, "setup", "AGENTS.md");
const setupConventions = join(root, "setup", "CODING_CONVENTIONS.md");
mustExist(setupAgentsFile);
mustExist(setupConventions);
if (existsSync(setupAgentsFile) && !readFileSync(setupAgentsFile, "utf8").includes("CODING_CONVENTIONS.md")) {
  errors.push("setup/AGENTS.md: must reference CODING_CONVENTIONS.md by name — the conventions live there now");
}
if (existsSync(setupConventions) && !readFileSync(setupConventions, "utf8").startsWith("# Coding Conventions\n")) {
  errors.push("setup/CODING_CONVENTIONS.md: must open with '# Coding Conventions' — repo syncs anchor on that title");
}
const readme = readFileSync(join(root, "README.md"), "utf8");
const replicationSources = [
  "setup/README.md",
  "setup/settings.example.json",
  "setup/settings.local.example.json",
  "setup/configs/*.json",
  "setup/agents/*.md",
  "setup/skills/*",
  "setup/AGENTS.md",
  "setup/CODING_CONVENTIONS.md",
  "setup/auth.example.json",
  "setup/mcp.example.json",
  "setup/web-search.example.json",
  "setup/models.example.json",
];
const replicationSection = readme.match(/## Replicate this setup with an agent\n([\s\S]*?)(?=\n## |$)/)?.[1] ?? "";
if (!replicationSection) errors.push("README.md: missing agent replication runbook");
if (!replicationSection.includes("Guide the user through full vs. partial sync")) errors.push("README.md: replication runbook must guide full vs. partial customization");
if (!replicationSection.includes("full portable sync (default)")) errors.push("README.md: replication runbook must default to full portable sync");
if (!replicationSection.includes("individual items in that category")) errors.push("README.md: partial sync must support individual resource selection");
for (const source of replicationSources) {
  if (!replicationSection.includes(source)) errors.push(`README.md: replication runbook missing ${source}`);
}
const agentsSection = readme.match(/### Agents\n\n([\s\S]*?)(?=\n### |\n## |$)/)?.[1] ?? "";
for (const name of expectedSetupAgents) {
  const path = join(setupAgentsDir, `${name}.md`);
  mustExist(path);
  if (!agentsSection.includes(`- \`${name}\``)) errors.push(`README.md: Agents section missing ${name}`);
  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    if (!content.includes("tools: read, bash, grep, find, ls")) errors.push(`${path}: setup agent must stay read-only`);
    if (!content.includes("model: openai/gpt-5.6-luna")) errors.push(`${path}: unexpected model override`);
    if (!content.includes("thinking: medium")) errors.push(`${path}: expected medium thinking level`);
    if (!content.includes("prompt_mode: replace")) errors.push(`${path}: expected replace prompt mode`);
  }
}

for (const path of walkFiles(join(root, "packages"), (p) => p.endsWith(".json"))) readJson(path);
for (const path of walkFiles(join(root, "setup"), (p) => p.endsWith(".json"))) readJson(path);
for (const name of expectedSkills) {
  mustExist(join(root, ".agents", "skills", name, "SKILL.md"));
  const claudeSkillPath = join(root, ".claude", "skills", name);
  mustExist(claudeSkillPath);
  if (existsSync(claudeSkillPath)) {
    const st = lstatSync(claudeSkillPath);
    if (!st.isSymbolicLink()) errors.push(`${claudeSkillPath}: expected symlink to .agents/skills/${name}`);
    else if (readlinkSync(claudeSkillPath) !== `../../.agents/skills/${name}`) errors.push(`${claudeSkillPath}: symlink target must be ../../.agents/skills/${name}`);
  }
}
/**
 * Cross-package record-type contracts. Each extension declares these literals itself
 * rather than importing them, so every package stays individually installable — which
 * also means a rename on one side would silently stop cost accounting with every
 * package's own tests still green. This is the check that would catch it.
 *
 * A missing file is not an error: producers are optional by design, and the reader must
 * work with any subset of them installed. Only a present file that no longer declares
 * its side of the contract is a failure.
 */
const recordTypeContracts = [
  {
    literal: "pi-cost-record",
    // Optional producers: the reader must not require any of them to be installed.
    writers: [
      "packages/extensions/cache-optimization/extensions/cache-optimization.ts",
      "packages/extensions/openai-tts/extensions/openai-tts/index.ts",
    ],
    readers: ["packages/extensions/simple-statusline/extensions/simple-statusline/session-cost.ts"],
  },
  {
    literal: "pi-price-tier",
    writers: ["packages/extensions/gpt-fast-toggle/extensions/gpt-fast-toggle.ts"],
    readers: ["packages/extensions/simple-statusline/extensions/simple-statusline/session-cost.ts"],
  },
];
for (const contract of recordTypeContracts) {
  for (const [role, paths] of [["writer", contract.writers], ["reader", contract.readers]]) {
    for (const relative of paths) {
      const path = join(root, relative);
      if (!existsSync(path)) continue;
      if (!readFileSync(path, "utf8").includes(`"${contract.literal}"`)) {
        errors.push(`${relative}: ${role} no longer declares record type "${contract.literal}" — cost accounting would silently stop`);
      }
    }
  }
}

// Employer-specific material belongs in the local install, never in this repo. This is
// published, and a term naming a workplace cannot be unpublished once pushed. A scan is
// what keeps it out; the rule "don't commit work material" already let a stale test
// fixture and a bot-specific PR rule through. This file is exempt because it has to
// contain the terms to look for them.
const employerTerms = ["lemonade", "lmnd", "lmcp", "cxllm", "devctx", "fibery", "arnica"];
const employerScanExempt = new Set([join(root, "scripts", "verify-structure.mjs")]);
for (const path of walkFiles(
  root,
  (p) => /\.(md|json|mjs|js|ts|tsx|yml|yaml|txt|html|py|sh)$/.test(p) && !employerScanExempt.has(p),
)) {
  const lines = readFileSync(path, "utf8").split("\n");
  for (const term of employerTerms) {
    const index = lines.findIndex((line) => line.toLowerCase().includes(term));
    if (index === -1) continue;
    errors.push(
      `${path.slice(root.length + 1)}:${index + 1}: employer-specific term "${term}" — keep workplace material in the local install, not in this repo`,
    );
  }
}

ensureNoForbiddenNames();

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`structure ok: ${expectedExtensions.length} extensions, ${expectedSkills.length} project skill, ${expectedThemes.length} theme, ${expectedSetupAgents.length} setup agent, ${expectedSetupSkills.length} setup skill`);
