import assert from "node:assert/strict";
import test from "node:test";
import { planReleaseActions } from "./release-plan.mjs";

test("current verified commit can publish a missing tag and release", () => {
  assert.deepEqual(
    planReleaseActions({ isCurrentCommit: true, tagExists: false, releaseExists: false }),
    { verifyCandidate: false, createTag: true, createRelease: true },
  );
});

test("historical missing tag requires candidate verification", () => {
  assert.deepEqual(
    planReleaseActions({ isCurrentCommit: false, tagExists: false, releaseExists: false }),
    { verifyCandidate: true, createTag: true, createRelease: true },
  );
});

test("existing tag with missing release repairs only the release", () => {
  assert.deepEqual(
    planReleaseActions({ isCurrentCommit: false, tagExists: true, releaseExists: false }),
    { verifyCandidate: false, createTag: false, createRelease: true },
  );
});

test("fully published version requires no action", () => {
  assert.deepEqual(
    planReleaseActions({ isCurrentCommit: false, tagExists: true, releaseExists: true }),
    { verifyCandidate: false, createTag: false, createRelease: false },
  );
});
