export function validateLocalSettings({
  installedPackages,
  localPackages,
  expectedExtensions,
  expectedThemes,
  rootBundleSource = "git:github.com/doodledood/pi-plugins@main",
  localRoot = "/ABSOLUTE/PATH/TO/pi-plugins/packages",
}) {
  const errors = [];
  for (const source of installedPackages) {
    if (source !== rootBundleSource && !localPackages.includes(source)) {
      errors.push(`setup/settings.local.example.json: missing portable package ${source}`);
    }
  }
  if (localPackages.includes(rootBundleSource)) {
    errors.push("setup/settings.local.example.json: local profile must replace the upstream pi-plugins bundle");
  }
  for (const name of expectedExtensions) {
    const source = `${localRoot}/extensions/${name}`;
    if (!localPackages.includes(source)) errors.push(`setup/settings.local.example.json: missing local extension ${name}`);
  }
  for (const name of expectedThemes) {
    const source = `${localRoot}/themes/${name}`;
    if (!localPackages.includes(source)) errors.push(`setup/settings.local.example.json: missing local theme ${name}`);
  }
  return errors;
}

// Holds part of docs/adr/20260820-split-coding-conventions-from-setup-agents.md: the root AGENTS.md
// embeds setup/CODING_CONVENTIONS.md as its "## Coding Conventions" section, every heading demoted
// one level. embedConventions is the one transform; the structure check and
// scripts/embed-conventions.mjs both go through it, so the check and the fix cannot disagree.
const conventionsMarker = "## Coding Conventions\n";
export const embedConventionsCommand = "node scripts/embed-conventions.mjs";

/**
 * Returns agentsText with its "## Coding Conventions" section (up to the next "## " heading, or
 * the end of the file) replaced by conventionsText with every heading demoted one level. Every
 * byte outside the section is kept. Throws when agentsText has no such section, so a missing
 * section is never silently appended.
 */
export function embedConventions({ agentsText, conventionsText }) {
  const start = agentsText.indexOf(conventionsMarker);
  if (start === -1) throw new Error("AGENTS.md: missing '## Coding Conventions' section");
  const afterMarker = start + conventionsMarker.length;
  const next = agentsText.slice(afterMarker).search(/^## /m);
  const end = next === -1 ? agentsText.length : afterMarker + next;
  const demoted = conventionsText.replace(/^(#+ )/gm, "#$1").trimEnd();
  // Keep the section's own separation from what follows it: a blank line before a later
  // section, a single newline at the end of the file.
  const tail = next === -1 ? "\n" : "\n\n";
  return agentsText.slice(0, start) + demoted + tail + agentsText.slice(end);
}

/** Returns an error naming the fix when the embedded section differs from conventionsText. */
export function validateEmbeddedConventions({ agentsText, conventionsText }) {
  if (!agentsText.includes(conventionsMarker)) return ["AGENTS.md: missing '## Coding Conventions' section"];
  if (embedConventions({ agentsText, conventionsText }) !== agentsText) {
    return [`AGENTS.md: '## Coding Conventions' section must match setup/CODING_CONVENTIONS.md (headings demoted one level); run \`${embedConventionsCommand}\` to regenerate it`];
  }
  return [];
}

/**
 * Whether a file or directory name is live Pi runtime state: the session log directory, MCP auth and caches, debug
 * and crash logs. Matched on the whole name, so a document whose name merely mentions sessions is not caught.
 */
export function isRuntimeStateName(name) {
  return name === "sessions" || /^(mcp-oauth|mcp-cache|mcp-npx-cache|pi-debug|pi-crash)/.test(name);
}
