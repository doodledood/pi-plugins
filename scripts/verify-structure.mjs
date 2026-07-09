import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const errors = [];
const expectedExtensions = ["advisor-consult", "cache-optimization", "goal-controller", "mcp-tool-loadout", "context-breakdown", "gpt-fast-toggle", "managed-chrome-devtools", "model-aliases", "message-stash", "openai-max-output-floor", "openai-tts", "simple-statusline", "skill-argument-hints", "tool-activity-renderer"];
const expectedSkills = ["sync-pi-setup"];
const expectedThemes = ["deep-focus-pi"];

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
function verifyPackage(pkgDir, resourceType, expectedPath) {
  mustExist(join(pkgDir, "package.json"));
  mustExist(join(pkgDir, "README.md"));
  const pkg = readJson(join(pkgDir, "package.json"));
  if (!pkg) return;
  if (!pkg.name || !pkg.version || pkg.type !== "module") errors.push(`${pkgDir}: package metadata incomplete`);
  if (!pkg.keywords?.includes("pi-package")) errors.push(`${pkgDir}: missing pi-package keyword`);
  if (Array.isArray(pkg.pi?.skills) && pkg.pi.skills.length > 0) errors.push(`${pkgDir}: package must not declare pi.skills`);
  const piPaths = pkg.pi?.[resourceType];
  if (!Array.isArray(piPaths) || !piPaths.includes(expectedPath)) errors.push(`${pkgDir}: missing pi.${resourceType} ${expectedPath}`);
  mustExist(join(pkgDir, expectedPath));
}

const rootPkg = readJson(join(root, "package.json"));
if (rootPkg) {
  for (const p of rootPkg.pi?.extensions ?? []) mustExist(join(root, p));
  for (const p of rootPkg.pi?.skills ?? []) mustExist(join(root, p));
  for (const p of rootPkg.pi?.themes ?? []) mustExist(join(root, p));
}
for (const name of expectedExtensions) {
  const path = ["advisor-consult", "goal-controller", "mcp-tool-loadout", "model-aliases", "openai-tts"].includes(name) ? `./extensions/${name}/index.ts` : `./extensions/${name}.ts`;
  verifyPackage(join(root, "packages", "extensions", name), "extensions", path);
}
if (existsSync(join(root, "packages", "skills"))) errors.push("packages/skills: global skills are intentionally excluded");
if (rootPkg?.pi?.skills && rootPkg.pi.skills.length > 0) errors.push("root package.json must not declare pi.skills");
for (const name of expectedThemes) verifyPackage(join(root, "packages", "themes", name), "themes", `./themes/${name}.json`);

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
console.log(`structure ok: ${expectedExtensions.length} extensions, ${expectedSkills.length} project skill, ${expectedThemes.length} theme`);
