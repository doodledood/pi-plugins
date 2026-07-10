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
