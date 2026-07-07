import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKER_MODEL_BOOTSTRAP_KIND,
  CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION,
  CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE,
  DEFAULT_TRUSTED_CHECKER_MODEL_BOOTSTRAP_PACKAGES,
  checkerModelBootstrapRegistration,
  trustedCheckerModelBootstrapPath,
} from "./checker-model-bootstrap.ts";

const ABSOLUTE_BOOTSTRAP = "/tmp/packages/extensions/model-aliases/extensions/model-aliases/checker-bootstrap.ts";

function validRegistration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: CHECKER_MODEL_BOOTSTRAP_PROTOCOL_VERSION,
    kind: CHECKER_MODEL_BOOTSTRAP_KIND,
    toolSurface: CHECKER_MODEL_BOOTSTRAP_TOOL_SURFACE,
    packageName: "@doodledood/pi-model-aliases",
    extensionPath: ABSOLUTE_BOOTSTRAP,
    ...overrides,
  };
}

test("checkerModelBootstrapRegistration accepts a well-formed absolute registration", () => {
  const parsed = checkerModelBootstrapRegistration(validRegistration());
  assert.equal(parsed?.packageName, "@doodledood/pi-model-aliases");
  assert.equal(parsed?.extensionPath, ABSOLUTE_BOOTSTRAP);
});

test("checkerModelBootstrapRegistration rejects a relative extensionPath even with a trusted suffix", () => {
  const relative = checkerModelBootstrapRegistration(
    validRegistration({ extensionPath: "extensions/model-aliases/checker-bootstrap.ts" }),
  );
  assert.equal(relative, undefined);
});

test("checkerModelBootstrapRegistration rejects malformed protocol/kind/tool-surface payloads", () => {
  assert.equal(checkerModelBootstrapRegistration(validRegistration({ protocolVersion: 2 })), undefined);
  assert.equal(checkerModelBootstrapRegistration(validRegistration({ kind: "tool-bootstrap" })), undefined);
  assert.equal(checkerModelBootstrapRegistration(validRegistration({ toolSurface: "read" })), undefined);
  assert.equal(checkerModelBootstrapRegistration(validRegistration({ packageName: "  " })), undefined);
  assert.equal(checkerModelBootstrapRegistration({ notEvenClose: true }), undefined);
});

test("trustedCheckerModelBootstrapPath honors trusted package plus suffix and rejects impostors", () => {
  const trusted = checkerModelBootstrapRegistration(validRegistration());
  assert.ok(trusted);
  assert.equal(
    trustedCheckerModelBootstrapPath(trusted, DEFAULT_TRUSTED_CHECKER_MODEL_BOOTSTRAP_PACKAGES),
    ABSOLUTE_BOOTSTRAP,
  );

  const wrongSuffix = checkerModelBootstrapRegistration(validRegistration({ extensionPath: "/tmp/evil/index.ts" }));
  assert.ok(wrongSuffix);
  assert.equal(trustedCheckerModelBootstrapPath(wrongSuffix, DEFAULT_TRUSTED_CHECKER_MODEL_BOOTSTRAP_PACKAGES), undefined);

  const untrustedPackage = checkerModelBootstrapRegistration(validRegistration({ packageName: "@someone/other" }));
  assert.ok(untrustedPackage);
  assert.equal(
    trustedCheckerModelBootstrapPath(untrustedPackage, DEFAULT_TRUSTED_CHECKER_MODEL_BOOTSTRAP_PACKAGES),
    undefined,
  );
});

test("trustedCheckerModelBootstrapPath trusts any absolute path for a suffix-less trusted package", () => {
  // A trusted package configured without extensionPathSuffixes opts out of suffix
  // restriction and may advertise any absolute bootstrap path (documented shape).
  const registration = checkerModelBootstrapRegistration(
    validRegistration({ packageName: "@foo/bar", extensionPath: "/abs/anywhere/bootstrap.ts" }),
  );
  assert.ok(registration);
  assert.equal(
    trustedCheckerModelBootstrapPath(registration, [{ packageName: "@foo/bar" }]),
    "/abs/anywhere/bootstrap.ts",
  );
  assert.equal(
    trustedCheckerModelBootstrapPath(registration, [{ packageName: "@foo/bar", extensionPathSuffixes: [] }]),
    "/abs/anywhere/bootstrap.ts",
  );
});
