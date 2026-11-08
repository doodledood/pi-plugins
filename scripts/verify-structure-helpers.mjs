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

// Holds docs/adr/20261108-embed-the-coding-conventions-in-the-root-agents-md.md: the root AGENTS.md
// embeds setup/CODING_CONVENTIONS.md as its "## Coding Conventions" section, every heading demoted
// one level. embedConventions is the one transform; the structure check and
// scripts/embed-conventions.mjs both go through it, so the check and the fix cannot disagree.
const conventionsHeading = "## Coding Conventions";
const embedConventionsCommand = "node scripts/embed-conventions.mjs";

/**
 * For each line, whether it belongs to a fenced code block (its fences included), so a "# " line
 * inside a fence is never read as a heading.
 */
function fencedLines(lines) {
  let open = null;
  return lines.map((line) => {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (open) {
      if (fence && fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) open = null;
      return true;
    }
    if (fence) open = fence;
    return Boolean(fence);
  });
}

/**
 * Returns agentsText with its "## Coding Conventions" section (up to the next "## " heading, or
 * the end of the file) replaced by conventionsText with every heading demoted one level. Headings
 * are lines that start with "#" outside fenced code blocks. Every byte outside the section is
 * kept. Throws when agentsText has no such section, so a missing section is never silently
 * appended.
 */
export function embedConventions({ agentsText, conventionsText }) {
  const lines = agentsText.split("\n");
  const fenced = fencedLines(lines);
  const start = lines.findIndex((line, i) => !fenced[i] && line === conventionsHeading);
  if (start === -1) throw new Error(`AGENTS.md: missing '${conventionsHeading}' section`);
  const end = lines.findIndex((line, i) => i > start && !fenced[i] && line.startsWith("## "));
  const conventionsLines = conventionsText.split("\n");
  const conventionsFenced = fencedLines(conventionsLines);
  const demoted = conventionsLines
    .map((line, i) => (!conventionsFenced[i] && /^#+ /.test(line) ? `#${line}` : line))
    .join("\n")
    .trimEnd();
  const before = start === 0 ? "" : `${lines.slice(0, start).join("\n")}\n`;
  // Keep the section's own separation from what follows it: a blank line before a later
  // section, a single newline at the end of the file.
  const after = end === -1 ? "\n" : `\n\n${lines.slice(end).join("\n")}`;
  return before + demoted + after;
}

/** Returns an error naming the fix when the embedded section differs from conventionsText. */
export function validateEmbeddedConventions({ agentsText, conventionsText }) {
  let embedded;
  try {
    embedded = embedConventions({ agentsText, conventionsText });
  } catch (error) {
    return [error.message];
  }
  if (embedded !== agentsText) {
    return [`AGENTS.md: '${conventionsHeading}' section must match setup/CODING_CONVENTIONS.md (headings demoted one level); run \`${embedConventionsCommand}\` to regenerate it`];
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
