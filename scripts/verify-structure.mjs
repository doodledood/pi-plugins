import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { validateLocalSettings } from "./verify-structure-helpers.mjs";

const root = process.cwd();
const errors = [];
const expectedExtensions = ["advisor-consult", "btw", "cache-optimization", "goal-controller", "mcp-tool-loadout", "context-breakdown", "gpt-fast-toggle", "managed-chrome-devtools", "model-aliases", "message-stash", "openai-max-output-floor", "openai-tts", "panel", "simple-statusline", "skill-argument-hints", "tool-activity-renderer"];
const directoryEntryExtensions = new Set(["advisor-consult", "btw", "goal-controller", "mcp-tool-loadout", "model-aliases", "openai-tts", "panel"]);
const packageRootEntryExtensions = new Set(["btw"]);
const expectedSkills = ["sync-pi-setup"];
const expectedThemes = ["deep-focus-pi"];
const expectedSetupAgents = ["Explore"];
const expectedSetupSkills = ["deletion-pass"];
const expectedEnabledModels = [
  "anthropic/claude-fable-5:medium",
  "openai/gpt-5.6-sol:xhigh",
  "openai/gpt-5.6-luna:max",
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
    const st = statSync(path);
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
    if (settings.defaultModel !== "claude-fable-5") errors.push(`setup ${label} settings: defaultModel must be claude-fable-5`);
    if (settings.defaultThinkingLevel !== "medium") errors.push(`setup ${label} settings: defaultThinkingLevel must be medium`);
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
  if (checker?.model !== "openai/gpt-5.6-sol") {
    errors.push("setup/configs/goal-controller.config.json: checker model must be openai/gpt-5.6-sol");
  }
  if (checker?.thinking !== "xhigh") {
    errors.push("setup/configs/goal-controller.config.json: checker thinking must be xhigh");
  }
  if (JSON.stringify(Object.keys(setupGoalController).sort()) !== JSON.stringify(["checker"])) {
    errors.push("setup/configs/goal-controller.config.json: setup override must contain only checker settings");
  }
  if (checker && JSON.stringify(Object.keys(checker).sort()) !== JSON.stringify(["model", "thinking"])) {
    errors.push("setup/configs/goal-controller.config.json: checker override must contain only model and thinking");
  }
}
const setupModelAliases = readJson(join(root, "setup", "configs", "model-aliases.json"));
if (setupModelAliases) {
  const aliases = new Map((setupModelAliases.aliases ?? []).map((alias) => [alias.id, alias]));
  const regularSol = aliases.get("gpt-5.6-sol");
  const luna = aliases.get("gpt-5.6-luna");
  if (aliases.size !== 2) {
    errors.push("setup/configs/model-aliases.json: full profile must define only Sol and Luna aliases");
  }
  if (regularSol?.contextWindow !== 372000 || regularSol?.targetContextWindow !== 1050000) {
    errors.push("setup/configs/model-aliases.json: regular Sol must expose 372K and target 1.05M");
  }
  if (luna?.contextWindow !== 1050000 || luna?.targetContextWindow !== 1050000) {
    errors.push("setup/configs/model-aliases.json: Luna must expose and target 1.05M");
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
const readme = readFileSync(join(root, "README.md"), "utf8");
const replicationSources = [
  "setup/README.md",
  "setup/settings.example.json",
  "setup/settings.local.example.json",
  "setup/configs/*.json",
  "setup/agents/*.md",
  "setup/skills/*",
  "setup/AGENTS.md",
  "setup/APPEND_SYSTEM.md",
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
ensureNoForbiddenNames();

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`structure ok: ${expectedExtensions.length} extensions, ${expectedSkills.length} project skill, ${expectedThemes.length} theme, ${expectedSetupAgents.length} setup agent, ${expectedSetupSkills.length} setup skill`);
