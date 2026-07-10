import assert from "node:assert/strict";
import test from "node:test";
import { validateLocalSettings } from "./verify-structure-helpers.mjs";

const rootBundleSource = "git:github.com/doodledood/pi-plugins@main";
const portablePackage = "git:github.com/doodledood/manifest-dev@main";
const localExtension = "/ABSOLUTE/PATH/TO/pi-plugins/packages/extensions/advisor-consult";
const localTheme = "/ABSOLUTE/PATH/TO/pi-plugins/packages/themes/deep-focus-pi";

function validate(localPackages) {
  return validateLocalSettings({
    installedPackages: [portablePackage, rootBundleSource],
    localPackages,
    expectedExtensions: ["advisor-consult"],
    expectedThemes: ["deep-focus-pi"],
  });
}

test("local settings preserve portable helpers and replace the root bundle with local resources", () => {
  assert.deepEqual(validate([portablePackage, localExtension, localTheme]), []);
});

test("local settings report a missing portable helper", () => {
  assert.deepEqual(validate([localExtension, localTheme]), [
    `setup/settings.local.example.json: missing portable package ${portablePackage}`,
  ]);
});

test("local settings reject retaining the upstream root bundle", () => {
  assert.deepEqual(validate([portablePackage, rootBundleSource, localExtension, localTheme]), [
    "setup/settings.local.example.json: local profile must replace the upstream pi-plugins bundle",
  ]);
});

test("local settings report missing local extension and theme packages", () => {
  assert.deepEqual(validate([portablePackage]), [
    "setup/settings.local.example.json: missing local extension advisor-consult",
    "setup/settings.local.example.json: missing local theme deep-focus-pi",
  ]);
});
