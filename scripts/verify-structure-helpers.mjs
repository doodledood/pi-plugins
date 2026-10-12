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

/**
 * The root AGENTS.md embeds setup/CODING_CONVENTIONS.md as its "## Coding Conventions"
 * section, with every heading demoted one level. Returns an error when the two differ.
 */
export function validateEmbeddedConventions({ agentsText, conventionsText }) {
  const marker = "## Coding Conventions\n";
  const start = agentsText.indexOf(marker);
  if (start === -1) return ["AGENTS.md: missing '## Coding Conventions' section"];
  const rest = agentsText.slice(start);
  const next = rest.slice(marker.length).search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, marker.length + next);
  const expected = conventionsText.replace(/^(#+ )/gm, "#$1");
  if (section.trimEnd() !== expected.trimEnd()) {
    return ["AGENTS.md: '## Coding Conventions' section must match setup/CODING_CONVENTIONS.md (headings demoted one level)"];
  }
  return [];
}
