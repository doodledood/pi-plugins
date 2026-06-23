import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const errors = [];
const expectedExtensions = ["goal-controller", "mcp-tool-loadout", "context-breakdown", "gpt-fast-toggle", "managed-chrome-devtools", "message-stash", "simple-statusline", "skill-argument-hints", "tool-activity-renderer"];
const expectedSkills = [];
const expectedThemes = ["deep-focus-pi"];

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { errors.push(`${path}: invalid JSON (${error.message})`); return undefined; }
}
function mustExist(path) { if (!existsSync(path)) errors.push(`${path}: missing`); }
function ensureNoForbiddenNames(dir = root) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const rel = path.slice(root.length + 1);
    if (["node_modules", ".git"].includes(entry)) continue;
    if (/self-compact/i.test(rel)) errors.push(`${rel}: self-compact is intentionally excluded`);
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
  const path = name === "goal-controller" || name === "mcp-tool-loadout" ? `./extensions/${name}/index.ts` : `./extensions/${name}.ts`;
  verifyPackage(join(root, "packages", "extensions", name), "extensions", path);
}
if (existsSync(join(root, "packages", "skills"))) errors.push("packages/skills: global skills are intentionally excluded");
if (rootPkg?.pi?.skills && rootPkg.pi.skills.length > 0) errors.push("root package.json must not declare pi.skills");
for (const name of expectedThemes) verifyPackage(join(root, "packages", "themes", name), "themes", `./themes/${name}.json`);

for (const path of ["profiles/aviram/settings.local.example.json", "profiles/aviram/settings.npm.example.json", "profiles/aviram/mcp.example.json", "profiles/aviram/models.example.json", "packages/themes/deep-focus-pi/themes/deep-focus-pi.json"]) readJson(join(root, path));
ensureNoForbiddenNames();

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`structure ok: ${expectedExtensions.length} extensions, no skills, ${expectedThemes.length} theme`);
